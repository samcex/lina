#!/usr/bin/env python3
"""Exercise the installed native app on a disposable emulator against an isolated daemon.

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
parser.add_argument('--recovery-only', action='store_true', help='Run login, outage/recovery and Forget on a fresh isolated fixture')
parser.add_argument('--extended', action='store_true', help='Also run work in every mode and pause/cancel/resume/approval/waiver checks')
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

TOKEN = 'lina-emulator-verification-only'
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


def api(path, method='GET', body=None):
    request = urllib.request.Request(base + '/api' + path, data=None if body is None else json.dumps(body).encode(),
        headers={'Authorization': 'Bearer ' + TOKEN, 'Content-Type': 'application/json'}, method=method)
    with urllib.request.urlopen(request, timeout=20) as response:
        return json.load(response)


def wait_session(sid, status='completed', timeout=120, message=None, after_seq=0):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        snap = api('/sessions/' + sid)
        s = snap['session']
        arrived = message is None or any(
            e['seq'] > after_seq and e['type'] == 'message' and e['actor'] == 'user'
            and e['data']['text'] == message for e in snap['events'])
        if arrived and s['status'] == status:
            return s
        if arrived and s['status'] == 'failed':
            raise AssertionError('Session failed: ' + json.dumps(snap))
        time.sleep(.25)
    raise AssertionError('Session did not reach ' + status)


def send_current(sid, text, status='completed'):
    """Prove this new UI message arrived before accepting a terminal status."""
    field = wait_ui(desc='Message')
    assert field.get('text') == text, ('Unexpected composer contents', field.get('text'), text)
    baseline = api('/sessions/' + sid)['session']['lastSeq']
    tap('Send')
    return wait_session(sid, status, message=text, after_seq=baseline)


def latest_session():
    return max(api('/sessions'), key=lambda s: s['createdAt'])


def create_native(title, mode='pair', isolated=False, workflow=False, max_rounds=None):
    menu('New conversation')
    tap('android-emulator-fixture')
    fill(title, desc='Conversation title (optional)')
    hide_keyboard()
    if mode != 'pair':
        tap('pair')
        tap(mode)
    if workflow and mode not in ('parallel','compete'): tap('Structured workflow')
    if max_rounds is not None:
        fill(str(max_rounds),desc='Maximum review rounds');hide_keyboard()
    if isolated and mode not in ('parallel', 'compete'):
        tap('Isolated workspace')
    tap('CREATE')
    wait_ui(contains=title)
    session = latest_session()
    assert session['title'] == title, session
    assert session['config']['mode'] == mode, session
    if isolated or mode in ('parallel', 'compete'):
        assert session['config']['workspaceMode'] == 'isolated', session
        assert session['config']['interactionMode'] == 'workflow', session
    MODE_CONFIGS[title] = session['config']
    return session['id']


try:
    assert adb('shell', 'getprop', 'sys.boot_completed').strip() == '1', 'Emulator not booted'
    run_started = adb('shell', 'date', shlex.quote('+%m-%d %H:%M:%S.000')).strip()
    temp_handle = tempfile.TemporaryDirectory(prefix='lina-native-emulator-')
    temp = Path(temp_handle.name)
    log = open(OUTPUT / 'daemon.log', 'w')
    env = dict(os.environ, LINA_HOME=str(temp/'home'), LINA_MOCK='1', LINA_MOCK_DELAY_MS='400')
    script = """import {startServer} from './src/server/daemon.ts';
