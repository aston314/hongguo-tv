#!/usr/bin/env python3
"""Validate the signed device-test APK without changing public update metadata."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import zipfile

from verify_apks import verify


def validate(directory, version, code, commit):
    if not re.fullmatch(r"[0-9a-f]{40}", commit):
        raise ValueError("Expected a complete source commit")
    backend = "audiotrack,opensles"
    variants = (("delay-controls", "48000"),)
    results = []
    for name, sample_rate in variants:
        apk = directory / f"hongguo-tv-mpv-audio-{name}.apk"
        result = verify(apk, "mpv", version, code)
        result.update(file=apk.name, audio_output_requested=backend,
                      audio_samplerate_requested=sample_rate,
                      audio_delay_test_enabled=True, audio_delay_choices_ms=[-100, -50, -25, 0, 25, 50, 100],
                      sha256=hashlib.sha256(apk.read_bytes()).hexdigest())
        with zipfile.ZipFile(apk) as archive:
            if archive.testzip() is not None:
                raise ValueError("APK ZIP checksum failure")
            entries = archive.namelist()
            dex = [entry for entry in entries if re.fullmatch(r"classes\d*\.dex", entry)]
            if not any(backend.encode() in archive.read(entry) for entry in dex):
                raise ValueError(f"Expected backend constant missing: {name}")
            if not any(sample_rate.encode() in archive.read(entry) for entry in dex):
                raise ValueError(f"Expected sample rate constant missing: {name}")
            for marker in (b"setAudioDelayForTest", b"audio_delay_test_enabled", b"audio_delay_ms"):
                if not any(marker in archive.read(entry) for entry in dex):
                    raise ValueError(f"Expected delay test control missing: {marker!r}")
            # Record the exact native/core payload delivered to this device.
            payload = {entry: hashlib.sha256(archive.read(entry)).hexdigest()
                       for entry in entries
                       if entry not in dex and not entry.startswith("META-INF/")}
            result["native_sha256"] = {entry: digest for entry, digest in payload.items()
                                       if entry.startswith("lib/")}
        results.append(result)
    return {"commit": commit, "public_release": False, "packages": results}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--directory", type=Path, required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--code", type=int, required=True)
    parser.add_argument("--commit", required=True)
    args = parser.parse_args()
    result = validate(args.directory, args.version, args.code, args.commit)
    output = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
    (args.directory / "MANIFEST.json").write_text(output)
    print(output, end="")
