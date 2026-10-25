import React from 'react';
import { PassThrough, Writable } from 'node:stream';
import { render } from 'ink';
import { expect, it } from 'vitest';
import { App } from '../../src/cli/tui/App.js';
import { TuiStore, type ClientLike } from '../../src/cli/tui/store.js';
import { viewFromSnapshot } from '../../src/shared/reducer.js';
import { stripAnsi } from '../../src/cli/ansi.js';
import { parseSlash } from '../../src/cli/slash.js';
import type { AnyLinaEvent } from '../../src/shared/types.js';
import { snapshot } from './fixture.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 120));

it('opens an old search result and /history target outside the recent 2000-event window', async () => {
  const snap = snapshot();
  const events: AnyLinaEvent[] = Array.from({ length: 2105 }, (_, i) => ({
    sessionId: snap.session.id, seq: i + 1, ts: snap.session.createdAt + i,
    type: 'message', actor: 'user', data: { id: `history-${i + 1}`, kind: 'chat', text: i === 1 ? 'Ancient message body restored from history' : `History event body ${i + 1}` },
  }));
  const calls: number[] = [];
  const client = {
    sessions: async () => [],
    history: async (_id: string, before: number) => { calls.push(before); return events.filter((e) => e.seq < before).slice(-500); },
    search: async () => [{ sessionId: snap.session.id, projectId: snap.project.id, sessionTitle: 'Old conversation', seq: 2, actor: 'user', ts: snap.session.createdAt + 1, snippet: 'Search needle' }],
  } as unknown as ClientLike;
  const store = new TuiStore(client, { view: viewFromSnapshot({ ...snap, events: events.slice(-2000), session: { ...snap.session, lastSeq: 2105 } }), live: false });
  const frames: string[] = [];
  const stdout = new Writable({ write(chunk, _encoding, done) { frames.push(String(chunk)); done(); } }) as Writable & { isTTY: boolean; columns: number; rows: number };
  stdout.isTTY = true; stdout.columns = 80; stdout.rows = 24;
  const stdin = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode: () => void; ref: () => void; unref: () => void };
  stdin.isTTY = true; stdin.setRawMode = () => {}; stdin.ref = () => {}; stdin.unref = () => {};
  const app = render(<App store={store} cwd="/tmp" onQuit={() => {}} size={{ columns: 80, rows: 24 }} />, {
    stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream, patchConsole: false, exitOnCtrlC: false, interactive: true,
  });
  try {
    await tick();
    expect(stripAnsi(frames.join(''))).not.toContain('Ancient message body');
    stdin.write('/search needle'); await tick(); stdin.write('\r'); await tick();
    expect(stripAnsi(frames.join(''))).toContain('Old conversation');
    frames.length = 0;
    stdin.write('\r'); await tick(); await tick();
    expect(calls).toEqual([106]);
    expect(store.getState().view?.lastSeq).toBe(2105);
    expect(stripAnsi(frames.join(''))).toContain('Ancient message body restored from history');
    frames.length = 0;
    stdin.write('/history 1'); await tick(); stdin.write('\r'); await tick();
    expect(stripAnsi(frames.join(''))).toContain('History event body 1');
  } finally { app.unmount(); store.dispose(); }
});

it('validates history cursors and keeps multiword search text', () => {
  expect(parseSlash('/history')).toEqual({ type: 'history' });
  expect(parseSlash('/history 42')).toEqual({ type: 'history', seq: 42 });
  expect(parseSlash('/history -1').type).toBe('error');
  expect(parseSlash('/history 9007199254740992').type).toBe('error');
  expect(parseSlash('/search')).toMatchObject({ type: 'error' });
  expect(parseSlash('/search older question text')).toEqual({ type: 'search', query: 'older question text' });
});
