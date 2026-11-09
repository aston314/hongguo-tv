#!/usr/bin/env python3
"""Run CI-built, standalone tools on Android without installing an APK.

Inputs must be local, already-decrypted samples. Never pass a source URL/key to
adb or write one to reports. Nothing in this tool changes app configuration.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shlex
import subprocess
import time


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifact", type=Path, required=True)
    parser.add_argument("--samples", type=Path, nargs="+", required=True)
    parser.add_argument("--serial", required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    remote = "/data/local/tmp/hongguo-bytevc2-experiment"

    def adb(*values, timeout=180):
        return subprocess.run(["adb", "-s", args.serial, *values],
                              capture_output=True, text=True, timeout=timeout)

    def shell(*values, timeout=180):
        return adb("shell", shlex.join(values), timeout=timeout)

    def require(result):
        if result.returncode:
            raise RuntimeError(result.stderr[-1000:] or result.stdout[-1000:])
        return result.stdout

    abi = require(shell("getprop", "ro.product.cpu.abilist")).strip()
    if "arm64-v8a" not in abi:
        raise RuntimeError("This experiment binary requires arm64-v8a")
    require(shell("mkdir", "-p", remote))
    # Verify all downloaded artifact files before executing its binaries.
    for line in (args.artifact / "SHA256SUMS.txt").read_text().splitlines():
        digest, filename = line.split(maxsplit=1)
        file = args.artifact / filename.lstrip("*")
        if hashlib.sha256(file.read_bytes()).hexdigest() != digest:
            raise RuntimeError(f"Artifact checksum mismatch: {file.name}")
    for tool in ("ffmpeg", "ffprobe"):
        require(adb("push", str(args.artifact / "bin" / tool), remote + "/" + tool))
        require(shell("chmod", "755", remote + "/" + tool))
    decoder_list = require(shell(remote + "/ffmpeg", "-hide_banner", "-decoders"))
    if not re.search(r"\bbvc2\b", decoder_list):
        raise RuntimeError("bvc2 decoder not registered at runtime")
    report = {
        "scope": "standalone decoder, no GPU/audio or app integration",
        "abi": abi, "build": (args.artifact / "BUILD.txt").read_text(),
        "samples": [],
    }
    (args.out / "decoders.txt").write_text(decoder_list)
    for index, file in enumerate(args.samples):
        name = f"sample-{index}"
        sample = remote + "/" + name + ".mp4"
        require(adb("push", str(file), sample))
        data = file.read_bytes()
        entry = {
            "sample": file.name, "bytes": len(data),
            "sha256": hashlib.sha256(data).hexdigest(),
            "has_bv2C": b"bv2C" in data[:262144], "runs": [],
        }
        report["samples"].append(entry)
        # Preserve auto-detection failure as evidence. Explicit bvc2 below is
        # allowed only because the sample's upstream codec is already known.
        for mode, codec in (("auto", []), ("explicit-bvc2", ["-c:v", "bvc2"])):
            for offset in (0, 15):
                logname = f"{name}-{mode}-seek{offset}"
                command = [remote + "/ffmpeg", "-hide_banner", "-nostdin",
                           "-loglevel", "info", "-xerror", "-benchmark",
                           "-threads", "0", *codec]
                if offset:
                    command += ["-ss", str(offset)]
                command += ["-i", sample, "-map", "0:v:0", "-an", "-sn", "-dn",
                            "-t", "10", "-nostats", "-progress", "pipe:1",
                            "-f", "null", "-"]
                start = time.monotonic()
                try:
                    result = shell(*command, timeout=120)
                    elapsed = time.monotonic() - start
                    metrics = dict(re.findall(r"(?m)^(frame|out_time_us|speed)=(.*)$", result.stdout))
                    frames = int(metrics.get("frame", "0"))
                    media_seconds = int(metrics.get("out_time_us", "0")) / 1e6
                    rss = re.search(r"maxrss=(\d+)KiB", result.stderr)
                    run = {
                        "mode": mode, "seek_seconds": offset,
                        "exit_code": result.returncode, "wall_seconds": round(elapsed, 3),
                        "decoded_frames": frames, "media_seconds": media_seconds,
                        "decode_speed_x": round(media_seconds / elapsed, 3),
                        "maxrss_kib": int(rss[1]) if rss else None,
                        "passed": result.returncode == 0 and frames >= 200 and media_seconds >= 9,
                    }
                    (args.out / (logname + ".log")).write_text(result.stderr)
                    (args.out / (logname + "-progress.txt")).write_text(result.stdout)
                except subprocess.TimeoutExpired:
                    # adb's host-side timeout does not kill its remote child.
                    # Isolate the experiment binary path when terminating it.
                    shell("pkill", "-f", remote + "/ffmpeg")
                    run = {"mode": mode, "seek_seconds": offset,
                           "passed": False, "error": "120 second deadline"}
                entry["runs"].append(run)
                print(json.dumps({"sample": file.name, **run}), flush=True)
                (args.out / "report.json").write_text(json.dumps(report, indent=2))
            # Save a visible frame and per-frame hashes. Successful time
            # progress alone is not sufficient evidence of a real picture.
            prefix = remote + "/" + name + "-" + mode
            base = [remote + "/ffmpeg", "-hide_banner", "-nostdin", "-loglevel", "error",
                    "-xerror", "-y", *codec, "-i", sample, "-map", "0:v:0", "-an"]
            for extension, options in (
                ("ppm", ["-frames:v", "1", "-c:v", "ppm", "-update", "1"]),
                ("framemd5", ["-frames:v", "30", "-f", "framemd5"]),
            ):
                result = shell(*base, *options, prefix + "." + extension)
                if not result.returncode:
                    require(adb("pull", prefix + "." + extension,
                                str(args.out / f"{name}-{mode}.{extension}")))
    print("Report:", args.out / "report.json")


if __name__ == "__main__":
    main()