import {MockAdapter} from './src/server/agents/mock.ts';
import {setAdapterOverride} from './src/server/agents/index.ts';
const s=await startServer({port:0,token:process.env.LINA_QA_TOKEN});
setAdapterOverride((agent,{sessionId})=>{
  const title=sessionId?s.manager.getSession(sessionId).title:'';
  return new MockAdapter(agent,{
    ...(title==='Native waiver'?{scenario:'insist'}:{}),
    ...(title==='Native isolated pair'?{holdMs:{plan:15000,implement:15000,revise:15000,chat:15000,consult:15000}}:{})
  });
});
const addAttachment=s.manager.addAttachment.bind(s.manager);
s.manager.addAttachment=async(...args)=>{await new Promise(resolve=>setTimeout(resolve,10000));return addAttachment(...args);};
import {createInterface} from 'node:readline';
createInterface({input:process.stdin}).on('line',line=>{
  const command=JSON.parse(line), id=command.session;
  if(command.op==='history') {
    if(!command.tail)s.manager.events.append(id,'message','lina',{id:'native-history-first',kind:'notice',text:'Earliest native history marker'});
    for(let i=0;i<(command.tail?4500:2100);i++) {
      if(command.tail && [500,2500].includes(i))s.manager.events.append(id,'message','lina',{id:'native-catch-up-'+i,kind:'notice',text:i===500?'Early native catch-up marker':'Middle native catch-up marker'});
      s.manager.events.append(id,'activity','lina',{agent:'lina',id:'native-history-'+i,kind:'note',title:'Historical event '+i,state:'ok',source:'observed'});
    }
    s.manager.events.append(id,'message','lina',{id:'native-history-last',kind:'notice',text:command.tail?'Final native catch-up marker':'Latest native history marker'});
    console.log(JSON.stringify({seeded:true}));
  } else if(command.op==='live-start') {
    s.manager.events.emitEphemeral(id,'agent.status','codex',{agent:'codex',status:'writing',role:'developer'});
    s.manager.events.emitEphemeral(id,'stream','codex',{agent:'codex',msgId:'native-controlled-live',delta:'Native stream initial marker'});
    console.log(JSON.stringify({live:true}));
  } else if(command.op==='live-progress') {
    s.manager.events.emitEphemeral(id,'stream','codex',{agent:'codex',msgId:'native-controlled-live',delta:' Native stream progressed marker'});
    s.manager.events.append(id,'activity','codex',{agent:'codex',id:'native-controlled-action',kind:'command',title:'Native observed progress marker',state:'running',source:'observed'});
    console.log(JSON.stringify({live:true}));
  } else if(command.op==='live-end') {
    s.manager.events.emitEphemeral(id,'stream.end','codex',{agent:'codex',msgId:'native-controlled-live'});
    s.manager.events.append(id,'message','codex',{id:'native-live-finished',kind:'chat',text:'Native completed update marker'});
    s.manager.events.emitEphemeral(id,'agent.status','codex',{agent:'codex',status:'idle',role:'developer'});
    console.log(JSON.stringify({live:true}));
  }
});
console.log(JSON.stringify({port:s.port}));
for(const sig of ['SIGTERM','SIGINT'])process.on(sig,async()=>{await s.close();process.exit(0)});"""
    process = subprocess.Popen(['node', '--import', 'tsx', '--input-type=module', '-e', script], cwd=ROOT,
        env=dict(env, LINA_QA_TOKEN=TOKEN), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log, text=True)
    line = process.stdout.readline()
    if not line:
        raise AssertionError('QA daemon failed to start; see daemon.log')
    port = json.loads(line)['port']
    reverse_port = port
    base = f'http://127.0.0.1:{port}'
    adb('reverse', f'tcp:{port}', f'tcp:{port}')
    installed_apk_sha=hashlib.sha256((ROOT/'lina.apk').read_bytes()).hexdigest()
    adb('install', '-r', str(ROOT/'lina.apk'))
    paths=[line.removeprefix('package:').strip() for line in adb('shell','pm','path','app.lina.android').splitlines() if line.startswith('package:')]
    installed_path=next(path for path in paths if path.endswith('/base.apk'))
    installed_copy=OUTPUT/'installed-lina.apk'
    adb('pull',installed_path,str(installed_copy))
    assert hashlib.sha256(installed_copy.read_bytes()).hexdigest()==installed_apk_sha, 'Installed APK differs from the selected package'
    adb('shell', 'pm', 'clear', 'app.lina.android')
    adb('shell', 'am', 'start', '-n', 'app.lina.android/.MainActivity')
    wait_ui('Connect to LINA')
    fill('http://example.com:1234/', desc='LINA address')
    hide_keyboard(); tap('CONNECT')
    wait_ui('Connect to LINA')
    assert not api('/sessions'), 'Invalid URL must not create anything'
    fill(base+'/#token=wrong', desc='LINA address')
    hide_keyboard(); tap('CONNECT')
    wait_ui(contains='Sign-in expired')
    menu('Connection')
    fill(base+'/#token='+TOKEN, desc='LINA address')
    hide_keyboard(); tap('CONNECT')
    wait_ui(contains='· Connected')
    report('PASS invalid-origin refusal, 401 feedback and reconnect', flush=True)
    if args.recovery_only:
        project=api('/projects','POST',{'path':str(temp/'project'),'name':'android-emulator-fixture','create':True,'initGit':True})
        recovery=api('/sessions','POST',{'projectId':project['id'],'title':'Native recovery fixture','config':{'mode':'solo'}})
        tap(contains='Native recovery fixture')
        fill('Retain-draft-through-outage',desc='Message');hide_keyboard()
    else:
        menu('Add project');fill(str(temp/'project'),desc='Absolute project path on the host')
        hide_keyboard();tap('Create directory and initialize Git if needed');tap('ADD')
        wait_ui('Choose project')
        registered=api('/projects')
        assert len(registered)==1 and registered[0]['path']==str(temp/'project'),registered
        assert (temp/'project/.git').is_dir(), 'Native registration must initialize the requested repository'
        tap('CANCEL')
        api('/projects/'+registered[0]['id'],'PATCH',{'name':'android-emulator-fixture'})
        report('PASS native first-project registration, directory creation and Git initialization',flush=True)
        sid = create_native('Native Android QA')
        fill('Hello from native Android', desc='Message')
        send_current(sid,'Hello from native Android')
        wait_ui(contains='This project exposes a hello(name) function')
        screenshot('native-chat')
        report('PASS native project selection, creation and chat response', flush=True)
        tap('Sessions');wait_ui('Conversations')
        fill('Native Android QA',desc='Search conversations');hide_keyboard()
        time.sleep(3)
        assert wait_ui(desc='Search conversations').get('text')=='Native Android QA', 'Polling reset search input'
        wait_ui(contains='Native Android QA')
        tap('Active');wait_ui('No matches')
        tap('Needs you');wait_ui('No matches')
        tap('All');wait_ui(contains='Native Android QA')
        fill('no-such-conversation-qa',desc='Search conversations');hide_keyboard();wait_ui('No matches')
        tap('Clear filters');wait_ui(contains='Native Android QA')
        tap(contains='Native Android QA');wait_ui(contains='This project exposes a hello(name) function')
        report('PASS native conversation search, status filters, no-match reset and focus across polling',flush=True)

        before=api('/sessions/'+sid)['session']['config']
        menu('Models and mode');fill('native-model-patch-proof',desc='Codex model');hide_keyboard();tap('SAVE')
        end=time.monotonic()+15
        while api('/sessions/'+sid)['session']['config']['models']['codex']['model']!='native-model-patch-proof' and time.monotonic()<end:time.sleep(.2)
        saved=api('/sessions/'+sid)['session']['config']
        assert saved['models']['codex']['model']=='native-model-patch-proof',saved
        assert saved['models']['codex'].get('effort')==before['models']['codex'].get('effort'),saved
        menu('Models and mode');fill(before['models']['codex']['model'],desc='Codex model');hide_keyboard();tap('SAVE')
        end=time.monotonic()+15
        while api('/sessions/'+sid)['session']['config']['models']['codex']['model']!=before['models']['codex']['model'] and time.monotonic()<end:time.sleep(.2)
        assert api('/sessions/'+sid)['session']['config']['models']['codex']==before['models']['codex']
        report('PASS native model PATCH', flush=True)
        fixture = temp/'native-attachment.txt';fixture.write_text('Native attachment bytes: π\n')
        adb('push',str(fixture),'/sdcard/Download/native-attachment.txt')
        adb('shell','am','broadcast','-a','android.intent.action.MEDIA_SCANNER_SCAN_FILE','-d','file:///sdcard/Download/native-attachment.txt')
        tap('Attach')
        # DocumentsUI labels differ between AOSP and Google emulator images.
        node = find('native-attachment.txt')
        if node is None:
            drawer = find(desc='Show roots')
            if drawer is None: drawer = find(desc='Open navigation drawer')
            if drawer is not None:
                x,y,x2,y2=map(int,re.findall(r'\d+',drawer.get('bounds')));adb('shell','input','tap',(x+x2)//2,(y+y2)//2)
            tap('Downloads')
        tap('native-attachment.txt')
        # Some AOSP DocumentsUI builds expose file rows as keyboard-focusable
        # gesture containers rather than clickable accessibility nodes.
        picker = dump()
        if any(n.get('package')=='com.android.documentsui' for n in picker.iter('node')):
            for attempt in range(18):
                focused = next((n for n in picker.iter('node') if n.get('focused')=='true' and n.get('resource-id','').endswith('/item_root')), None)
                if focused is not None:
                    adb('shell','input','keyevent','66');break
                adb('shell','input','keyevent','61');picker=dump()
        wait_ui(contains='Uploading 1 file')
        assert find('Send').get('enabled')=='false', 'Send must wait for the chosen attachment'
        # Rotation during the actual delayed HTTP upload must retain its completion.
        adb('shell','settings','put','system','accelerometer_rotation','0')
        adb('shell','settings','put','system','user_rotation','1')
        adb('shell','settings','put','system','user_rotation','0')
        wait_ui(contains='Attached 1 file')
        report('PASS native upload blocks Send and survives in-flight rotation',flush=True)
        fill('Hello with attachment',desc='Message')
        # Rotate while the draft owns an uploaded file, then restore portrait.
        adb('shell','settings','put','system','accelerometer_rotation','0')
        adb('shell','settings','put','system','user_rotation','1')
        wait_ui('Hello with attachment',desc='Message');wait_ui(contains='Attached 1 file')
        adb('shell','settings','put','system','user_rotation','0')
        wait_ui('Hello with attachment',desc='Message')
        # Save via a normal Activity pause then cold relaunch; credentials and draft survive.
        pause_and_stop()
        adb('shell','am','start','-n','app.lina.android/.MainActivity')
        wait_ui('Hello with attachment',desc='Message')
        wait_ui(contains='Attached 1 file')
        report('PASS native draft and attachment cold-relaunch persistence',flush=True)
        # Same-origin token repair must preserve this failed-send draft and its files.
        menu('Connection');fill(base+'/#token=wrong',desc='LINA address');hide_keyboard();tap('CONNECT')
        wait_ui(contains='Sign-in expired');wait_ui('Hello with attachment',desc='Message')
        menu('Connection');fill(base+'/#token='+TOKEN,desc='LINA address');hide_keyboard();tap('CONNECT')
        wait_ui('Hello with attachment',desc='Message');wait_ui(contains='Attached 1 file')
        report('PASS same-origin credential repair preserves the unsent draft and files',flush=True)
        send_current(sid,'Hello with attachment')
        snap=api('/sessions/'+sid)
        sent=[e for e in snap['events'] if e['type']=='message' and e['actor']=='user' and e['data']['text']=='Hello with attachment']
        assert len(sent)==1 and sent[0]['data']['attachments'][0]['name']=='native-attachment.txt',sent
        assert Path(sent[0]['data']['attachments'][0]['path']).read_bytes()==fixture.read_bytes()
        report('PASS native picker delivers exact UTF-8 attachment bytes once',flush=True)
        fill('Update documentation only',desc='Message');send_current(sid,'Update documentation only')
        menu('Changes and undo');tap(contains='Turn ')
        wait_ui(contains='NOTES.md');tap('UNDO TURN');tap('CONTINUE')
        end=time.monotonic()+15
        while (temp/'project/NOTES.md').exists() and time.monotonic()<end:time.sleep(.2)
        assert not (temp/'project/NOTES.md').exists(), 'Undo did not restore files'
        report('PASS native writing-turn diff and undo',flush=True)
        menu('Previews');tap('Start preview')
        # Fill the only visible field using its label.
        fill('node -e "console.log(\'native-preview-log-marker\');require(\'http\').createServer((q,s)=>s.end(\'native-preview\')).listen(process.env.PORT,\'127.0.0.1\')"',desc='Foreground command, e.g. npm run dev -- --port {port}')
        hide_keyboard();tap('START')
        end=time.monotonic()+15
        while time.monotonic()<end:
            previews=api('/sessions/'+sid+'/previews')
            if previews and previews[0]['status']=='running':break
            time.sleep(.2)
        assert previews and previews[0]['status']=='running',previews
        with urllib.request.urlopen(previews[0]['url']) as res:assert res.read()==b'native-preview'
        menu('Previews');tap(contains='running ·');wait_ui(contains='native-preview-log-marker');tap('STOP')
        end=time.monotonic()+15
        while api('/sessions/'+sid+'/previews')[0]['status']!='stopped' and time.monotonic()<end:time.sleep(.2)
        assert api('/sessions/'+sid+'/previews')[0]['status']=='stopped'
        report('PASS native preview start, actual HTTP readiness, log inspection and stop',flush=True)
        fill('Implement a greeting function with tests',desc='Message');send_current(sid,'Implement a greeting function with tests')
        menu('Agent activity');tap('codex')
        for command,marker in [('live-start','Native stream initial marker'),('live-progress','Native stream progressed marker'),('live-end','Native completed update marker')]:
            process.stdin.write(json.dumps({'op':command,'session':sid})+'\n');process.stdin.flush()
            assert json.loads(process.stdout.readline())['live']
            wait_ui(contains=marker)
            if command=='live-progress':wait_ui(contains='Native observed progress marker')
        wait_ui(contains='Latest update')
        screenshot('native-live-activity');tap('CLOSE')
        report('PASS filtered native activity receives controlled stream, observed action and completed updates without reopening',flush=True)
        menu('Files');tap('hello.js');wait_ui(contains='function hello');tap('CLOSE')
        report('PASS native project file listing and actual source contents',flush=True)
        # All advertised modes must create with compatible workspace/interaction policy.
        for mode in ['solo','architect','parallel','compete','custom']:
            mode_sid=create_native('Native '+mode,mode,workflow=args.extended)
            if args.extended:
                fill('Implement a greeting function with tests',desc='Message')
                send_current(mode_sid,'Implement a greeting function with tests','awaiting_approval' if mode in ('parallel','compete') else 'completed')
                if mode=='compete':
                    menu('Candidate comparison');wait_ui(contains='Blocking findings:');tap('CLOSE')
                    menu('Changes and undo');tap('codex candidate diff');wait_ui(contains='hello.js');tap('CLOSE')
                    menu('Session controls');tap('Choose Codex')
                    end=time.monotonic()+15
                    while api('/sessions/'+mode_sid)['session'].get('chosenVariant')!='codex' and time.monotonic()<end:time.sleep(.2)
                    assert api('/sessions/'+mode_sid)['session']['chosenVariant']=='codex'
                if mode in ('parallel','compete'):
                    menu('Session controls');tap('Keep branch');tap('CONTINUE');wait_session(mode_sid,'approved')
                suffix=' with candidate comparison/selection and branch approval' if mode=='compete' else ' with branch approval' if mode=='parallel' else ''
                report('PASS actual native '+mode+' workflow'+suffix,flush=True)
        isolated_sid=create_native('Native isolated pair','pair',True)
        if args.extended:
            fill('Implement greeting. Hold native control test',desc='Message');send_current(isolated_sid,'Implement greeting. Hold native control test','running')
            menu('Session controls');tap('Pause');wait_session(isolated_sid,'paused')
            menu('Session controls');tap('Resume')
            wait_session(isolated_sid,'running')
            menu('Session controls');tap('Cancel');wait_session(isolated_sid,'cancelled')
            menu('Session controls');tap('Resume');wait_session(isolated_sid,'awaiting_approval')
            menu('Session controls');tap('Keep branch');tap('CONTINUE');wait_session(isolated_sid,'approved')
            report('PASS native pause/resume/cancel/recovery and isolated branch approval',flush=True)
            waiver_sid=create_native('Native waiver','pair',True,max_rounds=1)
            fill('Implement greeting. Native waiver test',desc='Message');send_current(waiver_sid,'Implement greeting. Native waiver test','awaiting_approval')
            findings=api('/sessions/'+waiver_sid)['findings']
            waived=0
            for f in findings:
                if f['status'] not in ('open','escalated','disputed','fixed'):continue
                menu('Findings');tap(contains=f['id']+' ·');tap('WAIVE FINDING');tap('CONTINUE')
                end=time.monotonic()+15
                while not any(x['id']==f['id'] and x['status']=='waived' for x in api('/sessions/'+waiver_sid)['findings']) and time.monotonic()<end:time.sleep(.2)
                assert any(x['id']==f['id'] and x['status']=='waived' for x in api('/sessions/'+waiver_sid)['findings'])
                waived+=1
            assert waived>0, 'Waiver fixture must actually waive at least one finding'
            report('PASS native finding details and recorded human waiver',flush=True)
            before_settings=api('/settings')
            menu('Settings');tap('Full developer access');tap('SAVE')
            end=time.monotonic()+15
            while api('/settings')['accessMode']==before_settings['accessMode'] and time.monotonic()<end:time.sleep(.2)
            assert api('/settings')['accessMode']!=before_settings['accessMode']
            menu('Settings');tap('Full developer access');tap('SAVE')
            end=time.monotonic()+15
            while api('/settings')['accessMode']!=before_settings['accessMode'] and time.monotonic()<end:time.sleep(.2)
            assert api('/settings')['accessMode']==before_settings['accessMode']
            report('PASS native host Settings save and restore',flush=True)
            delete_sid=create_native('Native delete preserves project','solo')
            marker=temp/'project/native-owner-marker.txt';marker.write_text('preserve owner content')
            menu('Delete conversation');tap('CONTINUE')
            end=time.monotonic()+15
            while any(s['id']==delete_sid for s in api('/sessions')) and time.monotonic()<end:time.sleep(.2)
            assert not any(s['id']==delete_sid for s in api('/sessions'))
            assert marker.read_text()=='preserve owner content'
            report('PASS native delete removes conversation and preserves direct project files',flush=True)
        report('PASS all six modes, custom team payload and isolated-workflow enforcement',flush=True)
        # Seed >2000 real persisted events: older messages must remain reachable.
        history_sid=create_native('Native long history','solo')
        process.stdin.write(json.dumps({'op':'history','session':history_sid})+'\n');process.stdin.flush()
        assert json.loads(process.stdout.readline())['seeded']
        tap('Sessions');tap(contains='Native long history')
        wait_ui(contains='Latest native history marker');wait_ui('Load earlier messages')
        tap('Load earlier messages')
        # Scrolling upward reaches the prepended marker; search should jump there too.
        menu('Search conversations');fill('Earliest native history marker',desc='Search conversation messages');hide_keyboard();tap('SEARCH')
        tap(contains='Earliest native history marker');wait_ui(contains='Earliest native history marker')
        process.stdin.write(json.dumps({'op':'history','session':history_sid,'tail':True})+'\n');process.stdin.flush()
        assert json.loads(process.stdout.readline())['seeded']
        wait_ui(contains='Final native catch-up marker',timeout=40)
        transcript=dump()
        for marker in ['Early native catch-up marker','Middle native catch-up marker','Final native catch-up marker']:
            assert any(marker in n.get('text','') for n in transcript.iter('node')), 'Skipped catch-up page: '+marker
        report('PASS >2000-event backward history, old search-hit navigation and contiguous >4000-event poll catch-up',flush=True)
    # Force an outage at the actual transport, restore it, verify automatic retry.
    adb('reverse','--remove',f'tcp:{port}')
    os.kill(process.pid,signal.SIGSTOP)
    wait_ui(contains='Offline ·',timeout=40)
    adb('reverse',f'tcp:{port}',f'tcp:{port}')
    os.kill(process.pid,signal.SIGCONT)
    wait_ui(contains='· Connected',timeout=40)
    if args.recovery_only:
        assert wait_ui(desc='Message').get('text')=='Retain-draft-through-outage'
        wait_ui(contains='Native recovery fixture')
    report('PASS disconnected transport feedback and automatic foreground recovery',flush=True)
    menu('Connection');tap('FORGET DEVICE')
    wait_ui('This device is forgotten.')
    pause_and_stop();adb('shell','am','start','-n','app.lina.android/.MainActivity')
    wait_ui('Connect to LINA')
    assert find(text=base+'/') is None
    report('PASS forget clears native credentials and relaunch requires sign-in',flush=True)
    crash=adb('logcat','-d','-b','crash','-T',run_started)
    (OUTPUT/'crash.log').write_text(crash)
    assert 'app.lina.android' not in crash,crash
    screenshot('native-forgotten')
    assert hashlib.sha256((ROOT/'lina.apk').read_bytes()).hexdigest()==installed_apk_sha, 'Selected APK changed during verification'
    (OUTPUT/'result.json').write_text(json.dumps({'serial':args.serial,'api':adb('shell','getprop','ro.build.version.sdk').strip(),'passed':True,'recoveryOnly':args.recovery_only,'checks':CHECKS,'modeConfigs':MODE_CONFIGS,'crashLogEmptyForLina':True,'apkSha256':installed_apk_sha,'installedApkPath':installed_path},indent=2))
    report('PASS Android native emulator verification; evidence: '+str(OUTPUT),flush=True)
finally:
    if sys.exc_info()[0] is not None and process is not None and process.poll() is None and base is not None:
        try:
            (OUTPUT/'failed-sessions.json').write_text(json.dumps([api('/sessions/'+s['id']) for s in api('/sessions')],indent=2))
            screenshot('failed-state')
        except Exception:
            pass
    if reverse_port is not None:
        subprocess.run([args.adb,'-s',args.serial,'reverse','--remove',f'tcp:{reverse_port}'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    if process is not None:
        if process.poll() is None:
            os.kill(process.pid,signal.SIGCONT)
            if base is not None:
                try:
                    for session in api('/sessions'):
                        for preview in api('/sessions/'+session['id']+'/previews'):
                            if preview['status'] in ('running','starting'):
                                api('/sessions/'+session['id']+'/previews/'+preview['id']+'/stop','POST',{})
                except Exception:
                    pass
        process.terminate()
        try:process.wait(timeout=20)
        except subprocess.TimeoutExpired:process.kill();process.wait()

    if temp_handle is not None: temp_handle.cleanup()
