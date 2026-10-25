#!/usr/bin/env python3
"""Real terminal smoke test. Uses an isolated mock daemon; never reads the owner's Lina data.
Run: python3 scripts/verify-cli-pty.py [--output /tmp/lina-cli-evidence]
Requires Linux/macOS, Python 3 and the repository's Node/tsx dependencies.
"""
import argparse
import fcntl
import json
import os
from pathlib import Path
import pty
import re
import select
import shutil
import socket
import struct
import subprocess
import tempfile
import termios
import time

ROOT = Path(__file__).resolve().parent.parent
ANSI = re.compile(r'\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)')
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=Path)
parser.add_argument('--history-only', action='store_true', help='Run only the new >2000-event history/search path')
args = parser.parse_args()
output = args.output or Path(tempfile.mkdtemp(prefix='lina-cli-pty-evidence-'))
output.mkdir(parents=True, exist_ok=True)
work = Path(tempfile.mkdtemp(prefix='lina-cli-pty-'))
with socket.socket() as probe:
    probe.bind(('127.0.0.1', 0))
    port = probe.getsockname()[1]
loader = subprocess.check_output(['node', '--input-type=module', '-e', 'console.log(import.meta.resolve("tsx"))'], cwd=ROOT, text=True).strip()
entry = [os.environ['LINA_TUI_EXECUTABLE']] if os.environ.get('LINA_TUI_EXECUTABLE') else ['node', '--disable-warning=ExperimentalWarning', '--import', loader, str(ROOT / 'src/cli/main.tsx')]
env = dict(os.environ, LINA_HOME=str(work / 'state'), LINA_PORT=str(port), LINA_MOCK='1', TERM='xterm-256color', NO_COLOR='1')
steps = []
terminal = None

def cli(*argv):
    run = subprocess.run(entry + list(argv), cwd=ROOT, env=env, capture_output=True, text=True, timeout=60)
    if run.returncode:
        raise AssertionError(f'CLI {argv} failed: {run.stderr}')
    return run.stdout

