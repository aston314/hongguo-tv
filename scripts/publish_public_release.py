#!/usr/bin/env python3
"""Publish only allowlisted public release files. Never upload the source checkout."""
import argparse
import base64
import hashlib
import json
from pathlib import Path
import subprocess
import shutil
import re
import zipfile
from urllib.parse import quote

REPOSITORY = 'aston314/hongguo-tv-releases'

def gh(*args, payload=None, required=True):
    command = ['gh', *args]
    if payload is not None:
        command += ['--input', '-']
    result = subprocess.run(command, input=None if payload is None else json.dumps(payload),
                            capture_output=True, text=True, check=False)
    if required and result.returncode:
        raise RuntimeError(result.stderr.strip() or 'GitHub publication failed')
    return result

def api(path, method=None, **kwargs):
    args = ['api', path]
    if method is not None:
        args += ['--method', method]
    return json.loads(gh(*args, **kwargs).stdout)

def release_by_tag(tag):
    result = gh('api', f'repos/{REPOSITORY}/releases/tags/{tag}', required=False)
    if result.returncode == 0:
        return json.loads(result.stdout)
    if '404' not in result.stderr:
        raise RuntimeError(result.stderr.strip() or 'Cannot read release')
    # A draft's tag may not exist until publication. Resolve it from drafts,
    # then use its release ID rather than requiring the future Git tag.
    return next((r for r in api(f'repos/{REPOSITORY}/releases?per_page=100') if r['tag_name'] == tag), None)

def upload_asset(release_id, path):
    # Keep authentication in gh. The upload host and repository are fixed;
    # do not follow an upload_url obtained from arbitrary metadata.
    endpoint = f'https://uploads.github.com/repos/{REPOSITORY}/releases/{release_id}/assets?name={quote(path.name)}'
    return json.loads(gh('api', '--method', 'POST', endpoint,
                         '--header', 'Content-Type: application/octet-stream',
                         '--input', str(path)).stdout)

def verify_assets(release, files):
    assets = {asset['name']: asset for asset in release['assets']}
    for path in files:
        asset = assets.get(path.name)
        digest = 'sha256:' + hashlib.sha256(path.read_bytes()).hexdigest()
        if asset is None or asset.get('digest') != digest or asset.get('size') != path.stat().st_size:
            raise ValueError(f'Published asset differs: {path.name}; preserving existing files')

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def verify_library_kit(path, pins=None):
    if pins is None: pins = json.loads((Path(__file__).parent / 'mpv_sources.json').read_text())
    bridge = {'android/mpv-jni/bridge.cpp', 'android/mpv-jni/LICENSE',
        'android/app/src/mpv/java/rocks/aston/hongguotv/MPVLib.java',
        'scripts/prepare_mpv.py', 'scripts/mpv_sources.json',
        'scripts/replace_mpv_library.py', 'scripts/rebuild_mpv_libraries.py',
        'docs/mpv-library-source.md', 'android/mpv-jni/include/mpv/client.h',
        'BINARY-PINS.json', 'NOTICE.txt', 'KIT-SHA256SUMS.txt'}
    expected = bridge | {'sources/' + name + '.tar.gz' for name in pins}
    with zipfile.ZipFile(path) as kit:
        if len(kit.namelist()) != len(expected) or set(kit.namelist()) != expected:
            raise ValueError('Library kit contains missing or unapproved files')
        sums = parse_sums(kit.read('KIT-SHA256SUMS.txt').decode())
        if set(sums) != expected - {'KIT-SHA256SUMS.txt'}: raise ValueError('Invalid library kit checksums')
        for name, checksum in sums.items():
            if hashlib.sha256(kit.read(name)).hexdigest() != checksum: raise ValueError('Library kit file differs: ' + name)
        for name, pin in pins.items():
            if sums['sources/' + name + '.tar.gz'] != pin['sha256']: raise ValueError('Wrong corresponding library source')
        if json.loads(kit.read('scripts/mpv_sources.json')) != pins:
            raise ValueError('Library source metadata differs')

def parse_sums(text):
    result = {}
    for line in text.splitlines():
        parts = line.split()
        if len(parts) != 2 or not re.fullmatch('[a-f0-9]{64}', parts[0]) or parts[1] in result:
            raise ValueError('Invalid or duplicate checksum entry')
        result[parts[1]] = parts[0]
    return result

def verify_bundle(directory):
    manifests, binaries = {}, []
    for channel, variant in [('update.json','standard'), ('update-mpv.json','mpv'), ('update-android5.json','android5')]:
        path = directory / channel
        if not path.exists():
            if variant == 'standard': raise ValueError('Missing standard update manifest')
            continue
        manifest = json.loads(path.read_text()); version = manifest['version_name']
        if not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+', version): raise ValueError('Invalid version')
        if manifest.get('variant', 'standard') != variant or manifest['package_name'] != 'rocks.aston.hongguotv' + {'mpv': '.mpv', 'android5': '.android5test'}.get(variant, ''):
            raise ValueError('Cross-edition update manifest')
        if type(manifest['version_code']) != int or manifest['version_code'] <= 0 or (manifest['min_sdk'] != 21 if variant == 'android5' else manifest['min_sdk'] < 23):
            raise ValueError('Invalid update version/SDK')
        apk = directory / f'hongguo-tv-{"" if variant == "standard" else variant + "-"}{version}.apk'
        if digest(apk) != manifest['sha256'] or apk.stat().st_size != manifest['size']:
            raise ValueError('APK differs from update manifest')
        base = f'https://github.com/{REPOSITORY}/releases/download/v{version}/'
        if manifest['download_url'] != base + apk.name: raise ValueError('Invalid public download URL')
        binaries.append(apk)
        if variant == 'mpv':
            # The private signed release may carry the LGPL source kit. The
            # public download release intentionally omits it to keep the user
            # download repository small; APK users do not need the kit.
            if 'library_source' in manifest:
                source = directory / f'hongguo-tv-mpv-library-source-{version}.zip'
                info = manifest.get('library_source', {})
                if info.get('name') != source.name or info.get('url') != base + source.name or info.get('size') != source.stat().st_size or info.get('sha256') != digest(source):
                    raise ValueError('MPV corresponding library source differs')
                verify_library_kit(source); binaries.append(source)
        manifests[channel] = manifest
    if len({m['version_name'] for m in manifests.values()}) != 1: raise ValueError('Edition versions differ')
    sums = directory / 'SHA256SUMS.txt'
    if parse_sums(sums.read_text()) != {p.name: digest(p) for p in binaries}: raise ValueError('Release checksums differ')
    return manifests, tuple(binaries + [sums] + [directory / channel for channel in manifests])

