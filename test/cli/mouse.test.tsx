import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { PassThrough, Writable } from 'node:stream';
import { render } from 'ink';
import { stripAnsi } from '../../src/cli/ansi.js';
import { App } from '../../src/cli/tui/App.js';
import { ModeOverlay, TestsOverlay } from '../../src/cli/tui/overlays.js';
import { extractMouse, installMouse } from '../../src/cli/tui/mouse.js';
import { TuiStore, type ClientLike } from '../../src/cli/tui/store.js';
import { viewFromSnapshot } from '../../src/shared/reducer.js';
import { project, snapshot } from './fixture.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 100));
class Screen extends Writable {
  isTTY = true; columns = 120; rows = 24; frames: string[] = [];
  _write(chunk: Buffer, _encoding: string, done: () => void) { this.frames.push(String(chunk)); done(); }
  get latest() { return stripAnsi(this.frames.join('')).split('◆ LINA').at(-1) ?? ''; }
}

describe('mouse input', () => {
  let cleanup: (() => void) | undefined;
  afterEach(() => { cleanup?.(); cleanup = undefined; });

  it('filters click/drag reports, preserves text and recognizes modified vertical wheels', () => {
    expect(extractMouse('before\x1b[<0;3;4M\x1b[<0;3;4m\x1b[<32;4;4M\x1b[<64;5;6M\x1b[<69;5;6Mafter'))
      .toEqual({ text: 'beforeafter', wheel: [-1, 1], pending: '' });
    expect(extractMouse('\x1b[<66;5;6M')).toEqual({ text: '', wheel: [], pending: '' });
    expect(extractMouse('typing\x1b[<64;5;')).toEqual({ text: 'typing', wheel: [], pending: '\x1b[<64;5;' });
    expect(extractMouse('\x1b[M`!!\x1b[Ma!!\x1b[96;3;4M\x1b[97;3;4M\x1b[<64;3;4m')).toEqual({ text: '', wheel: [-1, 1, -1, 1], pending: '' });
  });

  it('supports phone arrow swipes, clickable scrolling with a draft, and held transcript drags', async () => {
    const store = new TuiStore({ sessions: async () => [] } as unknown as ClientLike, { view: viewFromSnapshot(snapshot()), project, live: false });
    const stdout = new Screen();
    const stdin = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode: () => void; ref: () => void; unref: () => void };
    stdin.isTTY = true; stdin.setRawMode = () => {}; stdin.ref = () => {}; stdin.unref = () => {};
    const inst = render(<App store={store} cwd="/tmp" onQuit={() => {}} size={{ columns: 56, rows: 30 }} />, {
      stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false, patchConsole: false, interactive: true,
    });
    const restore = installMouse(stdin as unknown as NodeJS.ReadStream, stdout as unknown as NodeJS.WriteStream);
    cleanup = () => { restore(); inst.unmount(); store.dispose(); };
    await tick();
    expect(stdout.latest).toContain('[↑] [↓] [Latest] [Scroll]');
    stdin.write('\x1b[A'); await tick();
    expect(stdout.latest).toContain('3 lines up');
    stdin.write('Keep this draft'); await tick();
    stdin.write('\x1b[<0;22;30M\x1b[<0;22;30m'); await tick();
    expect(stdout.latest).toContain('[Write]');
    stdin.write('\x1b[A'); await tick();
    expect(stdout.latest).toContain('6 lines up');
    expect(stdout.latest).toContain('Keep this draft');
    stdin.write('\x1b[<0;12;30M\x1b[<0;12;30m'); await tick();
    expect(stdout.latest).not.toContain('lines up');
    stdin.write('\x1b[<0;8;8M\x1b[<32;8;13M\x1b[<0;8;13m'); await tick();
    expect(stdout.latest).toContain('5 lines up');
    expect(stdout.latest).toContain('Keep this draft');
  });

  it('scrolls the transcript and help with actual stdin mouse reports without editing the composer', async () => {
    const store = new TuiStore({ sessions: async () => [] } as unknown as ClientLike, { view: viewFromSnapshot(snapshot()), project, live: false });
    const stdout = new Screen();
    const stdin = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode: () => void; ref: () => void; unref: () => void };
    stdin.isTTY = true; stdin.setRawMode = () => {}; stdin.ref = () => {}; stdin.unref = () => {};
    const inst = render(<App store={store} cwd="/tmp" onQuit={() => {}} size={{ columns: 120, rows: 24 }} />, {
      stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false, patchConsole: false, interactive: true,
    });
    const restore = installMouse(stdin as unknown as NodeJS.ReadStream, stdout as unknown as NodeJS.WriteStream);
    cleanup = () => { restore(); inst.unmount(); store.dispose(); };
    await tick();
    stdin.write('\x1b[<64;20;8M'); await tick();
    expect(stdout.latest).toContain('3 lines up');
    // A split report must be retained until its remaining bytes arrive.
    stdin.write('\x1b[<64;20;'); await tick(); stdin.write('8M'); await tick();
    expect(stdout.latest).toContain('6 lines up');
    expect(stdout.latest).not.toContain('<64;');
    stdin.write('?'); await tick();
    expect(stdout.latest).toContain('◆ Help');
    stdin.write('\x1b[<65;20;8M'); await tick();
    expect(stdout.latest).toContain('4–');
    stdin.write('\x1b'); await tick();
    expect(stdout.latest).toContain('6 lines up');
    expect(stdout.latest).not.toContain('◆ Help');
    stdin.write('\x1b[<65;20;8M\x1b[<65;20;8M'); await tick();
    expect(stdout.latest).not.toContain('lines up');
  });
  it('keeps selected modes and old test runs visible on a short terminal', async () => {
    const view = viewFromSnapshot(snapshot());
    view.tests = Array.from({ length: 12 }, (_, i) => ({ ...view.tests[0], command: `test-run-${i}`, output: `output-${i}` }));
    const store = new TuiStore({ sessions: async () => [] } as unknown as ClientLike, { view, project, live: false });
    const stdout = new Screen();
    const stdin = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode: () => void; ref: () => void; unref: () => void };
    stdin.isTTY = true; stdin.setRawMode = () => {}; stdin.ref = () => {}; stdin.unref = () => {};
    const options = { stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream, exitOnCtrlC: false, patchConsole: false, interactive: true };
    const inst = render(<ModeOverlay store={store} width={120} height={12} onClose={() => {}} onTeam={() => {}} />, options);
    cleanup = () => { inst.unmount(); store.dispose(); };
    await tick();
    for (let i = 0; i < 5; i++) { stdout.frames = []; stdin.write('\x1b[B'); await tick(); }
    expect(stripAnsi(stdout.frames.join(''))).toContain('custom');
    inst.rerender(<TestsOverlay store={store} width={120} height={12} onClose={() => {}} />);
    await tick();
    for (let i = 0; i < 11; i++) { stdout.frames = []; stdin.write('\x1b[B'); await tick(); }
    expect(stripAnsi(stdout.frames.join(''))).toContain('test-run-0');
    expect(stripAnsi(stdout.frames.join(''))).toContain('output-0');
  });

});
