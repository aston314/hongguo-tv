#!/usr/bin/env python3
"""Allow a CI-only probe repair while keeping Linux binaries on the release tag."""
import argparse
from pathlib import Path
import re
import subprocess

from desktop_metadata import metadata


def harness_only(paths):
    allowed = {'scripts/verify_linux_playback.py', 'scripts/linux_playback_pictures.py',
               'scripts/linux_release_source.py', '.github/workflows/linux-appimage.yml',
               'tests/test_linux_playback_pictures.py'}
    return all(path in allowed for path in paths)


def source_commit(root):
    version, _ = metadata(root)
    if subprocess.check_output(['git', 'rev-parse', '--is-shallow-repository'], cwd=root, text=True).strip() == 'true':
        subprocess.run(['git', 'fetch', '--no-tags', '--unshallow', 'origin', 'main'], cwd=root, check=True)
    subprocess.run(['git', 'fetch', '--no-tags', 'origin', 'refs/tags/v' + version], cwd=root, check=True)
    commit = subprocess.check_output(['git', 'rev-parse', 'FETCH_HEAD^{commit}'], cwd=root, text=True).strip()
    if not re.fullmatch('[a-f0-9]{40}', commit):
        raise ValueError('Invalid tagged source commit')
    subprocess.run(['git', 'merge-base', '--is-ancestor', commit, 'HEAD'], cwd=root, check=True)
    paths = subprocess.check_output(['git', 'diff', '--name-only', commit, 'HEAD'], cwd=root, text=True).splitlines()
    if not harness_only(paths):
        raise ValueError('Application or packaging differs from the release tag')
    return commit


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--github-env', type=Path, required=True)
    args = parser.parse_args()
    commit = source_commit(Path(__file__).resolve().parents[1])
    with args.github_env.open('a') as output:
        output.write('HONGGUO_LINUX_SOURCE_COMMIT=' + commit + '\n')
    print('Linux application source pinned to release tag:', commit)
