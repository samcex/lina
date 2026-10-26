#!/usr/bin/env python3
"""Verify a single goal through provider failures and two actual daemon crashes.
Uses a disposable project/state with mock providers and real HTTP, SQLite and timers.
"""
import argparse,json,os,sqlite3,subprocess,tempfile,time,urllib.request
from pathlib import Path
parser=argparse.ArgumentParser();parser.add_argument('--output',default='/tmp/lina-goal-recovery');args=parser.parse_args()
out=Path(args.output).resolve();out.mkdir(parents=True,exist_ok=True)
root=Path(__file__).resolve().parents[1];work=Path(tempfile.mkdtemp(prefix='lina-goal-process-'));repo=work/'project';repo.mkdir()
for cmd in [['init','-q'],['config','user.name','LINA QA'],['config','user.email','qa@localhost']]:subprocess.run(['git',*cmd],cwd=repo,check=True,stdout=subprocess.DEVNULL)
(repo/'README.md').write_text('# Disposable goal recovery fixture\n')
subprocess.run(['git','add','README.md'],cwd=repo,check=True);subprocess.run(['git','commit','-qm','Fixture'],cwd=repo,check=True)
info=work/'info.json';env=dict(os.environ,LINA_HOME=str(work/'state'),LINA_MOCK='1',QA_INFO=str(info),QA_FAIL='1',QA_HOLD_AUDIT='1')
process=None;details=None;pids=[];controls=0;log=(out/'daemon.log').open('w')
def wait(fn,seconds=40):
 end=time.monotonic()+seconds
 while time.monotonic()<end:
  assert process.poll() is None,'Fixture daemon exited unexpectedly'
  value=fn()
  if value:return value
  time.sleep(.05)
 raise AssertionError('Timed out observing the same live fixture process')
def start():
 global process,details
 info.unlink(missing_ok=True)
 process=subprocess.Popen(['node','--import','tsx',str(root/'scripts/verify-goal-daemon.mjs')],cwd=root,env=env,stdout=log,stderr=log);pids.append(process.pid)
 wait(info.exists,15);details=json.loads(info.read_text())
def stop(crash=False):
 if process and process.poll() is None:
  process.kill() if crash else process.terminate()
  try:process.wait(timeout=8)
  except subprocess.TimeoutExpired:process.kill();process.wait(timeout=3)
def api(path,body=None):
 global controls
 if '/control' in path:controls+=1
 request=urllib.request.Request(f'http://127.0.0.1:{details["port"]}'+path,data=None if body is None else json.dumps(body).encode(),headers={'Authorization':'Bearer '+details['token'],'Content-Type':'application/json'})
 with urllib.request.urlopen(request,timeout=5) as response:return json.load(response)
def row():
 with sqlite3.connect('file:'+str(work/'state/lina.db')+'?mode=ro',uri=True) as c:
  result=c.execute('select status,state from sessions where id=?',(sid,)).fetchone()
  return result[0],json.loads(result[1])
def audit_running():
 with sqlite3.connect('file:'+str(work/'state/lina.db')+'?mode=ro',uri=True) as c:
  return row()[0]=='running' and c.execute("select count(*) from events where session_id=? and type='message' and json_extract(data,'$.text')='Auditing completion evidence for every goal requirement.'",(sid,)).fetchone()[0]>0
try:
 start();project=api('/api/projects',{'path':str(repo)})
 session=api('/api/sessions',{'projectId':project['id'],'config':{'mock':True,'mode':'architect','interactionMode':'workflow','goal':'Build hello','testCommand':'node --test hello.test.js'}});sid=session['id']
 api(f'/api/sessions/{sid}/messages',{'text':'Build hello'})
 wait(lambda:row()[0]=='failed' and row()[1].get('limitRetryPending'))
 assert (repo/'partial-codex.txt').exists() and (repo/'partial-claude.txt').exists()
 stop(crash=True);env['QA_FAIL']='0';start()
 # No API reads or mutations after restart: database observations cannot arm timers.
 wait(audit_running);stop(crash=True);env['QA_HOLD_AUDIT']='0';start()
 wait(lambda:row()[0]=='completed' and row()[1].get('goalStatus')=='complete')
 status,state=row();assert state['goalRequirements'] and all(r['status']=='verified' for r in state['goalRequirements'])
 assert state['lastTest']['ok'] and not state['lastTest'].get('skippedReason')
 with sqlite3.connect(work/'state/lina.db') as c:
  owner=c.execute("select count(*) from events where session_id=? and type='message' and actor='user'",(sid,)).fetchone()[0]
 assert owner==1 and controls==0
 assert (repo/'hello.js').exists() and (repo/'partial-codex.txt').exists() and (repo/'partial-claude.txt').exists()
 result={'passed':True,'daemonPids':pids,'crashRestarts':2,'ownerMessages':owner,'controlCalls':controls,'clientRequestsAfterRestarts':0,'status':status,'goalStatus':state['goalStatus'],'verifiedRequirements':len(state['goalRequirements']),'testsPassed':True,'partialWorkPreserved':True,'automaticRetryWithoutResume':True,'source':'Real separate processes/HTTP/SQLite/timers with injected mock-provider failures','workspace':str(work)}
 (out/'result.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
finally:stop();log.close()
