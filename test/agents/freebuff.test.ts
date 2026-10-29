import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { classifyError } from '../../src/server/agents/errors.js';
import {
  buildFreebuffCommand, discoverFreebuffModels, emptyTurnState, findChatById, findNewChat, listChatDirs,
  pasteKeystrokes, LIMIT_RE, stripAnsi, hoursRemaining, probeFreebuff, SUBMIT_KEY, readTurn, readFreebuffSettings, samePrompt, snapshotChats, toolFiles, toolKind, toolTitle,
  validateFreebuffModel, visibleText, type FreebuffMessage,
} from '../../src/server/agents/freebuff.js';

let root = '';
const saved = { config: process.env.FREEBUFF_CONFIG_DIR, bin: process.env.LINA_FREEBUFF_BIN };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lina-freebuff-'));
  process.env.FREEBUFF_CONFIG_DIR = root;
});

afterEach(() => {
  if (saved.config === undefined) delete process.env.FREEBUFF_CONFIG_DIR;
  else process.env.FREEBUFF_CONFIG_DIR = saved.config;
  if (saved.bin === undefined) delete process.env.LINA_FREEBUFF_BIN;
  else process.env.LINA_FREEBUFF_BIN = saved.bin;
  rmSync(root, { recursive: true, force: true });
});

function chat(id: string, opts: { prompt?: string; projectRoot?: string } = {}): string {
  const dir = join(root, 'projects', 'proj', 'chats', id);
  mkdirSync(dir, { recursive: true });
  if (opts.prompt !== undefined) {
    writeFileSync(join(dir, 'chat-meta.json'), JSON.stringify({ messageCount: 1, firstPrompt: opts.prompt }));
  }
  if (opts.projectRoot !== undefined) {
    writeFileSync(join(dir, 'run-state.json'), JSON.stringify({ sessionState: { fileContext: { projectRoot: opts.projectRoot } } }));
  }
  return dir;
}

function fakeBin(): string {
  const bin = join(root, 'freebuff');
  writeFileSync(bin, '#!/bin/sh\nexit 0\n');
  chmodSync(bin, 0o755);
  return bin;
}

describe('chat-log parsing', () => {
  it('never leaks reasoning blocks into the visible text', () => {
    const m: FreebuffMessage = {
      id: 'ai-1', variant: 'ai', isComplete: true,
      blocks: [
        { type: 'text', textType: 'reasoning', content: 'The user wants X, so I will...' },
        { type: 'text', textType: 'text', content: 'Implemented X.' },
        { type: 'mode-divider', mode: 'LITE' } as never,
      ],
    };
    expect(visibleText(m)).toBe('Implemented X.');
    expect(visibleText({ id: 'u', variant: 'user', content: 'hi' })).toBe('');
  });

  it('emits each text and tool block once and tracks completion', () => {
    const msgs: FreebuffMessage[] = [
      { id: 'u1', variant: 'user', content: 'Add a test' },
      {
        id: 'ai1', variant: 'ai',
        blocks: [
          { type: 'text', textType: 'text', content: 'Looking at the code.' },
          { type: 'tool', toolCallId: 't1', toolName: 'read_files', input: { paths: ['src/a.ts'] }, output: 'export const a = 1;' },
          { type: 'text', textType: 'reasoning', content: 'hidden' },
        ],
        isComplete: true,
      },
    ];
    const st = emptyTurnState(1);
    const events = readTurn(msgs, st);
    expect(events.map((e) => e.t)).toEqual(['text', 'tool']);
    const tool = events.find((e) => e.t === 'tool') as Extract<(typeof events)[number], { t: 'tool' }>;
    expect(tool).toMatchObject({ id: 't1', kind: 'read', title: 'Read src/a.ts', state: 'ok', files: ['src/a.ts'] });
    expect(st.complete).toBe(true);
    expect(st.text).toBe('Looking at the code.');
    // A second poll of the same log emits nothing.
    expect(readTurn(msgs, st)).toEqual([]);
  });

  it('reports an interrupted response as an error signal', () => {
    const st = emptyTurnState(0);
    readTurn([{ id: 'ai', variant: 'ai', isComplete: true, blocks: [{ type: 'text', textType: 'text', content: '[response interrupted]' }] }], st);
    expect(st.interrupted).toBe(true);
  });

  it('maps tool names to activity kinds and titles', () => {
    expect(toolKind('run_terminal_command')).toBe('command');
    expect(toolKind('str_replace')).toBe('edit');
    expect(toolKind('web_search')).toBe('web');
    expect(toolKind('something-new')).toBe('tool');
    expect(toolTitle('run_terminal_command', { command: 'npm test\n--watch' })).toBe('$ npm test --watch');
    expect(toolTitle('spawn_agents', { agents: [{}, {}] })).toBe('Spawn 2 agents');
    expect(toolFiles('write_file', { path: 'a.ts' })).toEqual(['a.ts']);
    expect(toolFiles('list_directory', { path: '.' })).toBeUndefined();
  });
});

