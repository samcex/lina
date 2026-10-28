import React from 'react';
import { PassThrough, Writable } from 'node:stream';
import { render } from 'ink';
import { afterEach, expect, it, vi } from 'vitest';
import { ModelsOverlay } from '../../src/cli/tui/overlays.js';
import { App } from '../../src/cli/tui/App.js';
import { TuiStore, type ClientLike } from '../../src/cli/tui/store.js';
import { installMouse } from '../../src/cli/tui/mouse.js';
import { stripAnsi } from '../../src/cli/ansi.js';
import { viewFromSnapshot } from '../../src/shared/reducer.js';
import { AGENT_IDS, type AgentId, type AgentModels, type SessionConfig, type Settings } from '../../src/shared/types.js';
import { project, snapshot } from './fixture.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 90));
let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); cleanup = undefined; });

function harness({ agent, developer = 'codex', app = false, fail = false }: { agent?: AgentId; developer?: AgentId; app?: boolean; fail?: boolean } = {}) {
  const snap = snapshot();
  snap.session = { ...snap.session, config: { ...snap.session.config, developer, models: { codex: { model: 'gpt-beta', effort: 'high' }, claude: { model: 'opus', effort: 'medium' }, freebuff: { model: 'auto' } } } };
  const catalog = Object.fromEntries(AGENT_IDS.map((a) => [a, {
    agent: a, installed: true, discoveredVia: 'fixture',
    models: (a === 'codex' ? ['gpt-alpha', 'gpt-beta', 'gpt-gamma'] : a === 'freebuff' ? ['glm-5.3-flash', 'auto'] : ['opus', 'sonnet']).map((id) => ({ id, label: id, source: 'catalog', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' })),
  }])) as Record<AgentId, AgentModels>;
  const update = vi.fn(async (_id: string, body: { config: Partial<SessionConfig> }) => {
    if (fail) throw new Error('Connection lost');
    return { ...snap.session, config: { ...snap.session.config, ...body.config }, updatedAt: Date.now() };
  });
  const models = vi.fn(async () => catalog);
  const client = { models, updateSession: update, sessions: async () => [], validateModel: vi.fn(async () => ({ ok: true, checkedAt: Date.now() })) } as unknown as ClientLike;
  const store = new TuiStore(client, { live: false, project, view: viewFromSnapshot(snap) });
  let output = '';
  const stdout = new Writable({ write(chunk, _enc, done) { output += String(chunk); done(); } });
  Object.assign(stdout, { isTTY: true, columns: 56, rows: 24 });
  const stdin = new PassThrough();
  Object.assign(stdin, { isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {} });
  const closed = vi.fn();
  const inst = render(app ? <App store={store} cwd="/tmp" onQuit={() => {}} size={{ columns: 56, rows: 24 }} />
    : <ModelsOverlay store={store} width={56} height={16} onClose={closed} initialAgent={agent} />, {
    stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream,
    exitOnCtrlC: false, patchConsole: false, interactive: true,
  });
  const restore = installMouse(stdin as unknown as NodeJS.ReadStream, stdout as unknown as NodeJS.WriteStream);
  cleanup = () => { restore(); inst.unmount(); store.dispose(); };
  return { stdin, store, closed, update, models, client, text: () => stripAnsi(output) };
}

it('opens at the current model, stages effort changes and applies once with Enter', async () => {
  const h = harness(); await tick();
  expect(h.text()).toContain('› gpt-beta');
  expect(h.text()).toContain('● current');
  h.stdin.write('e'); await tick();
  expect(h.update).not.toHaveBeenCalled();
  h.stdin.write('\r'); await tick();
  expect(h.update).toHaveBeenCalledTimes(1);
  expect(h.update.mock.calls[0][1].config.models?.codex).toEqual({ model: 'gpt-beta', effort: 'low' });
  expect(h.closed).toHaveBeenCalledOnce();
});

it('starts on the developer tab and cycles every agent with Tab', async () => {
  const h = harness({ developer: 'claude' }); await tick();
  expect(h.text()).toContain('› opus');
  h.stdin.write('\t'); await tick(); // Claude → Freebuff
  expect(h.text()).toContain('› auto');
  h.stdin.write('\t'); await tick(); // Freebuff → Codex
  expect(h.text()).toContain('› gpt-beta');
  h.stdin.write('\x1b[B'); await tick();
  h.stdin.write('\r'); await tick();
  expect(h.update.mock.calls[0][1].config.models?.codex?.model).toBe('gpt-gamma');
  expect(h.update.mock.calls[0][1].config.models?.claude).toEqual({ model: 'opus', effort: 'medium' });
  expect(h.update.mock.calls[0][1].config.models?.freebuff).toEqual({ model: 'auto' });
});

it('filters model names and selects the result without a validation probe', async () => {
  const h = harness({ agent: 'claude' }); await tick();
  h.stdin.write('/'); await tick(); h.stdin.write('sonnet'); await tick();
  h.stdin.write('\r'); await tick();
  expect(h.update.mock.calls[0][1].config.models?.claude).toEqual({ model: 'sonnet', effort: 'medium' });
  expect(h.client.validateModel).not.toHaveBeenCalled();
  expect(h.closed).toHaveBeenCalledOnce();
});

it('clears an empty search result with Escape without changing any model', async () => {
  const h = harness(); await tick();
  h.stdin.write('/'); await tick(); h.stdin.write('missing-model'); await tick();
  h.stdin.write('\r'); await tick();
  expect(h.update).not.toHaveBeenCalled();
  expect(h.text()).toContain('No matching models');
  h.stdin.write('\x1b'); await tick();
  expect(h.closed).not.toHaveBeenCalled();
  h.stdin.write('\x1b'); await tick();
  expect(h.closed).toHaveBeenCalledOnce();
});

it('keeps the picker open and the old model when saving fails', async () => {
  const h = harness({ fail: true }); await tick();
  h.stdin.write('\x1b[B'); await tick(); h.stdin.write('\r'); await tick();
  expect(h.closed).not.toHaveBeenCalled();
  expect(h.text()).toContain('Connection lost');
  expect(h.store.currentConfig().models?.codex?.model).toBe('gpt-beta');
});

it('supports /models claude, touch agent tabs and a single tap to use a model on a phone-sized screen', async () => {
  const h = harness({ app: true }); await tick();
  h.stdin.write('/models claude'); await tick(); h.stdin.write('\r'); await tick();
  expect(h.text()).toContain('Current: opus');
  // Header occupies four rows, overlay title row 5, agent tabs row 6.
  h.stdin.write('\x1b[<0;5;6M\x1b[<0;5;6m'); await tick();
  expect(h.update).not.toHaveBeenCalled();
  h.stdin.write('\x1b[<0;7;12M\x1b[<0;7;12m'); await tick();
  expect(h.update).toHaveBeenCalledTimes(1);
  expect(h.update.mock.calls[0][1].config.models?.codex?.model).toBe('gpt-gamma');
  expect(h.store.getState().notices.at(-1)?.text).toContain('Codex → gpt-gamma');
});

it('lets phone users tap an effort and apply it without stopping current work', async () => {
  const h = harness({ app: true }); await tick();
  h.stdin.write('/model codex'); await tick(); h.stdin.write('\r'); await tick();
  h.stdin.write('\x1b[<0;12;15M\x1b[<0;12;15m'); await tick();
  expect(h.update).not.toHaveBeenCalled();
  h.stdin.write('\x1b[<0;5;16M\x1b[<0;5;16m'); await tick();
  expect(h.update).toHaveBeenCalledOnce();
  expect(h.update.mock.calls[0][1].config.models?.codex).toEqual({ model: 'gpt-beta', effort: 'low' });
  expect(h.store.getState().view?.session.status).toBe('running');
});

it('preserves the other agent when choosing a model for a new conversation', async () => {
  const settings = { models: { codex: { model: 'gpt-beta' }, claude: { model: 'sonnet' } } };
  const store = new TuiStore({} as ClientLike, { live: false, project, settings: settings as Settings, pendingConfig: { models: { codex: { model: 'gpt-alpha' } } as SessionConfig['models'] } });
  try {
    expect(await store.setModel('codex', 'gpt-gamma', 'high')).toBe(true);
    expect(store.currentConfig().models?.claude?.model).toBe('sonnet');
    expect(store.currentConfig().models?.codex).toEqual({ model: 'gpt-gamma', effort: 'high' });
  } finally { store.dispose(); }
});
