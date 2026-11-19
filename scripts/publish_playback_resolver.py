#!/usr/bin/env python3
"""Publish one signed playback resolver artifact to the public download repo."""
import argparse
import base64
import hashlib
import json
import re
from pathlib import Path
from urllib.parse import urlparse

from publish_public_release import REPOSITORY, api, gh, release_by_tag, upload_asset, verify_assets

MANIFEST_NAME = 'playback-resolver.json'
PRODUCT = 'hongguo-playback-resolver'
SCHEMA = 1
PROTOCOL = 1
MAX_ARTIFACT_SIZE = 32 * 1024 * 1024
VERSION_RE = re.compile(r'^[0-9]+(?:\.[0-9]+){2,}(?:[-+][A-Za-z0-9.-]+)?$')


def read_manifest(path: Path, artifact: Path):
    manifest = json.loads(path.read_text(encoding='utf-8'))
    if (manifest.get('schema'), manifest.get('product'), manifest.get('protocol')) != (SCHEMA, PRODUCT, PROTOCOL):
        raise ValueError('Invalid playback resolver manifest identity')
    version = manifest.get('resolver_version')
    if not isinstance(version, str) or not VERSION_RE.fullmatch(version):
        raise ValueError('Missing resolver version')
    if artifact.name != 'resolver.wasm' or not artifact.is_file() or not 0 < artifact.stat().st_size <= MAX_ARTIFACT_SIZE:
        raise ValueError('Resolver artifact must be a non-empty resolver.wasm <= 32 MiB')
    if manifest.get('size') != artifact.stat().st_size or manifest.get('sha256') != hashlib.sha256(artifact.read_bytes()).hexdigest():
        raise ValueError('Manifest digest or size does not match resolver.wasm')
    signature = manifest.get('signature')
    if not isinstance(signature, str) or not signature:
        raise ValueError('Manifest has no signature')
    try:
        decoded_signature = base64.b64decode(signature, validate=True)
    except Exception as exc:
        raise ValueError('Manifest signature is not valid base64') from exc
    if len(decoded_signature) != 64:
        raise ValueError('Manifest signature must be 64 bytes')
    expected_url = f'https://github.com/{REPOSITORY}/releases/download/playback-resolver-v{version}/resolver.wasm'
    if manifest.get('download_url') != expected_url:
        raise ValueError(f'Manifest download_url must be {expected_url}')
    parsed = urlparse(manifest['download_url'])
    if parsed.scheme != 'https' or parsed.netloc != 'github.com' or parsed.query or parsed.fragment:
        raise ValueError('Manifest download_url is not a safe GitHub HTTPS URL')
    return manifest


def put_manifest(path: Path):
    content = path.read_bytes()
    existing = gh('api', f'repos/{REPOSITORY}/contents/{MANIFEST_NAME}', required=False)
    old = None
    if existing.returncode == 0:
        old = json.loads(existing.stdout)
        if base64.b64decode(old['content']) == content:
            return
    elif '404' not in existing.stderr:
        raise RuntimeError(existing.stderr.strip() or 'Cannot read existing playback resolver manifest')
    payload = {'message': 'Publish playback resolver manifest', 'content': base64.b64encode(content).decode()}
    if old is not None:
        payload['sha'] = old['sha']
    api(f'repos/{REPOSITORY}/contents/{MANIFEST_NAME}', method='PUT', payload=payload)


def publish(artifact: Path, manifest_path: Path, notes: Path):
    manifest = read_manifest(manifest_path, artifact)
    tag = 'playback-resolver-v' + manifest['resolver_version']
    release = release_by_tag(tag)
    if release is not None:
        assets = {asset['name']: asset for asset in release['assets']}
        unexpected = set(assets) - {artifact.name}
        if unexpected:
            raise ValueError('Existing resolver release has unexpected assets: ' + ', '.join(sorted(unexpected)))
        if artifact.name in assets:
            verify_assets({'assets': [assets[artifact.name]]}, (artifact,))
    if release is None:
        release = api(f'repos/{REPOSITORY}/releases', payload={
            'tag_name': tag,
            'target_commitish': 'main',
            'draft': True,
            'name': '红果短剧播放解析器 ' + manifest['resolver_version'],
            'body': notes.read_text(encoding='utf-8'),
        })
    if release['draft']:
        if not any(asset['name'] == artifact.name for asset in release['assets']):
            upload_asset(release['id'], artifact)
        uploaded = api(f'repos/{REPOSITORY}/releases/{release["id"]}')
        verify_assets(uploaded, (artifact,))
        release = api(f'repos/{REPOSITORY}/releases/{release["id"]}', method='PATCH', payload={
            'draft': False, 'prerelease': False, 'make_latest': 'false',
        })
    verify_assets(release, (artifact,))
    if release['draft']:
        raise RuntimeError('Resolver release remains a draft')
    put_manifest(manifest_path)
    print(f'Published {tag}: https://github.com/{REPOSITORY}/releases/tag/{tag}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--artifact', type=Path, required=True)
    parser.add_argument('--manifest', type=Path, required=True)
    parser.add_argument('--notes', type=Path, required=True)
    args = parser.parse_args()
    publish(args.artifact, args.manifest, args.notes)
