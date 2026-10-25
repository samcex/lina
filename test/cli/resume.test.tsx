import React from 'react';
import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { render } from 'ink';
import { App } from '../../src/cli/tui/App.js';
import { TuiStore, type ClientLike } from '../../src/cli/tui/store.js';
import { parseSlash } from '../../src/cli/slash.js';
import { stripAnsi } from '../../src/cli/ansi.js';
import { project, snapshot } from './fixture.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 150));
function fixture(status: 'completed' | 'paused' | 'running' = 'completed') {
  const snap = snapshot();
  snap.session = { ...snap.session, status, phase: status === 'running' ? 'reviewing' : status === 'paused' ? 'idle' : 'completed', projectId: 'old-project', title: 'My saved conversation' };
  snap.project = { ...project, id: 'old-project', name: 'Original project' };
  const controls: string[] = [], filters: unknown[] = [];
  const client = {
    sessions: async (filter: unknown) => { filters.push(filter); return [snap.session]; },
    session: async () => snap,
    control: async (id: string, action: string) => { controls.push(`${id}:${action}`); return { ...snap.session, status: 'running' as const }; },
  } as unknown as ClientLike;
  return { snap, controls, filters, client, store: new TuiStore(client, { project, live: false }) };
}

describe('saved conversation resume', () => {
  it('parses session resume and distinguishes conversation history from earlier messages', () => {
    expect(parseSlash('/resume')).toEqual({ type: 'resume' });
    expect(parseSlash('/resume last')).toEqual({ type: 'resume', selector: 'last' });
    expect(parseSlash('/resume sess_012')).toEqual({ type: 'resume', selector: 'sess_012' });
    expect(parseSlash('/history')).toEqual({ type: 'history' });
    expect(parseSlash('/history earlier')).toEqual({ type: 'history', earlier: true });
    expect(parseSlash('/history 12')).toEqual({ type: 'history', seq: 12 });
    expect(parseSlash('/resume one two').type).toBe('error');
  });
  it.each(['completed','running','paused'] as const)('opens the latest %s conversation across projects, resuming stopped work only', async (status) => {
    const f = fixture(status);
    try {
      await f.store.resumeSession('last');
      expect(f.filters).toContainEqual({});
      expect(f.store.getState().sessionId).toBe(f.snap.session.id);
      expect(f.store.getState().project?.id).toBe('old-project');
      expect(f.store.getState().view?.timeline.length).toBeGreaterThan(0);
      expect(f.controls).toEqual(status === 'paused' ? [`${f.snap.session.id}:resume`] : []);
    } finally { f.store.dispose(); }
  });
  it('does not open an arbitrary conversation for an ambiguous id', async () => {
    const f = fixture();
    f.client.sessions = async () => [f.snap.session, { ...f.snap.session, id: 'sess_other' }];
    try {
      await f.store.resumeSession('sess_');
      expect(f.store.getState().sessionId).toBeUndefined();
      expect(f.controls).toEqual([]);
      expect(f.store.getState().notices.at(-1)?.text).toContain('ambiguous');
    } finally { f.store.dispose(); }
  });
  it.each([['/resume',false],['/history',false],['/resume',true],['/history',true]] as const)('%s lists all saved projects (already open: %s)', async (command, opened) => {
    const f = fixture(); const frames: string[] = [];
    if (opened) await f.store.openSession(f.snap.session.id);
    const stdout = new Writable({write(chunk,_encoding,done){ frames.push(String(chunk)); done(); }}) as Writable & {isTTY:boolean;columns:number;rows:number};
    Object.assign(stdout,{isTTY:true,columns:100,rows:30});
    const stdin = new PassThrough() as PassThrough & {isTTY:boolean;setRawMode:()=>void;ref:()=>void;unref:()=>void};
    Object.assign(stdin,{isTTY:true,setRawMode:()=>{},ref:()=>{},unref:()=>{}});
    const app=render(<App store={f.store} cwd="/tmp" size={{columns:100,rows:30}} onQuit={()=>{}}/>,{stdin:stdin as unknown as NodeJS.ReadStream,stdout:stdout as unknown as NodeJS.WriteStream,interactive:true,patchConsole:false,exitOnCtrlC:false});
    try {
      await tick(); stdin.write(command); await tick(); stdin.write('\r'); await tick(); await tick();
      expect(stripAnsi(frames.join(''))).toContain('My saved conversation');
      expect(stripAnsi(frames.join(''))).toContain('all projects');
      stdin.write('\r'); await tick(); await tick();
      expect(f.store.getState().sessionId).toBe(f.snap.session.id);
      expect(f.controls).toEqual([]);
      expect(f.filters).toContainEqual({});
    } finally {app.unmount(); f.store.dispose();}
  });
});
