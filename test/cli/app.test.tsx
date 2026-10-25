import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { PassThrough, Writable } from 'node:stream';
import { render, renderToString } from 'ink';
import { applyEvent, viewFromSnapshot } from '../../src/shared/reducer.js';
import type { AnyLinaEvent } from '../../src/shared/types.js';
import { stripAnsi } from '../../src/cli/ansi.js';
import { App } from '../../src/cli/tui/App.js';
import { TuiStore, mergeSnapshot, type ClientLike } from '../../src/cli/tui/store.js';
import { buildTranscript } from '../../src/cli/transcript.js';
import { narratedActivity, project, session, snapshot } from './fixture.js';

function stubClient(calls: string[] = []): ClientLike {
  const rec = (name: string, value: unknown) => async (...args: unknown[]) => { calls.push(`${name} ${JSON.stringify(args)}`); return value as never; };
  return {
    session: rec('session', snapshot()),
    createSession: rec('createSession', session),
    send: rec('send', { ok: true, queued: true }),
    control: rec('control', session),
    approval: rec('approval', session),
    updateSession: rec('updateSession', session),
    sessions: rec('sessions', [session]),
    projects: rec('projects', [project]),
    addProject: rec('addProject', project),
    models: rec('models', { codex: { agent: 'codex', installed: true, models: [{ id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol', source: 'catalog', efforts: ['low', 'medium'] }], defaultModel: 'gpt-6.1-sol', discoveredVia: 'codex debug models' }, claude: { agent: 'claude', installed: true, models: [{ id: 'opus', label: 'Opus', source: 'alias' }], defaultModel: 'opus', discoveredVia: 'aliases' } }),
    validateModel: rec('validateModel', { ok: true, checkedAt: 0 }),
    diff: rec('diff', { base: 'aaaaaaa', head: 'bbbbbbb', files: [{ path: 'src/Dashboard.tsx', status: 'added', additions: 2, deletions: 0, patch: '@@ -0,0 +1,2 @@\n+export const A = 1;\n+export const B = 2;' }] }),
    doctor: rec('doctor', { checks: [{ id: 'git', label: 'git', ok: true, detail: 'git 2.50' }, { id: 'codex', label: 'Codex CLI', ok: false, detail: 'not logged in', hint: 'run codex login' }] }),
    getSettings: rec('getSettings', undefined),
    putSettings: rec('putSettings', undefined),
  } as ClientLike;
}

class FakeStdout extends Writable {
  columns: number; rows: number; isTTY = true; frames: string[] = [];
  constructor(columns: number, rows: number) { super(); this.columns = columns; this.rows = rows; }
  _write(chunk: Buffer, _enc: string, cb: () => void) { this.frames.push(chunk.toString()); cb(); }
  get text() { return stripAnsi(this.frames.join('')); }
  get last() { return stripAnsi(this.frames.slice(-30).join('')); }
}

function fakeStdin() {
  const s = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode: (b: boolean) => void; ref: () => void; unref: () => void };
  s.isTTY = true; s.setRawMode = () => {}; s.ref = () => {}; s.unref = () => {};
  return s;
}

const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));

describe('transcript renderer', () => {
  it('renders every event type from the fixture', () => {
    const view = viewFromSnapshot(snapshot());
    const text = stripAnsi(buildTranscript(view, [{ id: 'n', ts: 0, level: 'error', text: 'oops', hint: 'try again' }], 90).join('\n'));
    for (const s of ['YOU', 'Build a modern dashboard', 'CODEX', 'Plan', 'charts', 'const total', 'Implementing · round 1',
      'Checkpoint abcdef1', 'src/Dashboard.tsx', '✔ Tests passed', '12 passed', 'verified by LINA', '◇ Review by Claude', 'changes requested',
      'BLOCKER 1', 'F1', 'SQL injection', 'escalated', 'rate_limited', 'Wait a few minutes', 'Awaiting your approval', '/approve',
      'writing…', 'Looking at the diff now', '✖ oops', 'try again']) {
      expect(text).toContain(s);
    }
  });
  it('never throws on unexpected events', () => {
    const view = viewFromSnapshot(snapshot());
    const weird = { ...view, timeline: [...view.timeline, { sessionId: 'x', seq: 99, ts: 0, type: 'nonsense', actor: 'lina', data: null } as unknown as AnyLinaEvent, { sessionId: 'x', seq: 100, ts: 0, type: 'review', actor: 'claude', data: {} } as unknown as AnyLinaEvent] };
    expect(() => buildTranscript(weird, [], 80)).not.toThrow();
  });
});

describe('store', () => {
  it('merges a resubscribe snapshot onto an existing view', () => {
    const snap = snapshot();
    const v = viewFromSnapshot(snap);
    const extra = narratedActivity();
    const merged = mergeSnapshot(v, { ...snap, events: [extra], session: { ...snap.session, lastSeq: 100, status: 'paused' } });
    expect(merged.timeline.length).toBe(v.timeline.length + 1);
    expect(merged.session.status).toBe('paused');
    expect(merged.agents.claude.activity.at(-1)?.source).toBe('narrated');
  });

  it('ignores a session-open failure after switching to a new draft', async () => {
    let fail!: (error: Error) => void;
    const client = stubClient();
    client.session = () => new Promise((_resolve, reject) => { fail = reject; });
    const store = new TuiStore(client, { live: false, project });
    const opening = store.openSession(session.id);
    expect(store.getState().loadingSession).toBe(true);
    store.newDraft();
    expect(store.getState().loadingSession).toBe(false);
    fail(new Error('old session unavailable'));
    await opening;
    expect(store.getState().sessionId).toBeUndefined();
    expect(store.getState().notices).toEqual([]);
    store.dispose();
  });

  it('does not overwrite another project with a slow recent-session response', async () => {
    let finish!: (value: typeof session[]) => void;
    const client = stubClient();
    client.sessions = ({ projectId } = {}) => projectId === project.id
      ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve([]);
    const store = new TuiStore(client, { live: false, project });
    const oldRefresh = store.refreshRecent();
    store.setProject({ ...project, id: 'p2', name: 'other' });
    finish([session]);
    await oldRefresh;
    expect(store.getState().project?.id).toBe('p2');
    expect(store.getState().recent).toEqual([]);
    store.dispose();
  });
});

describe('App (Ink)', () => {
  let cleanup: (() => void) | undefined;
  afterEach(() => { cleanup?.(); cleanup = undefined; });

  it('renders the full session screen to a string (wide)', () => {
    const view = applyEvent(viewFromSnapshot(snapshot()), narratedActivity());
    const store = new TuiStore(stubClient(), { view, live: false, project });
    const out = stripAnsi(renderToString(<App store={store} cwd="/tmp" onQuit={() => {}} size={{ columns: 150, rows: 45 }} />, { columns: 150 }));
    for (const s of ['◆ LINA', 'acme-web', 'Build a modern dashboard', 'MOCK', 'round 2/3', 'gpt-6.1-sol·medium', 'opus',
      'Codex', 'Claude', 'Developer', 'Reviewer', 'Writing code', 'Reviewing', 'npm test', 'exit 1', '“I will check the query builder”',
      'Agents are working', '1 queued', 'Awaiting your approval', '○ offline']) {
      expect(out).toContain(s);
    }
    store.dispose();
  });

  it('restores the original welcome and visible agent cards on narrow terminals', () => {
    const store = new TuiStore(stubClient(), { live: false, project });
    const out = stripAnsi(renderToString(<App store={store} cwd="/tmp" onQuit={() => {}} size={{ columns: 90, rows: 30 }} />, { columns: 90 }));
    expect(out).toContain('new session');
    expect(out).toContain('Describe what you want built');
    expect(out).toContain('No activity yet');
    store.dispose();
  });

  it('handles typing, slash commands, overlays, events and quitting', async () => {
    const calls: string[] = [];
    const view = viewFromSnapshot(snapshot());
    const store = new TuiStore(stubClient(calls), { view, live: false, project });
    const stdout = new FakeStdout(140, 40);
    const stdin = fakeStdin();
    let quit = false;
    const inst = render(<App store={store} cwd="/tmp" onQuit={() => { quit = true; }} size={{ columns: 140, rows: 40 }} />,
      { stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream, exitOnCtrlC: false, patchConsole: false, interactive: true });
    cleanup = () => { inst.unmount(); store.dispose(); };
    await tick();

    // help overlay via slash command
    stdin.write('/help'); await tick();
    expect(stdout.last).toContain('/help');
    stdin.write('\r'); await tick();
    expect(stdout.last).toContain('◆ Help');
    stdin.write('\x1b'); await tick(120);

    // a plain message is sent to the daemon
    stdin.write('Please add tests'); await tick();
    stdin.write('\r'); await tick(100);
    expect(calls.some((c) => c.startsWith('send') && c.includes('Please add tests'))).toBe(true);
    expect(stdout.text).toContain('Queued');

    // /approve merge → approval call; unknown command → inline error
    stdin.write('/approve merge'); await tick(); stdin.write('\r'); await tick(100);
    expect(calls.some((c) => c.startsWith('approval') && c.includes('"merge"'))).toBe(true);
    stdin.write('/frobnicate'); await tick(); stdin.write('\r'); await tick(100);
    expect(stdout.text).toContain('Unknown command /frobnicate');

    // diff overlay (Ctrl+D) fetches and shows the patch
    stdin.write('\x04'); await tick(150);
    expect(calls.some((c) => c.startsWith('diff'))).toBe(true);
    expect(stdout.last).toContain('export const A = 1;');
    stdin.write('\x1b'); await tick(120);

    // live streaming event updates the transcript
    (store as unknown as { onServerMessage: (m: unknown) => void }).onServerMessage({ kind: 'event', event: { sessionId: session.id, seq: 0, ts: Date.now(), type: 'stream', actor: 'claude', data: { msgId: 's1', agent: 'claude', delta: ' and the tests' } } });
    await tick(120);
    expect(stdout.text).toContain('and the tests');

    // Ctrl+C while running asks to confirm cancel; y cancels
    stdin.write('\x03'); await tick();
    expect(stdout.last).toContain('Cancel the running turn?');
    stdin.write('y'); await tick(100);
    expect(calls.some((c) => c.startsWith('control') && c.includes('cancel'))).toBe(true);

    // double Ctrl+C quits
    stdin.write('\x03'); await tick(30); stdin.write('\x03'); await tick(60);
    expect(quit).toBe(true);
  });
});
