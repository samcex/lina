#!/usr/bin/env python3
"""Verify automatic Home Wi-Fi/Tailscale switching against an isolated daemon and temporary tailnet proxy.

Requires an already booted emulator, adb, Node, built lina.apk. Never uses the owner's
LINA_HOME. Clears only app.lina.android data on the explicitly selected test emulator.
Example: python3 scripts/verify-android.py --serial emulator-5562
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import shlex
import subprocess
import sys
import tempfile
import time
import urllib.request
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--serial', required=True, help='Disposable emulator serial (app data will be reset)')
parser.add_argument('--adb', default=str(Path.home() / 'Android/Sdk/platform-tools/adb'))
parser.add_argument('--home-ip', required=True, help='Assigned physical RFC1918 address of this test host')
parser.add_argument('--tailnet-port', type=int, required=True, help='Unused Tailscale HTTPS port, owned only for this run')
parser.add_argument('--output', default='/tmp/lina-android-verification')
args = parser.parse_args()
if not re.fullmatch(r'emulator-\d+', args.serial):
    parser.error('Only disposable emulator serials are allowed, never a physical phone.')
OUTPUT = Path(args.output)
OUTPUT.mkdir(parents=True, exist_ok=True)
CHECKS = []
(OUTPUT / 'checks.json').write_text('[]')
(OUTPUT / 'result.json').unlink(missing_ok=True)
MODE_CONFIGS = {}
def report(message, **kwargs):
    print(message, **kwargs)
    if message.startswith('PASS '):
        CHECKS.append(message[5:])
        (OUTPUT / 'checks.json').write_text(json.dumps(CHECKS, indent=2))

os.umask(0o077)
TOKEN = 'lina-route-verification-only'
process = None
reverse_port = None
temp_handle = None
base = None


def adb(*values, binary=False):
    return subprocess.check_output([args.adb, '-s', args.serial, *map(str, values)], text=not binary)


def dump():
    for attempt in range(6):
        try:
            adb('shell', 'rm', '-f', '/sdcard/lina-qa-window.xml')
            adb('shell', 'uiautomator', 'dump', '/sdcard/lina-qa-window.xml')
            xml = adb('shell', 'cat', '/sdcard/lina-qa-window.xml')
            tree = ET.fromstring(xml)
            (OUTPUT / 'last-ui.xml').write_text(xml)
            return tree
        except (subprocess.CalledProcessError, ET.ParseError):
            if attempt == 5: raise
            time.sleep(.5)


def find(text=None, desc=None, contains=None, tree=None):
    for n in (tree if tree is not None else dump()).iter('node'):
        if (text is None or (n.get('text') == text or (desc is None and n.get('content-desc') == text))) and (desc is None or n.get('content-desc') == desc) and (contains is None or contains in n.get('text', '')):
            bounds = list(map(int, re.findall(r'\d+', n.get('bounds', ''))))
            if len(bounds) == 4 and bounds[2] > bounds[0] and bounds[3] > bounds[1]:
                return n
    return None


def wait_ui(text=None, desc=None, contains=None, timeout=20):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        n = find(text, desc, contains)
        if n is not None:
            return n
        time.sleep(.2)
    raise AssertionError(f'UI missing {text or desc or contains}')


def tap(text=None, desc=None, contains=None):
    try:
        n = wait_ui(text, desc, contains,timeout=4)
    except AssertionError:
        n = None
        for attempt in range(5):
            tree=dump()
            scroller=next((a for a in tree.iter('node') if a.get('scrollable')=='true' and a.get('class') in ('android.widget.ListView','android.widget.ScrollView','androidx.recyclerview.widget.RecyclerView')),None)
            if scroller is None:break
            x,y,x2,y2=map(int,re.findall(r'\d+',scroller.get('bounds')))
            adb('shell','input','swipe',(x+x2)//2,y+(y2-y)*3//4,(x+x2)//2,y+(y2-y)//4,'250')
            n=find(text,desc,contains)
            if n is not None:break
        if n is None:raise AssertionError(f'Cannot reach UI action {text or desc or contains}')
    x, y, x2, y2 = map(int, re.findall(r'\d+', n.get('bounds')))
    adb('shell', 'input', 'tap', (x+x2)//2, (y+y2)//2)
    return n


def type_text(value):
    adb('shell', 'input', 'text', shlex.quote(value.replace(' ', '%s')))


def fill(value, text=None, desc=None):
    node = tap(text, desc)
    adb('shell', 'input', 'keyevent', '123', *(['67'] * max(1, len(node.get('text', '')) + 2)))
    type_text(value)


def hide_keyboard():
    if 'mInputShown=true' in adb('shell', 'dumpsys', 'input_method'):
        adb('shell', 'input', 'keyevent', '4')


def pause_and_stop():
    """Wait for normal Activity pause/stop; an immediate force-stop skips callbacks."""
    adb('shell','input','keyevent','3')
    end=time.monotonic()+15
    while time.monotonic()<end:
        state=adb('shell','dumpsys','activity','activities')
        resumed=[line for line in state.splitlines() if 'topResumedActivity=' in line or 'mResumedActivity:' in line]
        if resumed and all('app.lina.android/' not in line for line in resumed):
            # Android flushes SharedPreferences queued work as the stopped
            # Activity finishes its lifecycle transition.
            time.sleep(1)
            adb('shell','am','force-stop','app.lina.android')
            return
        time.sleep(.2)
    raise AssertionError('Lina did not finish its normal background transition')


def menu(item):
    tap('Menu')
    tap(item)


def screenshot(name):
    (OUTPUT / (name + '.png')).write_bytes(adb('exec-out', 'screencap', '-p', binary=True))


def fixture_command(command):
    process.stdin.write(command + '\n'); process.stdin.flush()
    line = process.stdout.readline()
    if not line: raise AssertionError('Fixture exited; see daemon.log')
    return json.loads(line)

def api(path):
    request = urllib.request.Request(base + '/api' + path, headers={'Authorization': 'Bearer ' + TOKEN})
    with urllib.request.urlopen(request, timeout=10) as response: return json.load(response)

proxy_owned = False
try:
    assert 1 <= args.tailnet_port <= 65535
    status=json.loads(subprocess.check_output(['tailscale','status','--json'],text=True))
    name=status['Self']['DNSName'].rstrip('.')
    email=status['User'][str(status['Self']['UserID'])]['LoginName']
    serve=json.loads(subprocess.check_output(['tailscale','serve','status','--json'],text=True))
    assert str(args.tailnet_port) not in serve.get('TCP',{}), 'Chosen Tailscale port already used'
    temp_handle = tempfile.TemporaryDirectory(prefix='lina-route-ui-')
    temp=Path(temp_handle.name)
    project=temp/'project';project.mkdir()
    subprocess.check_call(['git','init','-q',str(project)])
    tailnet_url=f'https://{name}:{args.tailnet_port}'
    script="""
