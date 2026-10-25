import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { PassThrough, Writable } from 'node:stream';
import { render } from 'ink';
import { applyEvent, viewFromSnapshot } from '../../src/shared/reducer.js';
import type { AnyLinaEvent } from '../../src/shared/types.js';
import { stripAnsi } from '../../src/cli/ansi.js';
import { parseSlash } from '../../src/cli/slash.js';
import { App } from '../../src/cli/tui/App.js';
import { liveAgentLines, liveAllLines } from '../../src/cli/tui/overlays.js';
import { TuiStore, type ClientLike } from '../../src/cli/tui/store.js';
import { narratedActivity, project, session, snapshot } from './fixture.js';

const commandWithOutput = (state: 'running' | 'ok' = 'ok'): AnyLinaEvent => ({
  sessionId: session.id, seq: 101, ts: Date.UTC(2026, 0, 2, 10, 0, 10), type: 'activity', actor: 'codex',
  data: { agent: 'codex', id: 'a2', kind: 'command', title: 'npm run build', state, exitCode: state === 'ok' ? 0 : undefined, output: 'vite v6\n✓ 42 modules transformed\nbuilt in 1.2s', files: ['dist/index.js'], source: 'observed' },
} as AnyLinaEvent);

const view = () => applyEvent(applyEvent(viewFromSnapshot(snapshot()), narratedActivity()), commandWithOutput());
const opts = { width: 80, now: Date.now(), frame: 0, updateRows: 6 };
const text = (lines: string[]) => stripAnsi(lines.join('\n'));

describe('live agent view', () => {
  it('shows status, streamed text and the activity feed newest first', () => {
    const claude = text(liveAgentLines(view(), 'claude', opts).lines);
    expect(claude).toContain('Reviewing');
    expect(claude).toContain('Writing now');
    expect(claude).toContain('Looking at the diff now');
    expect(claude).toContain('“I will check the query builder”');
    const codex = liveAgentLines(view(), 'codex', opts);
    const out = text(codex.lines);
    expect(out).toContain('Writing code · src/App.tsx');
    expect(out).toContain('Latest update'); // no stream: falls back to the last message
    expect(out).toContain('Plan');
    expect(out.indexOf('npm run build')).toBeLessThan(out.indexOf('npm test'));
    expect(codex.items.map((i) => i.key)).toEqual(['codex:a2', 'codex:a1']);
    expect(out).not.toContain('42 modules transformed');
  });

  it('expands an item to its output and files, and marks the cursor', () => {
    const b = liveAgentLines(view(), 'codex', { ...opts, cursor: true, expanded: new Set(['codex:a2']) });
    const out = text(b.lines);
    expect(out).toContain('✓ 42 modules transformed');
    expect(out).toContain('files dist/index.js');
    expect(stripAnsi(b.lines[b.items[0].start])).toMatch(/^▸/);
    expect(b.items[0].end).toBeGreaterThan(b.items[0].start);
  });

  it('lays both agents side by side on wide screens', () => {
    const lines = liveAllLines(view(), { ...opts, width: 140 });
    expect(lines.some((l) => { const s = stripAnsi(l); return s.includes('Codex') && s.includes('Claude'); })).toBe(true);
    expect(text(liveAllLines(view(), opts))).toContain('Claude');
  });

  it('retains configured agent roles after a daemon restart clears live status', () => {
    const restored = view();
    restored.agents.codex = { status: 'idle', activity: [], since: Date.now() };
    restored.agents.claude = { status: 'idle', activity: [], since: Date.now() };
    expect(text(liveAgentLines(restored, 'codex', opts).lines)).toContain('Codex Developer');
    expect(text(liveAgentLines(restored, 'claude', opts).lines)).toContain('Claude Reviewer');
    restored.session.config.mode = 'solo';
    expect(text(liveAgentLines(restored, 'claude', opts).lines)).not.toContain('Reviewer');
  });

  it('parses /live with an optional agent', () => {
    expect(parseSlash('/live')).toEqual({ type: 'live' });
    expect(parseSlash('/agents claude')).toEqual({ type: 'live', agent: 'claude' });
    expect(parseSlash('/live bob').type).toBe('error');
  });
});

class FakeStdout extends Writable {
  columns: number; rows: number; isTTY = true; frames: string[] = [];
  constructor(columns: number, rows: number) { super(); this.columns = columns; this.rows = rows; }
  _write(chunk: Buffer, _enc: string, cb: () => void) { this.frames.push(chunk.toString()); cb(); }
  get last() { return stripAnsi(this.frames.slice(-30).join('')); }
}

const tick = (ms = 80) => new Promise((r) => setTimeout(r, ms));

describe('Live overlay (Ink)', () => {
  let cleanup: (() => void) | undefined;
  afterEach(() => { cleanup?.(); cleanup = undefined; });

  it('opens with Ctrl+T, switches agents, expands output and closes', async () => {
    const store = new TuiStore({ sessions: async () => [], projects: async () => [] } as unknown as ClientLike, { view: view(), live: false, project });
    const stdout = new FakeStdout(140, 40);
    const stdin = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode: (b: boolean) => void; ref: () => void; unref: () => void };
    stdin.isTTY = true; stdin.setRawMode = () => {}; stdin.ref = () => {}; stdin.unref = () => {};
    const inst = render(<App store={store} cwd="/tmp" onQuit={() => {}} size={{ columns: 140, rows: 40 }} />,
      { stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream, exitOnCtrlC: false, patchConsole: false, interactive: true });
    cleanup = () => { inst.unmount(); store.dispose(); };
    await tick();
    stdin.write('\x14'); await tick();
    expect(stdout.last).toContain('◆ Live');
    expect(stdout.last).toContain('All agents');
    stdin.write('2'); await tick();
    expect(stdout.last).toContain('Enter show output');
    stdin.write('\r'); await tick();
    expect(stdout.last).toContain('42 modules transformed');
    stdin.write('\x1b');
    // the newest full frame (each starts with the header) no longer shows the overlay
    const latest = () => stdout.last.split('◆ LINA').at(-1) ?? '';
    for (let i = 0; i < 20 && latest().includes('◆ Live'); i++) await tick(50);
    expect(latest()).not.toContain('◆ Live');
    expect(latest()).toContain('Message the team');
  });
});
