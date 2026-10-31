#!/usr/bin/env python3
"""Verify both APK identities, signatures and ABI/library isolation after CI build."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import zipfile

def verify(apk, variant, version, code, debug=False):
    tools = Path(os.environ['ANDROID_HOME']) / 'build-tools/35.0.0'
    badging = subprocess.check_output([str(tools / 'aapt'), 'dump', 'badging', str(apk)], text=True)
    suffix = '.mpv' if variant == 'mpv' else '.media3test' if variant == 'standard-media3' else ''
    package = 'rocks.aston.hongguotv' + suffix + ('.debug' if debug else '')
    assert f"name='{package}'" in badging
    assert f"versionCode='{code}'" in badging
    name_suffix = '-media3-test' if variant == 'standard-media3' else ''
    assert f"versionName='{version}{name_suffix}{'-debug' if debug else ''}'" in badging
    assert "sdkVersion:'23'" in badging
    assert debug == ('application-debuggable' in badging)
    assert "application-label:'红果短剧'" in badging
    signature = subprocess.check_output([str(tools / 'apksigner'), 'verify', '--verbose', '--print-certs', str(apk)], text=True)
    signer = re.findall(r'Signer #\d+ certificate SHA-256 digest: ([0-9a-f]+)', signature)
    assert signer
    with zipfile.ZipFile(apk) as archive:
        names = archive.namelist()
        for abi in ('arm64-v8a', 'armeabi-v7a', 'x86_64'):
            assert f'lib/{abi}/libhongguotv.so' in names
            for library in ('libmpv.so', 'libhongguompv.so'):
                assert (f'lib/{abi}/{library}' in names) == (variant == 'mpv')
            for library in ('libavcodec.so', 'libavutil.so', 'libswresample.so', 'libswscale.so', 'libmedia3ext.so'):
                assert (f'lib/{abi}/{library}' in names) == (variant == 'standard-media3')
        assert not any('media_kit' in name or 'fftools' in name for name in names)
        assert ('assets/mpv-notices.txt' in names) == (variant == 'mpv')
        assert ('assets/media3-ffmpeg-notices.txt' in names) == (variant == 'standard-media3')
    assert 0 < apk.stat().st_size <= 100 * 1024 * 1024
    return {'variant': variant, 'package': package, 'version': version, 'version_code': code,
            'size': apk.stat().st_size, 'signers': sorted(signer)}

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--standard', type=Path, required=True)
    parser.add_argument('--standard-media3', type=Path)
    parser.add_argument('--mpv', type=Path, required=True)
    parser.add_argument('--version', required=True)
    parser.add_argument('--standard-code', type=int, required=True)
    parser.add_argument('--mpv-code', type=int, required=True)
    parser.add_argument('--debug', action='store_true')
    args = parser.parse_args()
    results = [verify(args.standard, 'standard', args.version, args.standard_code, args.debug)]
    if args.standard_media3:
        results.append(verify(args.standard_media3, 'standard-media3', args.version, args.standard_code, args.debug))
    results.append(verify(args.mpv, 'mpv', args.version, args.mpv_code, args.debug))
    assert results[0]['signers'] == results[-1]['signers'], 'Edition signers differ'
    print(json.dumps(results, ensure_ascii=False, indent=2))
