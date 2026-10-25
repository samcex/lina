#!/usr/bin/env python3
"""Read-only native sign-in and relaunch check against an existing tailnet daemon.

Only emulator serials and HTTPS tailnet origins are accepted. Host API requests
are GET only. Forgetting at the end affects only the disposable app's storage.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

os.umask(0o077)
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--serial', required=True)
parser.add_argument('--url', required=True)
parser.add_argument('--output', type=Path, default=Path('/tmp/lina-native-tailnet-verification'))
parser.add_argument('--check-web', action='store_true', help='Also inspect the authenticated optional web screen without modifying host data')
parser.add_argument('--adb', default=str(Path.home() / 'Android/Sdk/platform-tools/adb'))
args = parser.parse_args()
url = urllib.parse.urlsplit(args.url)
if not re.fullmatch(r'emulator-\d+', args.serial):
    parser.error('Use a disposable emulator, never a physical phone.')
if url.scheme != 'https' or not (url.hostname or '').endswith('.ts.net') or url.username or url.password or url.query or url.fragment or url.path not in ('', '/'):
    parser.error('Use the plain HTTPS origin from lina tailscale on, without a token.')
origin = args.url.rstrip('/') + '/'
args.output.mkdir(parents=True, exist_ok=True)

def adb(*values, binary=False):
    return subprocess.check_output([args.adb, '-s', args.serial, *map(str, values)], text=not binary)

def host_get(path):
    with urllib.request.urlopen(origin.rstrip('/') + '/api' + path, timeout=30) as response:
        return json.load(response)

def dump():
    for attempt in range(6):
        try:
            adb('shell', 'rm', '-f', '/sdcard/lina-tailnet-ui.xml')
            adb('shell', 'uiautomator', 'dump', '/sdcard/lina-tailnet-ui.xml')
            xml = adb('shell', 'cat', '/sdcard/lina-tailnet-ui.xml')
            tree = ET.fromstring(xml)
            (args.output / 'last-ui.xml').write_text(xml)
            return tree
        except (subprocess.CalledProcessError, ET.ParseError):
            if attempt == 5:
                raise
            time.sleep(.5)

def find(text=None, desc=None, contains=None):
    for node in dump().iter('node'):
        if (text is None or (node.get('text') == text or (desc is None and node.get('content-desc') == text))) and (desc is None or node.get('content-desc') == desc) and (contains is None or contains in node.get('text', '')):
            bounds = list(map(int, re.findall(r'\d+', node.get('bounds', ''))))
            if len(bounds) == 4 and bounds[2] > bounds[0] and bounds[3] > bounds[1]:
                return node
    return None

def wait(text=None, desc=None, contains=None, timeout=40):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        node = find(text, desc, contains)
        if node is not None:
            return node
        time.sleep(.25)
    raise AssertionError('Missing native tailnet UI: ' + str((text, desc, contains)))

def tap(text=None, desc=None, contains=None):
    node = wait(text, desc, contains)
    x, y, x2, y2 = map(int, re.findall(r'\d+', node.get('bounds')))
    adb('shell', 'input', 'tap', (x+x2)//2, (y+y2)//2)
    return node

def fill(value, desc):
    node = tap(desc=desc)
    adb('shell', 'input', 'keyevent', '123', *(['67'] * max(1, len(node.get('text', '')) + 2)))
    adb('shell', 'input', 'text', shlex.quote(value.replace(' ', '%s')))

health = host_get('/health')
assert health.get('tailnetUser'), 'The host must authenticate this tailnet identity without a token'
sessions = host_get('/sessions')
expected_title = sessions[0].get('title', '')[:45] if sessions else None
selected_apk_sha = hashlib.sha256((Path(__file__).resolve().parents[1] / 'lina.apk').read_bytes()).hexdigest()
installed_paths = [line.removeprefix('package:').strip() for line in adb('shell', 'pm', 'path', 'app.lina.android').splitlines() if line.startswith('package:')]
installed_base = next(path for path in installed_paths if path.endswith('/base.apk'))
installed_copy = args.output / 'installed-lina.apk'
adb('pull', installed_base, str(installed_copy))
installed_apk_sha = hashlib.sha256(installed_copy.read_bytes()).hexdigest()
assert installed_apk_sha == selected_apk_sha, 'The native app is not the selected verified package'
adb('shell', 'am', 'force-stop', 'app.lina.android')
adb('shell', 'pm', 'clear', 'app.lina.android')
adb('shell', 'am', 'start', '-n', 'app.lina.android/.MainActivity')
wait('Connect to LINA')
fill(origin, 'LINA address')
if 'mInputShown=true' in adb('shell', 'dumpsys', 'input_method'):
    adb('shell', 'input', 'keyevent', '4')
tap('CONNECT')
wait(contains='· Connected')
if expected_title:
    wait(contains=expected_title)
else:
    wait(contains='No conversations yet')
(args.output / 'native-tailnet-connected.png').write_bytes(adb('exec-out', 'screencap', '-p', binary=True))
print('PASS native HTTPS tailnet sign-in and existing conversation listing without a token', flush=True)
adb('shell', 'input', 'keyevent', '3')
end = time.monotonic() + 20
while time.monotonic() < end:
    state = adb('shell', 'dumpsys', 'activity', 'activities')
    resumed = [line for line in state.splitlines() if 'topResumedActivity=' in line or 'mResumedActivity:' in line]
    if resumed and all('app.lina.android/' not in line for line in resumed):
        break
    time.sleep(.2)
else:
    raise AssertionError('Native app did not finish backgrounding')
time.sleep(1)
adb('shell', 'am', 'force-stop', 'app.lina.android')
adb('shell', 'am', 'start', '-n', 'app.lina.android/.MainActivity')
wait(contains='· Connected')
if expected_title:
    wait(contains=expected_title)
assert find('Connect to LINA') is None, 'A saved tailnet connection should not ask for credentials again'
print('PASS native tailnet origin survives cold relaunch without storing a token', flush=True)
if args.check_web:
    tap('Menu'); tap('Open web interface')
    end = time.monotonic() + 45
    while time.monotonic() < end:
        tree = dump()
        web = any(n.get('class') == 'android.webkit.WebView' for n in tree.iter('node'))
        authenticated = any('New session' in (n.get('text', '') + n.get('content-desc', '')) for n in tree.iter('node'))
        if web and authenticated:
            break
        time.sleep(.5)
    else:
        raise AssertionError('The optional web interface did not render an authenticated session UI')
    (args.output / 'authenticated-mobile-web.png').write_bytes(adb('exec-out', 'screencap', '-p', binary=True))
    print('PASS authenticated optional mobile web interface rendered in the native web screen', flush=True)
    adb('shell', 'input', 'keyevent', '4')
    wait('Menu')
tap('Menu'); tap('Connection'); tap('FORGET DEVICE')
wait('This device is forgotten.')
assert hashlib.sha256((Path(__file__).resolve().parents[1] / 'lina.apk').read_bytes()).hexdigest() == installed_apk_sha, 'Selected package changed during verification'
report = {
    'passed': True, 'serial': args.serial,
    'api': adb('shell', 'getprop', 'ro.build.version.sdk').strip(),
    'origin': origin, 'authenticatedByTailnet': True,
    'existingSessionCount': len(sessions), 'hostMutations': 0,
    'checks': ['native HTTPS sign-in without token', 'existing conversation listing', 'cold relaunch', 'local forget'],
    'apkSha256': installed_apk_sha, 'installedApkPath': installed_base,
}
if args.check_web:
    report['checks'].append('authenticated optional mobile web render')
(args.output / 'result.json').write_text(json.dumps(report, indent=2))
