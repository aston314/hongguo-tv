#!/usr/bin/env python3
"""Validate the two signed device-test APKs without changing public update metadata."""
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
    variants = (("audiotrack-auto", "auto"),
                ("audiotrack-48000", "48000"))
    results, payloads = [], []
    for name, sample_rate in variants:
        apk = directory / f"hongguo-tv-mpv-audio-{name}.apk"
        result = verify(apk, "mpv", version, code)
        result.update(file=apk.name, audio_output_requested=backend,
                      audio_samplerate_requested=sample_rate,
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
            # Byte-for-byte checks cover core executables, pinned libraries, UI,
            # resources and manifest. Only compiled Java and signing entries may differ.
            payload = {entry: hashlib.sha256(archive.read(entry)).hexdigest()
                       for entry in entries
                       if entry not in dex and not entry.startswith("META-INF/")}
            payloads.append(payload)
            result["native_sha256"] = {entry: digest for entry, digest in payload.items()
                                       if entry.startswith("lib/")}
        results.append(result)
    if results[0]["signers"] != results[1]["signers"]:
        raise ValueError("The comparison APK signing certificates differ")
    if payloads[0] != payloads[1]:
        changed = sorted(key for key in payloads[0].keys() | payloads[1].keys()
                         if payloads[0].get(key) != payloads[1].get(key))
        raise ValueError(f"Non-Java comparison payload changed: {changed}")
    return {"commit": commit, "public_release": False,
            "identical_non_java_payload": True, "packages": results}


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
