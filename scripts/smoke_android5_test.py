#!/usr/bin/env python3
"""API21 emulator installation, real Go process, WebView and relaunch smoke."""
import json
import os
from pathlib import Path
import subprocess
import time
import urllib.request

PACKAGE = 'rocks.aston.hongguotv.android5test'
OUT = Path(os.environ['ANDROID5_TEST_OUTPUT'])


def adb(*args):
    return subprocess.check_output(['adb', *args], text=True, stderr=subprocess.STDOUT)


def ready():
    adb('logcat', '-c')
    adb('shell', 'am', 'start', '-W', '-n', PACKAGE + '/rocks.aston.hongguotv.MainActivity')
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        logs = adb('logcat', '-d', '-s', 'HongguoAndroid5Test:I', 'AndroidRuntime:E', 'libc:F')
        if 'FATAL EXCEPTION' in logs or 'Fatal signal' in logs:
            raise RuntimeError(logs[-12000:])
        if 'ui_ready=true' in logs:
            return
        time.sleep(2)
    raise RuntimeError('API21 WebView did not initialize: ' + logs[-12000:])


assert adb('shell', 'getprop', 'ro.build.version.sdk').strip() == '21'
adb('install', '-r', str(OUT / 'hongguo-tv-android5-test.1.apk'))
ready()
version = None
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
            version = data['version']
            break
    except (OSError, ValueError):
        pass
    finally:
        adb('forward', '--remove', 'tcp:18797')
assert version and version.startswith('0.2.136-android5-test.1+'), 'API21 native core status missing'
with (OUT / 'android5-emulator.png').open('wb') as image:
    subprocess.run(['adb', 'exec-out', 'screencap', '-p'], stdout=image, check=True)
adb('shell', 'am', 'force-stop', PACKAGE)
ready()
(OUT / 'emulator-verification.json').write_text(json.dumps({
    'sdk': 21, 'emulator_abi': adb('shell', 'getprop', 'ro.product.cpu.abi').strip(),
    'source_commit': os.environ['GITHUB_SHA'], 'core_version': version,
    'install': 'passed', 'native_core': 'passed', 'webview_ui': 'passed', 'force_stop_relaunch': 'passed',
    'physical_tv_playback': 'not_tested'
}, indent=2) + '\n')
print('API21 install / native core / WebView UI / force-stop relaunch passed; physical playback remains untested.')
