import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeRepo, setupEnv, sh, waitUntil } from './helpers.js';

const home = setupEnv();
const { startServer } = await import('../../src/server/daemon.js');
const { LinaClient } = await import('../../src/shared/client.js');
const { MockAdapter, mockCalls } = await import('../../src/server/agents/mock.js');
const { setAdapterOverride } = await import('../../src/server/agents/index.js');
const holds = new Map<string, Record<string, number>>();
setAdapterOverride((agent, ctx) => new MockAdapter(agent, { delayMs: 0, holdMs: holds.get(ctx.sessionId!) }));

let srv: Awaited<ReturnType<typeof startServer>>;
let api: InstanceType<typeof LinaClient>;
beforeAll(async () => {
  srv = await startServer({ port: 0 });
  api = new LinaClient({ baseUrl: `http://127.0.0.1:${srv.port}`, token: srv.token });
});
afterAll(async () => { await srv?.close(); });

async function completed(id: string) {
  await waitUntil(async () => (await api.session(id)).session.status === 'completed', 20_000, 'direct completion');
  return api.session(id);
}

describe('direct project sessions', () => {
  it('defaults to live editing, preserves staged/unstaged/untracked owner work, and reviews the task diff', async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, 'README.md'), '# staged owner work\n');
    sh(repo, 'git', ['add', 'README.md']);
    writeFileSync(join(repo, 'README.md'), '# unstaged owner work\n');
    writeFileSync(join(repo, 'owner.txt'), 'untracked owner work\n');
    const head = sh(repo, 'git', ['rev-parse', 'HEAD']);
    const index = sh(repo, 'git', ['ls-files', '--stage']);
    const branches = sh(repo, 'git', ['branch', '--list']);
    const cfg = readFileSync(join(repo, '.git/config'), 'utf8');
    const project = await api.addProject({ path: repo });
    const s = await api.createSession({ projectId: project.id, config: { interactionMode: 'workflow', mock: true } });
    expect(s.config.workspaceMode).toBe('direct');
    expect(s.workspacePath).toBe(repo);
    expect(existsSync(join(home, 'workspaces', s.id))).toBe(false);
    expect((await api.diff(s.id)).files).toEqual([]);
    expect((await api.tree(s.id)).filter((f) => f.changed)).toEqual([]);

    holds.set(s.id, { review: 60_000 });
    await api.send(s.id, 'Build hello');
    await waitUntil(() => mockCalls.some((c) => c.opts.cwd === repo && c.step === 'review'));
    // The actual project is already edited while the reviewer is still running.
    expect(readFileSync(join(repo, 'hello.js'), 'utf8')).toContain('function hello');
    const live = await api.diff(s.id);
    expect(live.head).toBe('worktree');
    expect(live.files.map((f) => f.path).sort()).toEqual(['hello.js', 'hello.test.js']);
    expect((await api.tree(s.id)).filter((f) => f.changed && f.type === 'file').map((f) => f.path).sort()).toEqual(['hello.js', 'hello.test.js']);
    expect(sh(repo, 'git', ['ls-files', '--stage'])).toBe(index);
    expect(sh(repo, 'git', ['rev-parse', 'HEAD'])).toBe(head);
    await api.control(s.id, 'cancel');
    holds.delete(s.id);
    await api.control(s.id, 'resume');
    const snap = await completed(s.id);
    expect(snap.findings.map((f) => f.status)).toEqual(['resolved', 'withdrawn']);
    const tests = snap.events.filter((e) => e.type === 'tests');
    expect(tests.length).toBeGreaterThanOrEqual(3); // revision and final verification cannot reuse HEAD's test cache
    expect(tests.at(-1)?.data).toMatchObject({ ok: true, passed: 2 });
    expect(snap.events.some((e) => e.type === 'approval' || e.type === 'checkpoint')).toBe(false);
    const summary = snap.events.find((e) => e.type === 'message' && e.data.kind === 'summary');
    expect(summary?.data).toMatchObject({ text: expect.stringContaining('hello.js') });
    expect(summary?.data).toMatchObject({ text: expect.not.stringContaining('owner.txt') });
    const review = mockCalls.find((c) => c.opts.cwd === repo && c.step === 'review')!;
    expect(review.prompt).toContain('Live diff:');
    expect(review.prompt).toContain('function hello');
    expect(review.prompt).not.toContain('untracked owner work');
    expect(mockCalls.find((c) => c.opts.cwd === repo && c.step === 'implement')?.opts.systemPrompt).toContain('Preserve existing uncommitted changes');
    expect(mockCalls.find((c) => c.opts.cwd === repo && c.step === 'implement')?.opts).toMatchObject({ fullAccess: true, network: true });
    expect(mockCalls.find((c) => c.opts.cwd === repo && c.step === 'review')?.opts).toMatchObject({ access: 'read', fullAccess: true, network: true });
    expect(readFileSync(join(repo, 'README.md'), 'utf8')).toBe('# unstaged owner work\n');
    expect(readFileSync(join(repo, 'owner.txt'), 'utf8')).toBe('untracked owner work\n');
    expect(sh(repo, 'git', ['ls-files', '--stage'])).toBe(index);
    expect(sh(repo, 'git', ['rev-parse', 'HEAD'])).toBe(head);
    expect(sh(repo, 'git', ['branch', '--list'])).toBe(branches);
    expect(readFileSync(join(repo, '.git/config'), 'utf8')).toBe(cfg);
    await expect(api.approval(s.id, { decision: 'approve' })).rejects.toMatchObject({ status: 409 });

    const calls = mockCalls.length;
    await api.send(s.id, 'Continue with the next change');
    await completed(s.id);
    expect(mockCalls.slice(calls).some((c) => c.step === 'implement' && c.opts.resumeId)).toBe(true);
    await api.deleteSession(s.id);
    expect(existsSync(join(repo, '.git'))).toBe(true);
    expect(existsSync(join(repo, 'hello.js'))).toBe(true);
    expect(readFileSync(join(repo, 'owner.txt'), 'utf8')).toBe('untracked owner work\n');
    expect(sh(repo, 'git', ['for-each-ref', `refs/lina/baselines/${s.id}`])).toBe('');
  });

  it('prevents concurrent direct writers, and cancellation/deletion leave their edits intact', async () => {
    const repo = makeRepo();
    const project = await api.addProject({ path: repo });
    const a = await api.createSession({ projectId: project.id, config: { interactionMode: 'workflow', mock: true, mode: 'solo' } });
    const b = await api.createSession({ projectId: project.id, config: { interactionMode: 'workflow', mock: true, mode: 'solo' } });
    holds.set(a.id, { implement: 60_000 });
    await api.send(a.id, 'First task');
    await expect(api.send(b.id, 'Conflicting task')).rejects.toMatchObject({ status: 409, code: 'busy' });
    expect((await api.session(b.id)).session.status).toBe('idle');
    expect((await api.session(b.id)).events.some((e) => e.actor === 'user')).toBe(false);
    await api.control(a.id, 'cancel');
    await api.send(b.id, 'Now build hello');
    await completed(b.id);
    await api.deleteSession(a.id);
    await api.deleteSession(b.id);
    expect(existsSync(join(repo, 'hello.js'))).toBe(true);
    expect(sh(repo, 'git', ['rev-list', '--count', 'HEAD']).trim()).toBe('1');
  });

  it('validates workspace choices and keeps parallel/compete isolated', async () => {
    const project = await api.addProject({ path: makeRepo() });
    await expect(api.createSession({ projectId: project.id, config: { workspaceMode: 'typo' as never } })).rejects.toMatchObject({ status: 400 });
    for (const mode of ['parallel', 'compete'] as const) {
      await expect(api.createSession({ projectId: project.id, config: { mode, workspaceMode: 'direct' } })).rejects.toMatchObject({ status: 400 });
      const s = await api.createSession({ projectId: project.id, config: { mode, mock: true } });
      expect(s.config.workspaceMode).toBe('isolated');
      expect(s.workspacePath).not.toBe(project.path);
      await api.deleteSession(s.id);
    }
    const s = await api.createSession({ projectId: project.id, config: { interactionMode: 'workflow', mock: true } });
    await expect(api.updateSession(s.id, { config: { workspaceMode: 'isolated' } })).rejects.toMatchObject({ status: 409 });
    await expect(api.updateSession(s.id, { config: { mode: 'parallel' } })).rejects.toMatchObject({ status: 400 });
    await api.deleteSession(s.id);
  });

  it('applies access changes to the next developer turn in an existing session', async () => {
    expect((await api.getSettings()).accessMode).toBe('full');
    await expect(api.putSettings({ accessMode: 'unknown' as never })).rejects.toMatchObject({ status: 400 });
    const project = await api.addProject({ path: makeRepo() });
    const s = await api.createSession({ projectId: project.id, config: { interactionMode: 'workflow', mock: true, mode: 'solo' } });
    try {
      await api.putSettings({ accessMode: 'restricted' });
      let start = mockCalls.length;
      await api.send(s.id, 'Build hello with restricted access');
      await completed(s.id);
      expect(mockCalls.slice(start).find((c) => c.step === 'implement')?.opts).toMatchObject({ fullAccess: false, network: false });
      await api.putSettings({ accessMode: 'full' });
      start = mockCalls.length;
      await api.send(s.id, 'Continue with full access');
      const snap = await completed(s.id);
      expect(mockCalls.slice(start).find((c) => c.step === 'implement')?.opts).toMatchObject({ fullAccess: true, network: true });
      expect(snap.events.filter((e) => e.type === 'tests').at(-1)?.data).toMatchObject({ sandboxed: false });
    } finally {
      await api.putSettings({ accessMode: 'full' });
      await api.deleteSession(s.id);
    }
  });

  it('preserves the isolated workflow for legacy session configs', async () => {
    const project = await api.addProject({ path: makeRepo() });
    const s = await api.createSession({ projectId: project.id, config: { interactionMode: 'workflow', mock: true, workspaceMode: 'isolated' } });
    // Simulate the persisted configuration of a pre-direct-edit session.
    const r = srv.manager.db.getSession(s.id)!;
    delete r.config.workspaceMode;
    const { migrateState } = await import('../../src/server/runner.js');
    srv.manager.db.updateSession(r, migrateState(srv.manager.db.getSessionState(s.id)));
    await srv.close();
    srv = await startServer({ port: 0 });
    api = new LinaClient({ baseUrl: `http://127.0.0.1:${srv.port}`, token: srv.token });
    // Existing legacy configs resolve as isolated when patched as well.
    expect((await api.session(s.id)).session.config.workspaceMode).toBeUndefined();
    const updated = await api.updateSession(s.id, { title: 'Legacy session', config: { maxRounds: 2 } });
    expect(updated.config.workspaceMode).toBe('isolated');
    expect(updated.workspacePath).not.toBe(project.path);
    await api.send(s.id, 'Build hello separately');
    await waitUntil(async () => (await api.session(s.id)).session.status === 'awaiting_approval');
    expect(existsSync(join(project.path, 'hello.js'))).toBe(false);
    await api.approval(s.id, { decision: 'approve' });
    expect(existsSync(join(project.path, 'hello.js'))).toBe(true);
    await api.deleteSession(s.id);
  });
});
