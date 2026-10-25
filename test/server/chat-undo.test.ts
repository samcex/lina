import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeRepo, setupEnv, sh, waitUntil } from './helpers.js';
import { TuiStore } from '../../src/cli/tui/store.js';

setupEnv();
const { startServer } = await import('../../src/server/daemon.js');
const { LinaClient } = await import('../../src/shared/client.js');
const { mockCalls, MockAdapter } = await import('../../src/server/agents/mock.js');
const { setAdapterOverride } = await import('../../src/server/agents/index.js');
const holds = new Map<string, Record<string, number>>();
setAdapterOverride((agent, ctx) => new MockAdapter(agent, { delayMs: 0, holdMs: holds.get(ctx.sessionId!) }));
const { TurnHistory } = await import('../../src/server/undo.js');
const { Db } = await import('../../src/server/db.js');
let srv: Awaited<ReturnType<typeof startServer>>;
let api: InstanceType<typeof LinaClient>;
beforeAll(async () => { srv = await startServer({ port: 0 }); api = new LinaClient({ baseUrl: `http://127.0.0.1:${srv.port}`, token: srv.token }); });
afterAll(async () => { await srv.close(); });
async function done(id: string) { await waitUntil(async () => (await api.session(id)).session.status === 'completed', 20_000); return api.session(id); }