describe('pty command', () => {
  it('wraps freebuff in script(1) and quotes the working directory', () => {
    const { cmd, args } = buildFreebuffCommand({ bin: 'freebuff', cwd: '/tmp/a b/c' });
    expect(cmd).toBe('script');
    expect(args[0]).toBe('-qfc');
    expect(args[1]).toBe("stty cols 160 rows 70; freebuff --trust-agents --cwd '/tmp/a b/c'");
    expect(args[2]).toBe('/dev/null');
  });

  it('resumes a chat and submits with bracketed paste plus Enter', () => {
    const { args } = buildFreebuffCommand({ bin: '/opt/freebuff', cwd: '/w', resumeId: '2026-10-27T15-45-17.562Z', trustAgents: false });
    expect(args[1]).toBe('stty cols 160 rows 70; /opt/freebuff --continue 2026-10-27T15-45-17.562Z --cwd /w');
    expect(pasteKeystrokes('line 1\nline 2')).toBe('\x1b[200~line 1\nline 2\x1b[201~');
    expect(SUBMIT_KEY).toBe('\r');
  });
});

describe('usage-limit screen', () => {
  it('recognises the screens freebuff shows once the free hours are gone', () => {
    expect(LIMIT_RE.test('Not enough hours for DeepSeek V4.1 Flash Fast 10/17: an hour on it takes 5 hours.')).toBe(true);
    expect(LIMIT_RE.test('Your first message starts the session.0/21 hours remaining')).toBe(true);
    expect(classifyError('freebuff', 'Freebuff usage limit: no free session hours remaining').code).toBe('rate_limited');
    expect(LIMIT_RE.test('Enter a coding task')).toBe(false);
    // The TUI paints colours/cursor moves inside the words; strip first, then match.
    const painted = '\x1b[1;2H\x1b[38;2;255;255;255mNot enough hours\x1b[0m for DeepSeek\n\x1b[5;10H0/21 hours remaining';
    expect(LIMIT_RE.test(stripAnsi(painted))).toBe(true);
  });
});

describe('availability probe', () => {
  it('reads the hours counter off the raw screen text', () => {
    expect(hoursRemaining('idle text \x1b[31m0/21 hours remaining\x1b[0m done')).toEqual({ remaining: 0, total: 21 });
    expect(hoursRemaining('nothing here')).toBeUndefined();
  });

  it('reports an agent with no free hours as unavailable, without typing a prompt', async () => {
    const bin = join(root, 'freebuff');
    writeFileSync(bin, '#!/bin/sh\nprintf "\\033[1;1HEnter a coding task\\n0/21 hours remaining\\n"\nsleep 30\n');
    chmodSync(bin, 0o755);
    const p = await probeFreebuff({ cwd: root, bin, timeoutMs: 6000 });
    expect(p.ok).toBe(false);
    expect(p.reason).toMatch(/free session hours/);
  });

  it('accepts a ready composer with hours to spare', async () => {
    const bin = join(root, 'freebuff');
    writeFileSync(bin, '#!/bin/sh\nprintf "\\033[1;1HEnter a coding task\\n3/21 hours remaining\\n"\nsleep 30\n');
    chmodSync(bin, 0o755);
    const p = await probeFreebuff({ cwd: root, bin, timeoutMs: 6000 });
    expect(p).toMatchObject({ ok: true, hours: 3 });
  });
});