def read_channel(channel):
    result = gh('api', f'repos/{REPOSITORY}/contents/{channel}', required=False)
    if result.returncode == 0:
        value = json.loads(result.stdout)
        previous = json.loads(base64.b64decode(value['content']))
        if type(previous['version_code']) != int: raise ValueError('Invalid previous versionCode')
        return value, previous
    if '404' not in result.stderr: raise RuntimeError(result.stderr.strip() or 'Cannot read previous update channel')
    return None, None

def stage_public_bundle(source, destination):
    """Copy exact signed APK bytes; retain only public manifests and checksums."""
    manifests, _ = verify_bundle(source)
    destination.mkdir(parents=True, exist_ok=True)
    binaries = []
    for channel, original in manifests.items():
        manifest = dict(original)
        manifest.pop('library_source', None)
        filename = manifest['download_url'].rsplit('/', 1)[-1]
        target = destination / filename
        shutil.copyfile(source / filename, target)
        binaries.append(target)
        (destination / channel).write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
    (destination / 'SHA256SUMS.txt').write_text(''.join(digest(p) + '  ' + p.name + '\n' for p in binaries))
    verify_bundle(destination)

def may_update(previous, manifest):
    if previous is None: return True
    if previous['version_code'] > manifest['version_code']: return False
    if previous['version_code'] == manifest['version_code'] and previous['sha256'] != manifest['sha256']:
        raise ValueError('Refusing to change APK bytes for an existing versionCode')
    return True

def publish(directory, notes):
    manifests, files = verify_bundle(directory)
    repo = api(f'repos/{REPOSITORY}')
    if repo['private'] or repo['default_branch'] != 'main':
        raise ValueError('Download repository must be public with a main branch')
    version = manifests['update.json']['version_name']; tag = f'v{version}'
    # Check every included channel for conflicting bytes before any mutation.
    for channel, manifest in manifests.items(): may_update(read_channel(channel)[1], manifest)
    release = release_by_tag(tag)
    if release is not None:
        allowed = {p.name for p in files}
        # Releases made before the public-source split may retain their old
        # source kit. Preserve those historical assets; new public releases do
        # not upload a source kit.
        version = manifests['update.json']['version_name']
        legacy_source = f'hongguo-tv-mpv-library-source-{version}.zip'
        if any(a['name'] not in allowed and a['name'] != legacy_source for a in release['assets']):
            raise ValueError('Existing release has unexpected assets; preserving it')
        # Check every existing asset before uploading any missing one.
        for path in files:
            asset = next((a for a in release['assets'] if a['name'] == path.name), None)
            if asset is not None: verify_assets({'assets': [asset]}, (path,))
    if release is None:
        # POST returns the authoritative ID even before draft/tag discovery
        # catches up. Retain that ID for uploads and publication.
        release = api(f'repos/{REPOSITORY}/releases', payload={
            'tag_name': tag, 'target_commitish': 'main', 'draft': True,
            'name': f'红果短剧 {tag}', 'body': notes.read_text()})
    if release['draft']:
        assets = {asset['name']: asset for asset in release['assets']}
        for path in files:
            asset = assets.get(path.name)
            if asset is None:
                asset = upload_asset(release['id'], path)
            verify_assets({'assets': [asset]}, (path,))
        # Re-read by ID to verify the complete upload before making it public.
        uploaded = api(f'repos/{REPOSITORY}/releases/{release["id"]}')
        verify_assets(uploaded, files)
        release = api(f'repos/{REPOSITORY}/releases/{release["id"]}',
                      payload={'draft': False}, method='PATCH')
    verify_assets(release, files)
    if release['draft']:
        raise RuntimeError('Release remains a draft; update metadata was not changed')
    for channel, manifest in manifests.items():
        old, previous = read_channel(channel)
        if not may_update(previous, manifest):
            print('Newer ' + channel + ' already published; kept unchanged'); continue
        content = (directory / channel).read_bytes()
        if old is not None and base64.b64decode(old['content']) == content: continue
        payload = {'message': f'Publish Android TV {channel} {tag}', 'content': base64.b64encode(content).decode()}
        if old is not None: payload['sha'] = old['sha']
        gh('api', '--method', 'PUT', f'repos/{REPOSITORY}/contents/{channel}', payload=payload)
    print(f'Published {tag}: https://github.com/{REPOSITORY}/releases/tag/{tag}')

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--directory', type=Path, required=True)
    parser.add_argument('--notes', type=Path, required=True)
    args = parser.parse_args()
    publish(args.directory, args.notes)
