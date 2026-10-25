#!/usr/bin/env python3
"""Run native UI against an explicitly supplied disposable real-provider fixture.

Requires a live fixture info.json created for QA, with repo/home under /tmp.
Only emulator serials are accepted. This consumes provider usage and changes only
that disposable fixture and the emulator's Lina app storage.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shlex
import subprocess
import time
import urllib.request
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--serial', required=True)
p.add_argument('--fixture', required=True, type=Path)
p.add_argument('--output', type=Path, default=Path('/tmp/lina-native-real-verification'))
p.add_argument('--adb', default=str(Path.home()/'Android/Sdk/platform-tools/adb'))
a = p.parse_args()
if not re.fullmatch(r'emulator-\d+', a.serial): p.error('A disposable emulator is required')
info = json.loads(a.fixture.read_text())
repo = Path(info['repo']).resolve()
home = Path(info['home']).resolve()
if not str(repo).startswith('/tmp/') or not str(home).startswith('/tmp/'):
    p.error('Only disposable /tmp fixtures may be changed')
base = 'http://127.0.0.1:' + str(int(info['port']))
token, sid = info['token'], info['session']
a.output.mkdir(parents=True, exist_ok=True)
checks = []
(a.output/'checks.json').write_text('[]')
(a.output/'result.json').unlink(missing_ok=True)

def adb(*args, binary=False):
    return subprocess.check_output([a.adb, '-s', a.serial, *map(str,args)], text=not binary)

def api(path):
    req = urllib.request.Request(base+'/api'+path, headers={'Authorization':'Bearer '+token})
    with urllib.request.urlopen(req,timeout=20) as r: return json.load(r)

def dump():
    for attempt in range(6):
        try:
            adb('shell','rm','-f','/sdcard/lina-real-ui.xml')
            adb('shell','uiautomator','dump','/sdcard/lina-real-ui.xml')
            xml = adb('shell','cat','/sdcard/lina-real-ui.xml')
            tree=ET.fromstring(xml)
            (a.output/'last-ui.xml').write_text(xml)
            return tree
        except (subprocess.CalledProcessError,ET.ParseError):
            if attempt==5:raise
            time.sleep(.5)

def find(text=None,desc=None,contains=None):
    for n in dump().iter('node'):
        if (text is None or n.get('text')==text) and (desc is None or n.get('content-desc')==desc) and (contains is None or contains in n.get('text','')):
            q=list(map(int,re.findall(r'\d+',n.get('bounds',''))))
            if len(q)==4 and q[2]>q[0] and q[3]>q[1]: return n
    return None

def wait(text=None,desc=None,contains=None,timeout=30):
    end=time.monotonic()+timeout
    while time.monotonic()<end:
        n=find(text,desc,contains)
        if n is not None:return n
        time.sleep(.25)
    raise AssertionError('Missing native UI '+str((text,desc,contains)))

def tap(text=None,desc=None,contains=None):
    try:n=wait(text,desc,contains,timeout=4)
    except AssertionError:
        n=None
        for _ in range(8):
            scroller=next((v for v in dump().iter('node') if v.get('scrollable')=='true' and v.get('class') in ('android.widget.ListView','android.widget.ScrollView','androidx.recyclerview.widget.RecyclerView')),None)
            if scroller is None:break
            x,y,x2,y2=map(int,re.findall(r'\d+',scroller.get('bounds')))
            adb('shell','input','swipe',(x+x2)//2,y+(y2-y)*3//4,(x+x2)//2,y+(y2-y)//4,'250')
            n=find(text,desc,contains)
            if n is not None:break
        if n is None:raise AssertionError('Cannot reach native UI '+str((text,desc,contains)))
    x,y,x2,y2=map(int,re.findall(r'\d+',n.get('bounds')))
    adb('shell','input','tap',(x+x2)//2,(y+y2)//2)

def fill(value,desc):
    tap(desc=desc)
    adb('shell','input','keyevent','123',*(['67']*200))
    adb('shell','input','text',shlex.quote(value.replace(' ','%s')))

def hide_keyboard():
    if 'mInputShown=true' in adb('shell','dumpsys','input_method'):adb('shell','input','keyevent','4')

def menu(item):
    tap('Menu');tap(item)

def screenshot(name):
    (a.output/(name+'.png')).write_bytes(adb('exec-out','screencap','-p',binary=True))

def reveal_transcript(contains):
    """Find a rendered message above the current bottom, without search/backfill."""
    for _ in range(20):
        tree=dump()
        for node in tree.iter('node'):
            bounds=list(map(int,re.findall(r'\d+',node.get('bounds',''))))
            if (contains in node.get('text','') and len(bounds)==4
                    and bounds[2]>bounds[0] and bounds[3]>bounds[1]):
                return node
        scroller=next((n for n in tree.iter('node')
            if n.get('class')=='android.widget.ScrollView' and n.get('scrollable')=='true'),None)
        if scroller is None:break
        x,y,x2,y2=map(int,re.findall(r'\d+',scroller.get('bounds')))
        adb('shell','input','swipe',(x+x2)//2,y+(y2-y)//4,(x+x2)//2,y+(y2-y)*3//4,'300')
    raise AssertionError('Real response was not rendered in the native transcript: '+contains)

def report(message):
    checks.append(message)
    (a.output/'checks.json').write_text(json.dumps(checks,indent=2))
    print('PASS '+message,flush=True)

def git(*arguments):
    return subprocess.check_output(
        ['git','-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null',*arguments],
        cwd=repo,text=True).strip()

def wait_completed(text,timeout=480):
    end=time.monotonic()+timeout
    while time.monotonic()<end:
        snap=api('/sessions/'+sid)
        seen=any(e['type']=='message' and e['actor']=='user' and e['data']['text']==text for e in snap['events'])
        if seen and snap['session']['status']=='completed':return snap
        if snap['session']['status']=='failed':raise AssertionError(json.dumps(snap))
        time.sleep(.5)
    raise AssertionError('Real provider did not complete')

snap=api('/sessions/'+sid)
assert not snap['session'].get('mock') and not snap['session']['config'].get('mock')
assert Path(snap['session']['workspacePath']).resolve()==repo
assert snap['session']['status']=='idle', 'Use a fresh real-provider fixture'
assert not (repo/'math.js').exists()
initial_head=git('rev-parse','HEAD')
assert not git('status','--porcelain=v1','--untracked-files=all'), 'The real fixture must begin clean'
expected_apk_sha=hashlib.sha256((ROOT/'lina.apk').read_bytes()).hexdigest()
adb('install','-r',str(ROOT/'lina.apk'))
installed_paths=[line.removeprefix('package:').strip() for line in adb('shell','pm','path','app.lina.android').splitlines() if line.startswith('package:')]
installed_base=next((path for path in installed_paths if path.endswith('/base.apk')),None)
assert installed_base is not None, 'Installed native APK path is unavailable'
installed_copy=a.output/'installed-lina.apk'
adb('pull',installed_base,str(installed_copy))
installed_apk_sha=hashlib.sha256(installed_copy.read_bytes()).hexdigest()
assert installed_apk_sha==expected_apk_sha, 'The installed app is not the APK selected for verification'
report('exact installed native APK bytes match the selected signed package')
adb('reverse',f'tcp:{info["port"]}',f'tcp:{info["port"]}')
try:
    adb('shell','am','force-stop','app.lina.android')
    adb('shell','pm','clear','app.lina.android')
    adb('shell','am','start','-n','app.lina.android/.MainActivity')
    wait('Connect to LINA')
    fill(base+'/#token='+token,'LINA address');hide_keyboard();tap('CONNECT')
    wait(contains='· Connected')
    tap(contains=snap['session']['title'])
    wait(desc='Message')
    question='What is this project for? Answer in one short sentence without changing any files.'
    fill(question,'Message');tap('Send')
    first=wait_completed(question)
    answers=[e['data']['text'] for e in first['events'] if e['type']=='message' and e['actor']=='codex']
    assert answers and not (repo/'math.js').exists()
    assert git('rev-parse','HEAD')==initial_head, 'An ordinary question moved the project HEAD'
    assert not git('status','--porcelain=v1','--untracked-files=all'), 'An ordinary question changed project files'
    question_events=[e for e in first['events'] if e['seq']>snap['session']['lastSeq']]
    assert not any(e['type'] in ('tests','review','checkpoint') for e in question_events), 'An ordinary question unexpectedly entered a coding workflow'
    assert all(e['data']['phase'] in ('consulting','completed') for e in question_events if e['type']=='phase'), 'An ordinary question unexpectedly planned or built'
    (a.output/'real-question-session.json').write_text(json.dumps(first,indent=2))
    wait(contains=answers[-1].strip()[:65])
    screenshot('native-real-question')
    report('native question reached real Codex and rendered its answer without file changes')
    task='Implement math.js with a named export add(a,b) that adds numbers. Run npm test and report the result.'
    fill(task,'Message');tap('Send')
    written=wait_completed(task)
    assert (repo/'math.js').is_file()
    verified=[e['data'] for e in written['events'] if e['seq']>first['session']['lastSeq'] and e['type']=='tests' and e['data'].get('ok') and not e['data'].get('skippedReason') and e['data'].get('exitCode')==0 and e['data'].get('command','').strip()]
    assert verified, 'Lina must independently verify the real writing turn'
    wait(contains='completed · completed')
    responses=[e['data']['text'] for e in written['events'] if e['seq']>first['session']['lastSeq'] and e['type']=='message' and e['actor']=='codex' and e['data'].get('text','').strip()]
    assert responses, 'The actual provider must produce a completed native response'
    # Status alone can be stale from the first completed question; require the new
    # answer and a real test card to be present in the native transcript as well.
    reveal_transcript('Tests · exit 0')
    screenshot('native-real-tests-rendered')
    reveal_transcript(responses[-1].strip()[:65])
    screenshot('native-real-code-and-tests')
    (a.output/'real-session.json').write_text(json.dumps(written,indent=2))
    report('native coding request rendered its new real response and Lina-run test card after changing a real file')
    turns=api('/sessions/'+sid+'/changes')
    turn=next(t for t in turns if t.get('status')=='ready' and any(f['path']=='math.js' for f in t['files']))
    menu('Changes and undo');tap(contains='Turn '+str(turn['turn'])+' ·')
    wait(contains='math.js');screenshot('native-real-diff');tap('UNDO TURN');tap('CONTINUE')
    end=time.monotonic()+30
    while (repo/'math.js').exists() and time.monotonic()<end:time.sleep(.25)
    assert not (repo/'math.js').exists()
    assert next(t for t in api('/sessions/'+sid+'/changes') if t['turn']==turn['turn'])['status']=='undone'
    assert git('rev-parse','HEAD')==initial_head, 'Undo moved the project HEAD'
    assert not git('status','--porcelain=v1','--untracked-files=all'), 'Undo did not restore the complete initial project file state'
    report('native real-turn diff inspection and undo restored the project file state')
    menu('Models and mode')
    selected=written['session']['config']['models']['codex']['model']
    fill('invalid-before-catalogue-selection','Codex model');hide_keyboard()
    tap('Choose codex model')
    tap(contains='\n'+selected+' ·')
    wait(text=selected,desc='Codex model')
    tap('Validate')
    wait(contains='Validated ·',timeout=180)
    screenshot('native-real-model-validation');tap('CANCEL')
    report('native provider catalogue selection and actual model validation succeeded')
    assert hashlib.sha256((ROOT/'lina.apk').read_bytes()).hexdigest()==installed_apk_sha, 'The selected APK changed during verification; verify the new package before distributing it'
    (a.output/'result.json').write_text(json.dumps({'passed':True,'serial':a.serial,'api':adb('shell','getprop','ro.build.version.sdk').strip(),'session':sid,'checks':checks,'apkSha256':installed_apk_sha,'installedApkPath':installed_base,'initialHead':initial_head,'restoredHead':git('rev-parse','HEAD'),'projectRestoredClean':True},indent=2))
finally:
    subprocess.run([a.adb,'-s',a.serial,'reverse','--remove',f'tcp:{info["port"]}'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