describe('natural conversations', () => {
  it('starts a goal from the TUI, runs implementation/tests/review and persists the objective', async () => {
    const repo = makeRepo();
    const project = await api.addProject({ path: repo });
    const store = new TuiStore(api, { project, live: false, pendingConfig: { mock: true, mode: 'pair', stepMode: true } });
    await store.goal('Build hello');
    const id = store.getState().sessionId!;
    expect(id).toBeTruthy();
    const snap = await done(id);
    expect(snap.session.config.goal).toBe('Build hello');
    expect(snap.session.config.interactionMode).toBe('workflow');
    expect(snap.session.config.stepMode).not.toBe(true);
    expect(snap.events.some((e) => e.type === 'tests' && e.data.ok)).toBe(true);
    expect(mockCalls.some((c) => c.opts.cwd === repo && c.step === 'review')).toBe(true);
    expect(readFileSync(join(repo, 'hello.js'), 'utf8')).toContain('hello');
    await srv.close();
    srv = await startServer({ port: 0 });
    api = new LinaClient({ baseUrl: `http://127.0.0.1:${srv.port}`, token: srv.token });
    expect((await api.session(id)).session.config.goal).toBe('Build hello');
    store.dispose();
    await api.deleteSession(id);
  });
  it('resumes a chat interrupted by daemon shutdown and still verifies its earlier partial changes', async () => {
    const repo = makeRepo();
    const project = await api.addProject({ path: repo });
    const s = await api.createSession({ projectId: project.id, config: { mock: true, mode: 'solo' } });
    holds.set(s.id, { chat: 60_000 });
    await api.send(s.id, 'Build hello');
    await waitUntil(() => existsSync(join(repo, 'hello.js')));
    await srv.close();
    holds.delete(s.id);
    srv = await startServer({ port: 0 });
    api = new LinaClient({ baseUrl: `http://127.0.0.1:${srv.port}`, token: srv.token });
    expect((await api.session(s.id)).session.status).toBe('interrupted');
    await api.control(s.id, 'resume');
    const snap = await done(s.id);
    expect(snap.events.some((e) => e.type === 'tests' && e.data.ok)).toBe(true);
    expect(snap.events.some((e) => e.type === 'approval')).toBe(false);
    expect((await api.turnChanges(s.id)).some((t) => t.status === 'ready')).toBe(true);
    await api.deleteSession(s.id);
  });
  it('keeps queued questions as the next chat message and preserves partial edits through cancellation/restart', async () => {
    const repo = makeRepo();
    const project = await api.addProject({ path: repo });
    const s = await api.createSession({ projectId: project.id, config: { mock: true, mode: 'solo' } });
    holds.set(s.id, { chat: 60_000 });
    await api.send(s.id, 'Build hello');
    await waitUntil(() => existsSync(join(repo, 'hello.js')));
    const queued = await api.send(s.id, 'Why does this code work?');
    expect(queued.queued).toBe(true);
    await api.control(s.id, 'cancel');
    expect((await api.turnChanges(s.id))[0].status).toBe('ready');
    expect(existsSync(join(repo, 'hello.js'))).toBe(true);
    holds.delete(s.id);
    await srv.close();
    srv = await startServer({ port: 0 });
    api = new LinaClient({ baseUrl: `http://127.0.0.1:${srv.port}`, token: srv.token });
    await api.control(s.id, 'resume');
    const snap = await done(s.id);
    expect(snap.session.pendingMessages).toBe(0);
    const chats = mockCalls.filter((c) => c.opts.cwd === repo && c.step === 'chat');
    expect(chats.at(-1)?.prompt).toContain('Why does this code work?');
    expect(chats.at(-1)?.prompt).not.toContain('Request from the project owner:\nBuild hello');
    expect(mockCalls.some((c) => c.opts.cwd === repo && c.step === 'deliver')).toBe(false);
    expect(snap.events.some((e) => e.type === 'tests')).toBe(true); // interrupted original edit still verified
    expect(chats.every((c) => c.opts.fullAccess && c.opts.network)).toBe(true);
    await api.deleteSession(s.id);
  });
  it('answers questions without planning, edits, tests or reviews, and resumes the conversation for coding', async () => {
    const repo = makeRepo();
    const project = await api.addProject({ path: repo });
    const s = await api.createSession({ projectId: project.id, config: { mock: true }, prompt: 'What does this project do?' });
    expect(s.config.interactionMode).toBe('chat');
    const first = await done(s.id);
    expect(mockCalls.filter((c) => c.opts.cwd === repo).map((c) => c.step)).toEqual(['chat']);
    expect(first.events.some((e) => e.type === 'tests' || e.type === 'review')).toBe(false);
    expect(sh(repo, 'git', ['status', '--porcelain'])).toBe('');
    expect(await api.turnChanges(s.id)).toEqual([]);
    await api.send(s.id, 'Build hello');
    const built = await done(s.id);
    expect(mockCalls.filter((c) => c.opts.cwd === repo && c.step === 'chat').at(-1)?.opts.resumeId).toBeTruthy();
    expect(built.events.some((e) => e.type === 'tests' && e.data.ok)).toBe(true);
    expect(built.events.some((e) => e.type === 'review')).toBe(true);
    expect(existsSync(join(repo, 'hello.js'))).toBe(true);
    const turns = await api.turnChanges(s.id);
    expect(turns.filter((t) => t.status === 'ready').length).toBeGreaterThanOrEqual(2);
    const original = turns.find((t) => t.files.some((f) => f.path === 'hello.js' && f.status === 'added'))!;
    expect((await api.turnDiff(s.id, original.turn)).files.map((f) => f.path)).toContain('hello.js');
    // Later revision must be undone before the initial addition can be removed.
    await expect(api.undo(s.id, original.turn)).rejects.toMatchObject({ status: 409, code: 'undo_conflict' });
    const terminal = new TuiStore(api, { project, live: false });
    await terminal.openSession(s.id);
    await terminal.changes(original.turn);
    expect(terminal.getState().notices.at(-1)?.text).toContain('hello.js');
    await terminal.undo();
    await terminal.undo(original.turn);
    expect(terminal.getState().notices.at(-1)?.level).toBe('success');
    terminal.dispose();
    expect(existsSync(join(repo, 'hello.js'))).toBe(false);
    expect(sh(repo, 'git', ['status', '--porcelain'])).toBe('');
    expect((await api.session(s.id)).findings).toEqual([]);
    await api.send(s.id, 'Why is it gone?');
    await done(s.id);
    expect(mockCalls.filter((c) => c.opts.cwd === repo && c.step === 'chat').at(-1)?.prompt).toContain('owner undid writing turn');
    await api.deleteSession(s.id);
  });

  it('lets the developer skip unnecessary verification for a documentation-only edit', async () => {
    const project = await api.addProject({ path: makeRepo() });
    const s = await api.createSession({ projectId: project.id, config: { mock: true }, prompt: 'Update documentation only' });
    const snap = await done(s.id);
    expect(snap.events.some((e) => e.type === 'review')).toBe(false);
    expect(snap.events.some((e) => e.type === 'message' && e.data.kind === 'summary' && /0 round\(s\).*approved/.test(e.data.text))).toBe(false);
    expect(snap.events.filter((e) => e.type === 'tests').every((e) => e.data.skippedReason?.includes('unnecessary'))).toBe(true);
    expect(snap.events.some((e) => e.type === 'message' && e.data.kind === 'chat' && /```lina-chat/.test(e.data.text))).toBe(false);
    const changes = await api.turnChanges(s.id);
    await srv.close();
    srv = await startServer({ port: 0 });
    api = new LinaClient({ baseUrl: `http://127.0.0.1:${srv.port}`, token: srv.token });
    expect(await api.turnChanges(s.id)).toEqual(changes);
    await api.undo(s.id);
    expect(existsSync(join(project.path, 'NOTES.md'))).toBe(false);
    await api.deleteSession(s.id);
  });
});

describe('working-file snapshots', () => {
  it('retains an incomplete snapshot but refuses automatic undo without a known after-state', async () => {
    const repo = makeRepo(); const db = new Db(':memory:'); const history = new TurnHistory(db);
    try {
      await history.begin('incomplete-test', repo, 1, 'codex', 'implementing');
      writeFileSync(join(repo, 'README.md'), 'possibly edited during an outage');
      await expect(history.undo('incomplete-test', repo, 1)).rejects.toMatchObject({ status: 409 });
      expect(readFileSync(join(repo, 'README.md'), 'utf8')).toBe('possibly edited during an outage');
    } finally { await history.remove('incomplete-test', repo); db.close(); }
  });
  it('restores file/directory transitions and preserves unrelated directory contents', async () => {
    const repo = makeRepo({ 'thing': 'original file', '.gitignore': '*.cache\n' });
    const db = new Db(':memory:'); const history = new TurnHistory(db);
    try {
      const turn = await history.begin('directory-test', repo, 1, 'codex', 'implementing');
      rmSync(join(repo, 'thing')); mkdirSync(join(repo, 'thing')); writeFileSync(join(repo, 'thing/child'), 'agent child');
      await history.finish('directory-test', repo, turn);
      writeFileSync(join(repo, 'thing/owner'), 'later owner file');
      await expect(history.undo('directory-test', repo)).rejects.toMatchObject({ status: 409 });
      rmSync(join(repo, 'thing/owner'));
      writeFileSync(join(repo, 'thing/ignored.cache'), 'ignored later owner data');
      await expect(history.undo('directory-test', repo)).rejects.toMatchObject({ status: 409 });
      expect(readFileSync(join(repo, 'thing/child'), 'utf8')).toBe('agent child');
      expect(readFileSync(join(repo, 'thing/ignored.cache'), 'utf8')).toBe('ignored later owner data');
      rmSync(join(repo, 'thing/ignored.cache'));
      await history.undo('directory-test', repo);
      expect(readFileSync(join(repo, 'thing'), 'utf8')).toBe('original file');
    } finally { await history.remove('directory-test', repo); db.close(); }
  });
  it('restores binary, deleted, renamed and executable files while preserving the index and unrelated owner edits', async () => {
    const repo = makeRepo({ 'gone.txt': 'restore me', 'rename.txt': 'rename me', 'run.sh': '#!/bin/sh\necho before\n' });
    const db = new Db(':memory:');
    const history = new TurnHistory(db);
    try {
      writeFileSync(join(repo, 'README.md'), 'staged owner content'); sh(repo, 'git', ['add', 'README.md']);
      writeFileSync(join(repo, 'README.md'), 'unstaged owner content');
      writeFileSync(join(repo, 'binary.bin'), Buffer.from([0, 255, 128, 7]));
      chmodSync(join(repo, 'run.sh'), 0o755);
      const index = sh(repo, 'git', ['ls-files', '--stage']);
      const head = sh(repo, 'git', ['rev-parse', 'HEAD']);
      const turn = await history.begin('snapshot-test', repo, 1, 'codex', 'implementing');
      rmSync(join(repo, 'gone.txt')); renameSync(join(repo, 'rename.txt'), join(repo, 'renamed.txt'));
      writeFileSync(join(repo, 'run.sh'), '#!/bin/sh\necho after\n'); chmodSync(join(repo, 'run.sh'), 0o644);
      writeFileSync(join(repo, 'binary.bin'), Buffer.from([0, 1, 0, 2]));
      symlinkSync('run.sh', join(repo, 'new-link'));
      await history.finish('snapshot-test', repo, turn);
      writeFileSync(join(repo, 'other.txt'), 'later unrelated owner work');
      await history.undo('snapshot-test', repo);
      expect(readFileSync(join(repo, 'binary.bin'))).toEqual(Buffer.from([0, 255, 128, 7]));
      expect(readFileSync(join(repo, 'gone.txt'), 'utf8')).toBe('restore me');
      expect(readFileSync(join(repo, 'rename.txt'), 'utf8')).toBe('rename me');
      expect(existsSync(join(repo, 'renamed.txt'))).toBe(false);
      expect(existsSync(join(repo, 'new-link'))).toBe(false);
      expect(readFileSync(join(repo, 'README.md'), 'utf8')).toBe('unstaged owner content');
      expect(readFileSync(join(repo, 'other.txt'), 'utf8')).toBe('later unrelated owner work');
      expect(statSync(join(repo, 'run.sh')).mode & 0o111).not.toBe(0);
      expect(sh(repo, 'git', ['ls-files', '--stage'])).toBe(index);
      expect(sh(repo, 'git', ['rev-parse', 'HEAD'])).toBe(head);
      await expect(history.undo('snapshot-test', repo, 1)).rejects.toMatchObject({ status: 409 });
    } finally { await history.remove('snapshot-test', repo); db.close(); }
  });

  it('refuses to overwrite later owner edits and leaves every affected file untouched', async () => {
    const repo = makeRepo({ 'a.txt': 'a', 'b.txt': 'b' });
    const db = new Db(':memory:'); const history = new TurnHistory(db);
    const turn = await history.begin('conflict-test', repo, 1, 'claude', 'implementing');
    writeFileSync(join(repo, 'a.txt'), 'agent a'); writeFileSync(join(repo, 'b.txt'), 'agent b');
    await history.finish('conflict-test', repo, turn);
    writeFileSync(join(repo, 'b.txt'), 'later owner edit');
    await expect(history.undo('conflict-test', repo)).rejects.toMatchObject({ status: 409, code: 'undo_conflict' });
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('agent a');
    expect(readFileSync(join(repo, 'b.txt'), 'utf8')).toBe('later owner edit');
    await history.remove('conflict-test', repo); db.close();
  });

  it('preserves raw CRLF bytes despite git attributes and rejects symlink-parent substitutions', async () => {
    const repo = makeRepo({ '.gitattributes': '*.txt text eol=lf\n' });
    mkdirSync(join(repo, 'folder'));
    writeFileSync(join(repo, 'folder/file.txt'), 'owner\r\noriginal\r\n');
    const db = new Db(':memory:'); const history = new TurnHistory(db);
    try {
      const turn = await history.begin('raw-test', repo, 1, 'codex', 'implementing');
      writeFileSync(join(repo, 'folder/file.txt'), 'agent\r\nupdated\r\n');
      await history.finish('raw-test', repo, turn);
      await history.undo('raw-test', repo);
      expect(readFileSync(join(repo, 'folder/file.txt'), 'utf8')).toBe('owner\r\noriginal\r\n');
      const second = await history.begin('raw-test', repo, 2, 'codex', 'implementing');
      writeFileSync(join(repo, 'folder/file.txt'), 'agent changed again');
      await history.finish('raw-test', repo, second);
      renameSync(join(repo, 'folder'), join(repo, 'outside'));
      symlinkSync('outside', join(repo, 'folder'));
      await expect(history.undo('raw-test', repo, 2)).rejects.toMatchObject({ status: 409, code: 'undo_conflict' });
      expect(readFileSync(join(repo, 'outside/file.txt'), 'utf8')).toBe('agent changed again');
    } finally { await history.remove('raw-test', repo); db.close(); }
  });
});
