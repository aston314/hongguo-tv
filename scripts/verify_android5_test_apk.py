#!/usr/bin/env python3
"""Verify isolated API21 test identities and the existing official signer."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import zipfile

SIGNER = '117dc57341c638a6f416ef256e0d9893bcdf7961acfc4c1b270b79bea8b6785f'
PACKAGE = 'rocks.aston.hongguotv.android5test'
VERSION = '0.2.136-android5-test.1'


def verify(path, arm32=False):
    build_tools = Path(os.environ['ANDROID_HOME']) / 'build-tools/35.0.0'
    badging = subprocess.check_output([str(build_tools / 'aapt'), 'dump', 'badging', str(path)], text=True)
    for expected in [f"name='{PACKAGE}'", "versionCode='1'", f"versionName='{VERSION}'",
                     "sdkVersion:'21'", "application-label:'红果短剧 · Android 5 测试'"]:
        assert expected in badging, expected
    assert 'application-debuggable' not in badging
    manifest = subprocess.check_output([str(build_tools / 'aapt'), 'dump', 'xmltree', str(path), 'AndroidManifest.xml'], text=True)
    assert 'hongguo-android5-test' in manifest
    signature = subprocess.check_output([str(build_tools / 'apksigner'), 'verify', '--min-sdk-version', '21', '--verbose', '--print-certs', str(path)], text=True)
    assert 'Verified using v1 scheme (JAR signing): true' in signature
    assert re.findall(r'Signer #\d+ certificate SHA-256 digest: ([0-9a-f]+)', signature) == [SIGNER]
    with zipfile.ZipFile(path) as archive:
        native = sorted(n for n in archive.namelist() if n.startswith('lib/') and n.endswith('.so'))
        abis = ['armeabi-v7a'] if arm32 else ['arm64-v8a', 'armeabi-v7a', 'x86_64']
        assert native == sorted(f'lib/{abi}/libhongguotv.so' for abi in abis)
        for name in native:
            data = archive.read(name)
            assert data.startswith(b'\x7fELF') and VERSION.encode() in data
        dex = [n for n in archive.namelist() if n.endswith('.dex')]
        assert dex and all(archive.read(n)[:8] == b'dex\n035\0' for n in dex)
    return {'file': path.name, 'package': PACKAGE, 'version': VERSION, 'min_sdk': 21,
            'abis': abis, 'signer_sha256': SIGNER, 'size': path.stat().st_size,
            'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'dex_format': '035'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--directory', type=Path, required=True)
    args = parser.parse_args()
    results = [verify(args.directory / 'hongguo-tv-android5-test.1.apk'),
               verify(args.directory / 'hongguo-tv-android5-test.1-arm32.apk', True)]
    print(json.dumps({'source_commit': os.environ['GITHUB_SHA'], 'apks': results}, ensure_ascii=False, indent=2))
