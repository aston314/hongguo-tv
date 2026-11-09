#!/usr/bin/env python3
"""Benchmark CI-built tools on local decrypted samples; never resolve/upload media.

All binaries must come from the two native Actions artifacts. The output folder
contains private converted media/logs and must stay outside the repository.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shlex
import struct
import subprocess
import time

p = argparse.ArgumentParser(description=__doc__)
p.add_argument("--serial", required=True)
p.add_argument("--reference", type=Path, required=True)
p.add_argument("--optimized", type=Path, required=True)
p.add_argument("--samples", type=Path, nargs="+", required=True)
p.add_argument("--out", type=Path, required=True)
p.add_argument("--mode", choices=("full", "stream"), required=True)
a = p.parse_args()
a.out.mkdir(parents=True, exist_ok=True)
remote = "/data/local/tmp/hongguo-bvc2-transcode"


def adb(*args, **kwargs):
    return subprocess.run(["adb", "-s", a.serial, *args], capture_output=True,
                          text=True, timeout=270, check=True, **kwargs)


def shell(*args):
    return adb("shell", shlex.join(args)).stdout


shell("mkdir", "-p", remote)
if "arm64-v8a" not in shell("getprop", "ro.product.cpu.abilist"):
    raise RuntimeError("Requires arm64 device")
report = {"mode": a.mode, "scope": "standalone conversion; full source already downloaded/decrypted; no application playback",
          "model": shell("getprop", "ro.product.model").strip(), "runs": []}
for variant, artifact in (("reference", a.reference), ("optimized", a.optimized)):
    for line in (artifact / "SHA256SUMS.txt").read_text().splitlines():
        digest, name = line.split(maxsplit=1)
        assert hashlib.sha256((artifact / name).read_bytes()).hexdigest() == digest, name
    shell("mkdir", "-p", remote + "/" + variant)
    for tool in ("ffmpeg", "ffprobe"):
        adb("push", str(artifact / "bin" / tool), remote + "/" + variant + "/" + tool)
        shell("chmod", "755", remote + "/" + variant + "/" + tool)
    for index, sample in enumerate(a.samples):
        name = variant + "-sample" + str(index)
        source = remote + "/sample" + str(index) + ".mp4"
        destination = remote + "/" + name + ".mp4"
        progress = remote + "/" + name + "-progress.txt"
        log = remote + "/" + name + ".log"
        adb("push", str(sample), source)
        args = ["timeout", "240", remote + "/" + variant + "/ffmpeg", "-hide_banner",
                "-loglevel", "info", "-benchmark", "-nostdin", "-i", source,
                "-map", "0:v:0", "-map", "0:a:0?", "-c:v", "libx264", "-preset", "ultrafast",
                "-crf", "25", "-pix_fmt", "yuv420p"]
        if a.mode == "stream":
            args += ["-g", "30"]
        args += ["-c:a", "aac", "-nostats", "-progress", progress]
        args += (["-movflags", "+faststart", "-y", destination] if a.mode == "full" else
                 ["-movflags", "frag_keyframe+empty_moov+default_base_moof", "-f", "mp4", "pipe:1"])
        entry = {"variant": variant, "sample": sample.name,
                 "input_sha256": hashlib.sha256(sample.read_bytes()).hexdigest(), "boxes": []}
        started = time.monotonic()
        if a.mode == "full":
            result = subprocess.run(["adb", "-s", a.serial, "shell", shlex.join(args)],
                                    capture_output=True, text=True, timeout=270)
            entry["exit_code"] = result.returncode
            (a.out / (name + ".log")).write_text(result.stderr)
            entry["wall_seconds"] = round(time.monotonic() - started, 3)
            if result.returncode == 0:
                probe = shell(remote + "/" + variant + "/ffprobe", "-v", "error", "-count_packets",
                              "-show_entries", "stream=codec_name,width,height,avg_frame_rate,duration,nb_read_packets:format=size,duration", "-of", "json", destination)
                entry["probe"] = json.loads(probe)
                adb("pull", destination, str(a.out / (name + ".mp4")))
        else:
            command = shlex.join(args) + " 2>" + shlex.quote(log)
            proc = subprocess.Popen(["adb", "-s", a.serial, "exec-out", command],
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            pending = bytearray()
            entry["bytes"] = 0
            with (a.out / (name + ".mp4")).open("wb") as file:
                while True:
                    chunk = proc.stdout.read1(65536)
                    if not chunk:
                        break
                    entry.setdefault("first_bytes_seconds", round(time.monotonic() - started, 3))
                    file.write(chunk)
                    entry["bytes"] += len(chunk)
                    pending.extend(chunk)
                    while len(pending) >= 8:
                        size = struct.unpack(">I", pending[:4])[0]
                        if size == 1:
                            if len(pending) < 16:
                                break
                            size = struct.unpack(">Q", pending[8:16])[0]
                        if size == 0 or len(pending) < size:
                            break
                        kind = bytes(pending[4:8]).decode("ascii", errors="replace")
                        at = round(time.monotonic() - started, 3)
                        entry["boxes"].append({"type": kind, "bytes": size, "received_seconds": at})
                        if kind == "mdat":
                            entry.setdefault("first_mdat_complete_seconds", at)
                        del pending[:size]
            entry["exit_code"] = proc.wait(timeout=5)
            entry["wall_seconds"] = round(time.monotonic() - started, 3)
            adb("pull", log, str(a.out / (name + ".log")))
        adb("pull", progress, str(a.out / (name + "-progress.txt")))
        entry["progress"] = dict(re.findall(r"(?m)^(frame|out_time_us|speed)=(.*)$", (a.out / (name + "-progress.txt")).read_text()))
        report["runs"].append(entry)
        (a.out / "report.json").write_text(json.dumps(report, indent=2))
        print(json.dumps({k: v for k, v in entry.items() if k != "boxes"}), flush=True)
