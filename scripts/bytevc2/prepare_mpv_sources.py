#!/usr/bin/env python3
"""Fetch only hash-pinned experimental MPV sources, preserving source archives."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import tarfile
import urllib.request


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("work", type=Path)
    parser.add_argument("source_output", type=Path)
    args = parser.parse_args()
    script = Path(__file__).resolve().parent
    pins = json.loads((script / "mpv_preview_sources.json").read_text())
    args.source_output.mkdir(parents=True, exist_ok=True)
    for name, pin in pins.items():
        file = args.source_output / (name + ".tar.gz")
        if not file.exists() or hashlib.sha256(file.read_bytes()).hexdigest() != pin["sha256"]:
            for attempt in range(4):
                try:
                    with urllib.request.urlopen(f"https://codeload.github.com/{pin['repo']}/tar.gz/{pin['commit']}", timeout=90) as response:
                        file.write_bytes(response.read())
                    break
                except OSError:
                    if attempt == 3:
                        raise
        if hashlib.sha256(file.read_bytes()).hexdigest() != pin["sha256"]:
            raise RuntimeError("Source SHA256 mismatch: " + name)
        destination = args.work / name
        destination.mkdir(parents=True)
        with tarfile.open(file) as archive:
            archive.extractall(destination, filter="data")
        children = list(destination.iterdir())
        if len(children) != 1 or not children[0].is_dir():
            raise RuntimeError("Unexpected source root: " + name)
        for item in children[0].iterdir():
            shutil.move(str(item), destination / item.name)
        children[0].rmdir()
        print("Verified source:", name, pin["commit"], flush=True)
    shutil.copy(script / "mpv_preview_sources.json", args.source_output)


if __name__ == "__main__":
    main()
