#!/usr/bin/env python3
"""Build an allowlisted corresponding-library-source kit, never app source."""
import argparse
import hashlib
import json
from pathlib import Path
import tarfile
import zipfile
from prepare_mpv import ROOT, BASE, LIBRARIES, HEADER_URL, HEADER_SHA, fetch

BRIDGE_FILES = (
    'android/mpv-jni/bridge.cpp', 'android/mpv-jni/media_codec_layout_parser.h', 'android/mpv-jni/LICENSE',
    'android/app/src/mpv/java/rocks/aston/hongguotv/MPVLib.java',
    'scripts/prepare_mpv.py', 'scripts/mpv_sources.json',
    'scripts/replace_mpv_library.py', 'scripts/rebuild_mpv_libraries.py',
    'docs/mpv-library-source.md',
)

def member_bytes(archive, relative):
    with tarfile.open(archive) as source:
        member = next(m for m in source.getmembers() if m.isfile() and m.name.split('/', 1)[-1] == relative)
        return source.extractfile(member).read()

def package(cache, output):
    sources = json.loads((ROOT / 'scripts/mpv_sources.json').read_text())
    entries, notices = {}, ['红果短剧 MPV — 第三方库与许可\n'
        'libmpv: LGPL 构建；FFmpeg: LGPLv3（disable-gpl / disable-nonfree / enable-version3）。\n'
        '这些库动态链接到应用。对应版本的库源码、补丁、构建及替换工具随 MPV 发布提供。\n'
        '允许为调试修改后的 LGPL 库进行必要的逆向工程和库替换；不提供原发行签名密钥。\n'
        '源码附件用于满足许可及便于研究，不承诺源码答疑或修改版支持。\n']
    for name, pin in sources.items():
        url = f'https://codeload.github.com/{pin["repo"]}/tar.gz/{pin["commit"]}'
        archive = fetch(url, pin['sha256'], cache / (name + '.tar.gz'))
        entries['sources/' + name + '.tar.gz'] = archive.read_bytes()
        license_text = member_bytes(archive, pin['license']).decode('utf-8', 'replace')
        notices.append(f'\n=== {name} — https://github.com/{pin["repo"]} @ {pin["commit"]} ===\n' + license_text)
    # Full effective LGPLv3/GPLv3 text and the alternative FreeType license.
    for name, path in [('ffmpeg','COPYING.GPLv3'), ('mpv','Copyright'), ('freetype','docs/FTL.TXT')]:
        notices.append('\n=== ' + name + '/' + path + ' ===\n' + member_bytes(cache / (name + '.tar.gz'), path).decode('utf-8', 'replace'))
    notices.append('\n=== Hongguo JNI bridge — MIT ===\n' + (ROOT / 'android/mpv-jni/LICENSE').read_text())
    notice = '\n'.join(notices).encode()
    assets = ROOT / 'android/app/src/mpv/assets'; assets.mkdir(parents=True, exist_ok=True)
    (assets / 'mpv-notices.txt').write_bytes(notice)
    entries['NOTICE.txt'] = notice
    for path in BRIDGE_FILES: entries[path] = (ROOT / path).read_bytes()
    entries['android/mpv-jni/include/mpv/client.h'] = fetch(HEADER_URL, HEADER_SHA, cache / 'client.h').read_bytes()
    entries['BINARY-PINS.json'] = json.dumps({'base': BASE, 'libraries': LIBRARIES}, indent=2).encode()
    entries['KIT-SHA256SUMS.txt'] = ''.join(hashlib.sha256(value).hexdigest() + '  ' + key + '\n' for key,value in sorted(entries.items())).encode()
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as kit:
        for name, value in sorted(entries.items()):
            # Tarballs are already compressed; store them without recompression.
            kit.writestr(name, value, compress_type=zipfile.ZIP_STORED if name.endswith('.tar.gz') else zipfile.ZIP_DEFLATED)
    print(f'Library source kit: {output.name}, {output.stat().st_size} bytes; {len(sources)} pinned source archives')

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--cache', type=Path, default=ROOT / 'tmp/mpv-sources')
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args(); package(args.cache, args.out)
