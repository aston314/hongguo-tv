#!/usr/bin/env python3
"""Read the APK version once so builds, filenames and update manifests agree."""
import argparse
import os
from pathlib import Path
import re

def metadata(root):
    source = (root / 'android/app/build.gradle').read_text()
    version = re.search(r'def appVersion = "([0-9]+\.[0-9]+\.[0-9]+)"', source).group(1)
    match = re.search(r'def standardVersionCode = (\d+)', source) or re.search(r'\bversionCode\s+(\d+)', source)
    code = int(match.group(1))
    sdk = int(re.search(r'\bminSdk\s+(\d+)', source).group(1))
    return version, code, sdk

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--github-env', type=Path, required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    version, code, sdk = metadata(root)
    source = (root / 'android/app/build.gradle').read_text()
    mpv_code = int(re.search(r'def mpvVersionCode = (\d+)', source).group(1))
    sha = os.environ['GITHUB_SHA']
    assert re.fullmatch(r'[a-f0-9]{40}', sha)
    with args.github_env.open('a') as output:
        output.write(f'APP_VERSION={version}\nAPP_VERSION_CODE={code}\nAPP_MIN_SDK={sdk}\nHONGGUO_CORE_VERSION={version}-{sha}\n')
        output.write(f'MPV_VERSION_CODE={mpv_code}\nMPV_MIN_SDK=23\n')
        output.write(f'ANDROID5_VERSION_CODE={code}\nANDROID5_MIN_SDK=21\n')
    print(f'Build version {version}, code {code}, minimum SDK {sdk}')
