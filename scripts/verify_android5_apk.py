#!/usr/bin/env python3
"""Verify the API21 compatibility APK without weakening normal APK checks."""
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


def verify(apk, version, code, core_version, debug=False):
    tools = Path(os.environ['ANDROID_HOME']) / 'build-tools/35.0.0'
    badging = subprocess.check_output([str(tools / 'aapt'), 'dump', 'badging', str(apk)], text=True)
    for expected in [f"name='{PACKAGE}{'.debug' if debug else ''}'", f"versionCode='{code}'",
                     f"versionName='{version}{'-debug' if debug else ''}'", "sdkVersion:'21'",
                     "application-label:'红果短剧 · Android 5 兼容版'"]:
        assert expected in badging, expected
    assert debug == ('application-debuggable' in badging)
    manifest = subprocess.check_output([str(tools / 'aapt'), 'dump', 'xmltree', str(apk), 'AndroidManifest.xml'], text=True)
    assert 'hongguo-android5-test' in manifest
    assert '.BootReceiver' not in manifest
    assert '.UpdateFileProvider' in manifest and '.UpdateInstallReceiver' in manifest
    signature = subprocess.check_output([str(tools / 'apksigner'), 'verify', '--min-sdk-version', '21', '--verbose', '--print-certs', str(apk)], text=True)
    assert 'Verified using v1 scheme (JAR signing): true' in signature
    signers = re.findall(r'Signer #\d+ certificate SHA-256 digest: ([0-9a-f]+)', signature)
    assert signers and (debug or signers == [SIGNER])
    with zipfile.ZipFile(apk) as archive:
        native = sorted(n for n in archive.namelist() if n.startswith('lib/') and n.endswith('.so'))
        abis = ['arm64-v8a', 'armeabi-v7a', 'x86_64']
        assert native == sorted(f'lib/{abi}/libhongguotv.so' for abi in abis)
        for name in native:
            data = archive.read(name)
            assert data.startswith(b'\x7fELF') and core_version.encode() in data
        dex = [n for n in archive.namelist() if n.endswith('.dex')]
        assert dex and all(archive.read(n)[:8] == b'dex\n035\0' for n in dex)
        assert b'update-android5.json' in b''.join(archive.read(n) for n in dex)
    assert 0 < apk.stat().st_size <= 100 * 1024 * 1024
    return {'file': apk.name, 'package': PACKAGE, 'version': version, 'version_code': code,
            'min_sdk': 21, 'abis': abis, 'signers': signers, 'core_version': core_version,
            'size': apk.stat().st_size, 'sha256': hashlib.sha256(apk.read_bytes()).hexdigest()}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--apk', type=Path, required=True)
    parser.add_argument('--version', required=True)
    parser.add_argument('--code', type=int, required=True)
    parser.add_argument('--core-version', required=True)
    parser.add_argument('--debug', action='store_true')
    args = parser.parse_args()
    print(json.dumps(verify(args.apk, args.version, args.code, args.core_version, args.debug), ensure_ascii=False, indent=2))
