#!/usr/bin/env python3
"""API21 real-core/UI/updater startup, covering install, and relaunch checks."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import time
import urllib.request


def adb(*args):
    return subprocess.check_output(['adb', *args], text=True, stderr=subprocess.STDOUT)


def ready(package):
    adb('logcat', '-c')
    adb('shell', 'am', 'start', '-W', '-n', package + '/rocks.aston.hongguotv.MainActivity')
    deadline = time.monotonic() + 90
    logs = ''
    while time.monotonic() < deadline:
        logs = adb('logcat', '-d', '-s', 'HongguoAndroid5:I', 'AndroidRuntime:E', 'libc:F')
        if 'FATAL EXCEPTION' in logs or 'Fatal signal' in logs:
            raise RuntimeError(logs[-12000:])
        if 'ui_ready=true' in logs:
            return
        time.sleep(2)
    raise RuntimeError('API21 UI/updater did not initialize: ' + logs[-12000:])


def core_version():
    for line in adb('shell', 'cat', '/proc/net/tcp').splitlines()[1:]:
        fields = line.split()
        if len(fields) < 4 or fields[3] != '0A' or fields[1].split(':')[0] != '0100007F':
            continue
        port = int(fields[1].split(':')[1], 16)
        if port < 1024:
            continue
        adb('forward', 'tcp:18797', f'tcp:{port}')
        try:
            with urllib.request.urlopen('http://127.0.0.1:18797/api/v1/status', timeout=2) as response:
                data = json.load(response)
            if data.get('service') == 'hongguo-tv-core':
                return data['version']
        except (OSError, ValueError):
            pass
        finally:
            adb('forward', '--remove', 'tcp:18797')
    raise RuntimeError('API21 real core status missing')


def smoke(apk, output, expected_core, previous=None, debug=False):
    package = 'rocks.aston.hongguotv.android5test' + ('.debug' if debug else '')
    assert adb('shell', 'getprop', 'ro.build.version.sdk').strip() == '21'
    if previous:
        adb('install', str(previous))
        # Exercise the same application ID and release signer as the original test.
        adb('shell', 'am', 'start', '-W', '-n', package + '/rocks.aston.hongguotv.MainActivity')
        adb('shell', 'am', 'force-stop', package)
    adb('install', '-r', str(apk))
    ready(package)
    assert core_version() == expected_core
    with (output / 'android5-emulator.png').open('wb') as image:
        subprocess.run(['adb', 'exec-out', 'screencap', '-p'], stdout=image, check=True)
    adb('shell', 'am', 'force-stop', package)
    ready(package)
    (output / 'android5-emulator-verification.json').write_text(json.dumps({
        'sdk': 21, 'emulator_abi': adb('shell', 'getprop', 'ro.product.cpu.abi').strip(),
        'source_commit': os.environ['GITHUB_SHA'], 'core_version': expected_core,
        'install': 'passed', 'native_core': 'passed', 'webview_ui_and_updater': 'passed',
        'old_test_covering_install': 'passed' if previous else 'not_tested',
        'force_stop_relaunch': 'passed', 'physical_tv_playback': 'not_tested',
        'online_update_install': 'not_tested'
    }, indent=2) + '\n')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--apk', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--core-version', required=True)
    parser.add_argument('--previous', type=Path)
    parser.add_argument('--debug', action='store_true')
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    smoke(args.apk, args.output, args.core_version, args.previous, args.debug)
