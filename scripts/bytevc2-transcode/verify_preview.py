#!/usr/bin/env python3
"""Fail closed if CI accidentally packages a production identity/player."""
import argparse
from pathlib import Path
import subprocess
import zipfile

p = argparse.ArgumentParser()
p.add_argument("apk", type=Path)
p.add_argument("--build-tools", type=Path, required=True)
a = p.parse_args()
manifest = subprocess.check_output([str(a.build_tools / "aapt"), "dump", "badging", str(a.apk)], text=True)
assert "package: name='rocks.aston.hongguotv.transcodetest.debug'" in manifest
assert "sdkVersion:'23'" in manifest
assert "native-code: 'arm64-v8a'" in manifest
assert "转码测试" in manifest
with zipfile.ZipFile(a.apk) as z:
    names = set(z.namelist())
    for lib in ("libhongguotv.so", "libbvc2reference.so", "libbvc2optimized.so"):
        assert "lib/arm64-v8a/" + lib in names, lib
    assert not any(n.startswith(("lib/armeabi-v7a/", "lib/x86_64/")) for n in names)
    assert not any(n.endswith(("libmpv.so", "libhongguompv.so")) for n in names)
subprocess.run([str(a.build_tools / "apksigner"), "verify", "--verbose", str(a.apk)], check=True)
print("Verified isolated arm64 standard-player transcoding APK")