class Terminal:
    def __init__(self, *argv):
        self.fd, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 80, 0, 0))
        self.proc = subprocess.Popen(entry + list(argv), cwd=work / 'project', env=env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
        os.close(slave)
        self.raw = b''
        self.checked = 0

    def read(self, duration=0.1):
        end = time.monotonic() + duration
        while time.monotonic() < end:
            ready, _, _ = select.select([self.fd], [], [], max(0, end - time.monotonic()))
            if not ready:
                break
            try:
                part = os.read(self.fd, 65536)
            except OSError:
                break
            if not part:
                break
            self.raw += part

    def send(self, text):
        os.write(self.fd, text.encode())
        self.read()

    def command(self, text):
        self.send(text)
        self.send('\r')

    def expect(self, phrase, timeout=30):
        end = time.monotonic() + timeout
        while True:
            plain = ANSI.sub('', self.raw.decode(errors='replace'))
            position = plain.find(phrase, self.checked)
            if position >= 0:
                self.checked = position + len(phrase)
                steps.append(phrase)
                return
            if time.monotonic() >= end:
                raise AssertionError(f'Missing {phrase!r}; recent output: {plain[-2500:]}')
            self.read(0.2)

    def close(self, filename):
        if self.proc.poll() is None:
            self.command('/quit')
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.terminate()
                self.proc.wait(timeout=5)
        self.read()
        (output / filename).write_bytes(self.raw)
        os.close(self.fd)

try:
    cli('daemon', 'start')
    cli('add', str(work / 'project'), '--create', '--init-git')
    assert len(json.loads(cli('projects', '--json'))) == 1
    if args.history_only:
        create = """import {readFileSync} from 'node:fs';import {LinaClient} from './src/shared/client.ts';
const info=JSON.parse(readFileSync(process.argv[1],'utf8'));const api=new LinaClient({baseUrl:'http://127.0.0.1:'+info.port,token:info.token});
const project=(await api.projects())[0];console.log(JSON.stringify(await api.createSession({projectId:project.id,config:{mock:true}})));"""
        sessions = [json.loads(subprocess.check_output(['node', '--import', loader, '--input-type=module', '-e', create,
            str(work/'state/daemon.json')], cwd=ROOT, env=env, text=True))]
    else:
        terminal = Terminal('--mock', 'Create a greeting')
        terminal.expect('● live')
        terminal.expect('Finished in your project')
        # Drain the final stream/session batch before measuring a fixed wheel offset.
        terminal.read(0.6)
        terminal.send('\x1b[<64;20;8M')
        terminal.expect('3 lines up')
        terminal.send('\x14')
        terminal.expect('◆ Live')
        terminal.send('2')
        terminal.expect('Enter show output')
        terminal.send('\r')
        terminal.expect('# pass 2')
        terminal.send('\x1b')
        terminal.command('/changes')
        terminal.expect('Turn 1')
        cli('daemon', 'restart')
        terminal.expect('● live')
        terminal.command('What changed?')
        terminal.expect('project exposes a hello(name) function.')
        sessions = json.loads(cli('sessions', '--all', '--json'))
        assert len(sessions) == 1 and sessions[0]['status'] == 'completed'
        terminal.command('/new')
        terminal.expect('new session')
        terminal.command('/history')
        terminal.expect('◆ History')
        terminal.expect('Create a greeting')
        terminal.send('\r')
        terminal.expect('project exposes a hello(name) function.')
        terminal.command('/new')
        terminal.expect('new session')
        terminal.command('/resume last')
        terminal.expect('project exposes a hello(name) function.')
        terminal.command('/resume')
        terminal.expect('◆ Resume conversation')
        terminal.send('\r')
        terminal.expect('project exposes a hello(name) function.')
        terminal.close('session.ansi')
        terminal = Terminal('attach', sessions[0]['id'])
        terminal.expect('What changed?')
        terminal.expect('project exposes a hello(name) function.')
        terminal.send('?')
        terminal.expect('◆ Help')
        terminal.send('\x1b[<65;20;8M')
        terminal.expect('4–')
        terminal.send('\x1b')
        terminal.close('reattach.ansi')
        terminal = Terminal('attach', sessions[0]['id'])
        terminal.expect('● live')
        terminal.command('/goal Build hello')
        terminal.expect('Goal complete: independently checked', timeout=30)
        terminal.command('/goal')
        terminal.expect('Goal: Build hello')
        goal_sessions = json.loads(cli('sessions', '--all', '--json'))
        goals = [s for s in goal_sessions if s['config'].get('goal') == 'Build hello']
        assert len(goals) == 1 and goals[0]['status'] == 'completed'
        steps.append('slash goal executes a dedicated autonomous workflow in the real terminal')
        terminal.close('goal.ansi')
        terminal = None
    # Seed only this disposable fixture's SQLite event log. No provider is asked to
    # generate thousands of messages, and the real daemon still serves every page.
    seed = """import {Db} from './src/server/db.ts';
const [sid,file]=process.argv.slice(1); const db=new Db(file); const old=db.lastSeq(sid)+1;
for(let i=0;i<2105;i++){const text=i===0?'Historicneedle archived answer restored':'Paged fixture message '+i;
db.appendEvent(sid,Date.now()+i,'message',i%2?'codex':'user',{id:'paged-'+i,kind:'chat',text},text);}
db.close(); console.log(JSON.stringify({old}));"""
    old = json.loads(subprocess.check_output(['node', '--disable-warning=ExperimentalWarning', '--import', loader,
        '--input-type=module', '-e', seed, sessions[0]['id'], str(work/'state/lina.db')], cwd=ROOT, env=env, text=True))['old']
    terminal = Terminal('attach', sessions[0]['id'])
    terminal.expect('Paged fixture message 2104')
    assert 'Historicneedle' not in ANSI.sub('', terminal.raw.decode(errors='replace'))
    terminal.command('/search Historicneedle')
    terminal.expect('◆ Search')
    terminal.read(.2)
    terminal.checked = len(ANSI.sub('', terminal.raw.decode(errors='replace')))
    terminal.send('\r')
    terminal.expect('Historicneedle archived answer restored')
    terminal.command('/history 1')
    terminal.expect('Working directly in your project')
    terminal.close('paged-history.ansi')
    terminal = None
    (output / 'result.json').write_text(json.dumps({'ok': True, 'steps': steps, 'terminal': '80x24', 'agents': 'mock', 'isolated': True}, indent=2) + '\n')
    print(f'CLI PTY smoke passed: {output}')
finally:
    if terminal:
        terminal.close('failure.ansi')
    try:
        cli('daemon', 'stop')
    finally:
        shutil.rmtree(work)