import { startServer } from './src/server/daemon.ts';
import { LinaClient } from './src/shared/client.ts';
import { createInterface } from 'node:readline';
let server, client, port=0, session, token=process.env.QA_TOKEN;
async function start() {
 server=await startServer({port,token});port=server.port;
 client=new LinaClient({baseUrl:'http://127.0.0.1:'+port,token});
 await client.putSettings({remoteOrigins:[process.env.QA_TAILNET_URL],tailnetUsers:[process.env.QA_EMAIL]});
 await client.putHome({enabled:true,host:process.env.QA_HOME_IP});
 const project=await client.addProject({path:process.env.QA_PROJECT,name:'network-switch-fixture'});
 session=(await client.sessions()).find(s=>s.title==='Network switch conversation');
 if(!session)session=await client.createSession({projectId:project.id,title:'Network switch conversation',config:{mode:'solo',developer:'codex',reviewer:'claude',workspaceMode:'direct',interactionMode:'chat'}});
 server.manager.events.append(session.id,'message','lina',{id:'route-marker',kind:'notice',text:'Retained network conversation marker'});
 console.log(JSON.stringify({port,session:session.id,bootstrapToken:token,bundle:await client.connection()}));
}
await start();
createInterface({input:process.stdin}).on('line',async line=>{
 try {
  if(line==='restart'){await server.close();token+='-rotated';await start();}
  else console.log(JSON.stringify({ok:true}));
 } catch(e){console.error(e);process.exit(1);}
});
for(const sig of ['SIGTERM','SIGINT'])process.on(sig,async()=>{await server.close();process.exit(0)});
"""
    log=open(OUTPUT/'daemon.log','w')
    process=subprocess.Popen(['node','--import','tsx','--input-type=module','-e',script],cwd=ROOT,
        env=dict(os.environ,LINA_HOME=str(temp/'home'),LINA_MOCK='1',QA_TOKEN=TOKEN,
            QA_HOME_IP=args.home_ip,QA_PROJECT=str(project),QA_TAILNET_URL=tailnet_url,QA_EMAIL=email),
        stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=log,text=True)
    line=process.stdout.readline()
    assert line, 'Fixture did not start; see daemon.log'
    info=json.loads(line);base='http://127.0.0.1:'+str(info['port'])
    subprocess.check_call(['tailscale','serve','--bg','--https='+str(args.tailnet_port),'unix:'+str(temp/'home/tailnet.sock')],stdout=subprocess.DEVNULL)
    proxy_owned=True
    adb('shell','svc','wifi','enable');adb('shell','svc','data','enable')
    adb('install','-r',str(ROOT/'lina.apk'))
    expected_sha=hashlib.sha256((ROOT/'lina.apk').read_bytes()).hexdigest()
    path=next(p.removeprefix('package:').strip() for p in adb('shell','pm','path','app.lina.android').splitlines() if p.endswith('/base.apk'))
    adb('pull',path,str(OUTPUT/'installed-lina.apk'))
    assert hashlib.sha256((OUTPUT/'installed-lina.apk').read_bytes()).hexdigest()==expected_sha
    adb('shell','pm','clear','app.lina.android')
    adb('shell','am','start','-n','app.lina.android/.MainActivity')
    wait_ui('Connect to LINA')
    fill(tailnet_url,desc='LINA address');hide_keyboard();tap('CONNECT')
    wait_ui('Home Wi-Fi · Connected',timeout=40)
    report('PASS Authenticated Tailscale pairing automatically prefers pinned home Wi-Fi')
    tap(contains='Network switch conversation')
    wait_ui(contains='Retained network conversation marker')
    fill('Keep-draft-across-networks',desc='Message');hide_keyboard()
    screenshot('home-with-draft')
    adb('shell','svc','wifi','disable')
    wait_ui('Tailscale · Connected',timeout=40)
    assert wait_ui(desc='Message').get('text')=='Keep-draft-across-networks'
    wait_ui(contains='Retained network conversation marker')
    report('PASS Wi-Fi off selects real authenticated Tailscale without losing session or draft')
    screenshot('away-with-draft')
    adb('shell','svc','wifi','enable')
    wait_ui('Home Wi-Fi · Connected',timeout=40)
    assert wait_ui(desc='Message').get('text')=='Keep-draft-across-networks'
    report('PASS Returning home automatically prefers verified Wi-Fi and retains draft')
    subprocess.check_call(['tailscale','serve','--https='+str(args.tailnet_port),'off'],stdout=subprocess.DEVNULL)
    proxy_owned=False
    pause_and_stop()
    adb('shell','am','start','-n','app.lina.android/.MainActivity')
    wait_ui('Home Wi-Fi · Connected',timeout=40)
    assert wait_ui(desc='Message').get('text')=='Keep-draft-across-networks'
    wait_ui(contains='Retained network conversation marker')
    report('PASS Cold relaunch uses saved home pairing with Tailscale route unavailable')
    restarted=fixture_command('restart')
    assert restarted['bundle']==info['bundle'], 'Pairing changed across daemon restart'
    assert restarted['bootstrapToken']!=info['bootstrapToken']
    TOKEN=restarted['bootstrapToken']
    pause_and_stop();adb('shell','am','start','-n','app.lina.android/.MainActivity')
    wait_ui('Home Wi-Fi · Connected',timeout=40)
    assert wait_ui(desc='Message').get('text')=='Keep-draft-across-networks'
    assert api('/sessions/'+info['session'])['session']['id']==info['session']
    report('PASS Daemon restart retains home credential, certificate, session and draft')
    menu('Open web interface')
    wait_ui(contains='Two minds, one codebase.',timeout=35)
    screenshot('home-web')
    report('PASS Optional web interface renders over the paired home TLS certificate')
    adb('shell','input','keyevent','4')
    wait_ui('Home Wi-Fi · Connected',timeout=40)
    menu('Connection');wait_ui(contains='Automatic connection is ready')
    tap('FORGET DEVICE')
    wait_ui(contains='This device is forgotten.',timeout=20)
    pause_and_stop();adb('shell','am','start','-n','app.lina.android/.MainActivity')
    wait_ui('Connect to LINA')
    report('PASS Forget removes both saved routes and cannot resurrect pairing on relaunch')
    assert hashlib.sha256((ROOT/'lina.apk').read_bytes()).hexdigest()==expected_sha
    crash=adb('logcat','-b','crash','-d')
    (OUTPUT/'crash.log').write_text(crash)
    assert 'app.lina.android' not in crash, crash
    (OUTPUT/'result.json').write_text(json.dumps({'checks':CHECKS,'apkSha256':expected_sha,'tailnetProxy':tailnet_url,'homeIp':args.home_ip,'emulator':args.serial,'api':adb('shell','getprop','ro.build.version.sdk').strip()},indent=2))
finally:
    if proxy_owned: subprocess.run(['tailscale','serve','--https='+str(args.tailnet_port),'off'],stdout=subprocess.DEVNULL)
    if process is not None:
        process.terminate()
        try: process.wait(timeout=20)
        except subprocess.TimeoutExpired: process.kill();process.wait()
    if temp_handle:temp_handle.cleanup()
