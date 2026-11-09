#!/usr/bin/env python3
"""Verify the experimental package cannot cover any production edition."""
import argparse
from pathlib import Path
import subprocess
import zipfile


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("apk", type=Path)
    parser.add_argument("--build-tools", type=Path, required=True)
    args = parser.parse_args()
    manifest = subprocess.check_output([str(args.build_tools / "aapt"), "dump", "badging", str(args.apk)], text=True)
    assert "package: name='rocks.aston.hongguotv.mpv.bytevc2test.debug'" in manifest
    assert "sdkVersion:'23'" in manifest
    assert "native-code: 'arm64-v8a'" in manifest
    assert "ByteVC2测试" in manifest
    assert "-bytevc2-test-debug" in manifest
    with zipfile.ZipFile(args.apk) as archive:
        names = set(archive.namelist())
        for library in ("libmpv.so", "libhongguompv.so", "libhongguotv.so"):
            assert "lib/arm64-v8a/" + library in names, library
        assert not any(name.startswith(("lib/armeabi-v7a/", "lib/x86_64/")) for name in names)
    subprocess.run([str(args.build_tools / "apksigner"), "verify", "--verbose", str(args.apk)], check=True)
    print("Verified independent arm64 ByteVC2 experiment APK; no production package identity")


if __name__ == "__main__":
    main()