describe('chat discovery', () => {
  it('finds a new chat by its first prompt and ignores earlier chats', () => {
    chat('2026-10-27T10-00-00.000Z', { prompt: 'old task' });
    const before = snapshotChats();
    chat('2026-10-27T11-00-00.000Z', { prompt: 'new task' });
    expect(findNewChat(before, 'new task')).toContain('2026-10-27T11-00-00.000Z');
    expect(findNewChat(before, 'other task')).toBeUndefined();
    expect(listChatDirs()[0]).toContain('2026-10-27T11-00-00.000Z');
  });

  it('matches the first user message when the CLI did not write chat-meta yet', () => {
    const dir = chat('2026-10-27T12-00-00.000Z');
    writeFileSync(join(dir, 'chat-messages.json'), JSON.stringify([
      { id: 'u', variant: 'user', content: 'fix the login bug' },
    ]));
    expect(findNewChat(new Set(), 'fix the login bug')).toBe(dir);
  });

  it('matches prompts that chat-meta truncated, and ignores unrelated chats', () => {
    const prompt = 'Refactor the authentication module so the session guard is shared between the CLI and the web UI.\nDo not change the public API.';
    const dir = chat('2026-10-27T12-30-00.000Z', { prompt: 'Refactor the authentication module so the session guard is shared between the CLI and the web UI.\nDo not ...' });
    expect(findNewChat(new Set(), prompt)).toBe(dir);
    expect(samePrompt('Refactor the authentication module so the session guard is shared', prompt)).toBe(true);
    expect(samePrompt('something else entirely', prompt)).toBe(false);
  });

  it('finds a resumed chat by id', () => {
    const dir = chat('2026-10-27T13-00-00.000Z', { prompt: 'resume me' });
    expect(findChatById('2026-10-27T13-00-00.000Z')).toBe(dir);
    expect(findChatById('nope')).toBeUndefined();
  });
});

describe('models and login', () => {
  it('reports the CLI-configured model and cannot override it', async () => {
    const bin = fakeBin();
    process.env.LINA_FREEBUFF_BIN = bin;
    writeFileSync(join(root, 'settings.json'), JSON.stringify({ freebuffModel: 'glm-5.3-flash', mode: 'DEFAULT' }));
    expect(readFreebuffSettings()).toEqual({ model: 'glm-5.3-flash', mode: 'DEFAULT' });
    const models = await discoverFreebuffModels();
    expect(models.installed).toBe(true);
    expect(models.defaultModel).toBe('glm-5.3-flash');
    expect(models.models.map((m) => m.id)).toEqual(['glm-5.3-flash', 'auto']);
    expect(models.error).toContain('not logged in');
    expect((await validateFreebuffModel('glm-5.3-flash')).code).toBe('auth');
    writeFileSync(join(root, 'credentials.json'), JSON.stringify({ default: {} }));
    expect(await validateFreebuffModel('glm-5.3-flash')).toMatchObject({ ok: true, resolvedModel: 'glm-5.3-flash' });
    expect(await validateFreebuffModel('auto')).toMatchObject({ ok: true });
    const wrong = await validateFreebuffModel('some-other-model');
    expect(wrong.code).toBe('model_unavailable');
    expect(wrong.error).toContain('glm-5.3-flash');
  });

  it('reports a missing CLI instead of pretending to be installed', async () => {
    process.env.LINA_FREEBUFF_BIN = join(root, 'does-not-exist');
    const models = await discoverFreebuffModels();
    expect(models.installed).toBe(false);
    expect(models.error).toContain('not found on PATH');
  });
});
