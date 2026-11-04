#!/usr/bin/env python3
"""Publish an advisory webOS channel only after its exact IPK is public."""
import argparse
import base64
import hashlib
import json
from pathlib import Path
import re

from publish_public_release import REPOSITORY, api, gh
from verify_webos_ipk import ar_members, read_tar_member

CHANNEL = 'webos-update.json'
TEST_CHANNEL = 'test.27'


def version(value):
    if not isinstance(value, str) or not re.fullmatch(r'(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})', value):
        raise ValueError('Invalid webOS version')
    return tuple(map(int, value.split('.')))


def generate(ipk, app_version, notes):
    version(app_version)
    expected = f'hongguo-webos-{app_version}-{TEST_CHANNEL}.ipk'
    if ipk.name != expected or not 0 < ipk.stat().st_size <= 100 * 1024 * 1024:
        raise ValueError('Invalid webOS artifact')
    appinfo, _, _ = read_tar_member(ar_members(ipk)['data.tar.gz'], '/appinfo.json')
    appinfo = json.loads(appinfo)
    if appinfo.get('id') != 'com.aston314.hongguo.webos' or appinfo.get('version') != app_version:
        raise ValueError('IPK identity/version differs')
    text = notes.read_text().strip()
    if len(text) > 16000:
        raise ValueError('Release notes too long')
    tag = f'webos-v{app_version}-{TEST_CHANNEL}'
    return {'schema': 1, 'platform': 'webos', 'app_id': appinfo['id'], 'version_name': app_version,
            'release_tag': tag, 'release_url': f'https://github.com/{REPOSITORY}/releases/tag/{tag}',
            'release_notes': text, 'artifact_name': expected, 'artifact_size': ipk.stat().st_size,
            'artifact_sha256': hashlib.sha256(ipk.read_bytes()).hexdigest()}


def publish(value):
    release = api(f'repos/{REPOSITORY}/releases/tags/{value["release_tag"]}')
    if release.get('draft') is not False:
        raise ValueError('IPK release must already be published')
    asset = next((item for item in release.get('assets', []) if item['name'] == value['artifact_name']), None)
    if not asset or asset.get('size') != value['artifact_size'] or asset.get('digest') != 'sha256:' + value['artifact_sha256']:
        raise ValueError('Published IPK differs; channel was not updated')
    old = gh('api', f'repos/{REPOSITORY}/contents/{CHANNEL}', required=False)
    existing = None
    if old.returncode == 0:
        existing = json.loads(old.stdout)
        previous = json.loads(base64.b64decode(existing['content']))
        if previous.get('platform') != 'webos' or previous.get('app_id') != value['app_id']:
            raise ValueError('Existing channel has wrong identity')
        previous_version, next_version = version(previous['version_name']), version(value['version_name'])
        if previous_version > next_version:
            print('Newer webOS channel preserved'); return
        if previous_version == next_version and previous.get('artifact_sha256') != value['artifact_sha256']:
            raise ValueError('Refusing replacement IPK for the same webOS version')
    elif '404' not in old.stderr:
        raise RuntimeError(old.stderr.strip())
    content = (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode()
    if existing and base64.b64decode(existing['content']) == content:
        print('webOS channel already matches'); return
    payload = {'message': 'Publish webOS update notice ' + value['version_name'], 'content': base64.b64encode(content).decode()}
    if existing:
        payload['sha'] = existing['sha']
    gh('api', '--method', 'PUT', f'repos/{REPOSITORY}/contents/{CHANNEL}', payload=payload)
    print('Published webOS update notice ' + value['version_name'])


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--ipk', type=Path, required=True)
    parser.add_argument('--version', required=True)
    parser.add_argument('--notes', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--publish', action='store_true')
    args = parser.parse_args()
    result = generate(args.ipk, args.version, args.notes)
    args.out.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    if args.publish:
        publish(result)
