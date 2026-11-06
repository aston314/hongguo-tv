#!/usr/bin/env python3
"""Generate public metadata only from the signed, versioned APK artifact."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import zipfile

PUBLIC_REPOSITORY = 'aston314/hongguo-tv-releases'

def generate(apk, version, code, min_sdk, notes, variant='standard', library_source=None):
    if not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+', version) or code <= 0:
        raise ValueError('Invalid Android release version')
    if variant not in ('standard', 'mpv', 'android5') or (min_sdk != 21 if variant == 'android5' else min_sdk < 23):
        raise ValueError('Invalid release variant or minimum SDK')
    prefix = '' if variant == 'standard' else variant + '-'
    if apk.name != f'hongguo-tv-{prefix}{version}.apk':
        raise ValueError('APK filename and version disagree')
    size = apk.stat().st_size
    if not 0 < size <= 100 * 1024 * 1024:
        raise ValueError('APK size outside update limit')
    with zipfile.ZipFile(apk) as archive:
        if archive.testzip() or 'AndroidManifest.xml' not in archive.namelist():
            raise ValueError('Invalid APK archive')
    text = notes.read_text().strip()
    if len(text) > 16000:
        raise ValueError('Release notes too long')
    result = {'schema': 1, 'variant': variant,
            'package_name': 'rocks.aston.hongguotv' + ({'mpv': '.mpv', 'android5': '.android5test'}.get(variant, '')), 'version_code': code,
            'version_name': version, 'min_sdk': min_sdk, 'size': size,
            'sha256': hashlib.sha256(apk.read_bytes()).hexdigest(),
            'download_url': f'https://github.com/{PUBLIC_REPOSITORY}/releases/download/v{version}/{apk.name}',
            'release_notes': text, 'published_at': datetime.now(timezone.utc).isoformat()}
    if library_source is not None:
        if variant != 'mpv' or library_source.name != f'hongguo-tv-mpv-library-source-{version}.zip':
            raise ValueError('Library source must match the MPV edition/version')
        result['library_source'] = {'name': library_source.name, 'size': library_source.stat().st_size,
            'sha256': hashlib.sha256(library_source.read_bytes()).hexdigest(),
            'url': f'https://github.com/{PUBLIC_REPOSITORY}/releases/download/v{version}/{library_source.name}'}
    return result

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--apk', type=Path, required=True)
    parser.add_argument('--version', required=True)
    parser.add_argument('--code', type=int, required=True)
    parser.add_argument('--min-sdk', type=int, required=True)
    parser.add_argument('--notes', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--variant', choices=['standard', 'mpv', 'android5'], default='standard')
    parser.add_argument('--library-source', type=Path)
    args = parser.parse_args()
    result = generate(args.apk, args.version, args.code, args.min_sdk, args.notes, args.variant, args.library_source)
    args.out.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print(f'Generated update metadata for {result["version_name"]}, code {result["version_code"]}')
