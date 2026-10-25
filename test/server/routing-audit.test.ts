import { renameSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeRepo, setupEnv, sh, waitUntil } from './helpers.js';

setupEnv();
const { startServer } = await import('../../src/server/daemon.js');
const { LinaClient } = await import('../../src/shared/client.js');
const { MockAdapter, mockCalls } = await import('../../src/server/agents/mock.js');
const { setAdapterOverride } = await import('../../src/server/agents/index.js');
const failures = new Set<string>();
const commits = new Set<string>();
const held = new Set<string>();
const attemptedQuestions: string[] = [];
setAdapterOverride((agent, ctx) => ({
  id: agent,
  async runTurn(opts, onEvent) {
    if (opts.prompt.startsWith('<!-- lina:step=consult')) {
      attemptedQuestions.push(opts.prompt);
      if (failures.delete(ctx.sessionId!)) return { ok: false, text: '', usage: {}, durationMs: 0, error: { code: 'auth', message: 'Temporary login failure' } };
    }
    const result = await new MockAdapter(agent, { delayMs: 0, holdMs: held.has(ctx.sessionId!) ? { chat: 60000 } : undefined }).runTurn(opts, onEvent);
    if (commits.has(ctx.sessionId!) && opts.access === 'write' && sh(opts.cwd, 'git', ['status', '--porcelain']).trim()) {
      sh(opts.cwd, 'git', ['add', 'hello.js', 'hello.test.js']);
      sh(opts.cwd, 'git', ['commit', '-qm', 'Owner-requested implementation commit']);
    }
    return result;
  },
}));
let srv: Awaited<ReturnType<typeof startServer>>;
let api: InstanceType<typeof LinaClient>;
async function start() {
  srv = await startServer({ port: 0 });
  api = new LinaClient({ baseUrl: `http://127.0.0.1:${srv.port}`, token: srv.token });
}
beforeAll(start);
afterAll(async () => { await srv.close(); });
async function completed(id: string) {
  await waitUntil(async () => (await api.session(id)).session.status === 'completed', 15000);
  return api.session(id);
}
async function session() {
  const repo = makeRepo();
  const project = await api.addProject({ path: repo });
  const s = await api.createSession({ projectId: project.id, config: { mock: true, mode: 'solo' } });
  return { repo, s };
}

describe('request, workspace and permission audit', () => {
  it('shares both agents and owner context with ordinary chat, including a fresh developer after a role switch', async () => {
    const { repo, s } = await session();
    srv.manager.events.append(s.id, 'message', 'claude', { id: 'handoff', kind: 'chat', text: 'Implemented in /actual/project; tests still need independent verification.' });
    for (let i=0;i<12;i++) srv.manager.events.append(s.id, 'message', 'codex', { id: `note-${i}`, kind: 'chat', text: `Codex follow-up ${i}` });
    await api.updateSession(s.id, { config: { developer: 'claude' } });
    await api.send(s.id, 'Why did Codex ask for another check?');
    await completed(s.id);
    const call = mockCalls.filter((c) => c.opts.cwd === repo && c.step === 'chat').at(-1)!;
    expect(call.agent).toBe('claude');
    expect(call.opts.resumeId).toBeUndefined();
    expect(call.prompt).toContain(`Your current workspace: ${repo}`);
    expect(call.prompt).toContain('[user]\nWhy did Codex');
    expect(call.prompt).toContain('[claude]\nImplemented in /actual/project');
    expect(call.prompt).toContain('[codex]\nCodex follow-up 11');
    expect(call.prompt).not.toContain('Codex follow-up 0');
    expect(call.prompt).toContain('agent claims are not verified evidence');
    expect(call.prompt).toContain('do not repeat historical requests');
    await api.deleteSession(s.id);
  });

  it('retains the end of long handoffs, where delivery paths and remaining limitations often appear', async () => {
    const { s } = await session();
    srv.manager.events.append(s.id, 'message', 'claude', { id: 'long-handoff', kind: 'chat', text: 'Start\n' + 'x'.repeat(12000) + '\nActual project: /actual/project. Tests not run.' });
    const messages = srv.manager.db.recentConversation(s.id, 'codex');
    expect(messages[0].text).toMatch(/^Start/);
    expect(messages[0].text).toContain('[middle omitted]');
    expect(messages[0].text).toMatch(/Actual project: \/actual\/project\. Tests not run\.$/);
    expect(messages[0].text.length).toBeLessThan(10100);
    await api.deleteSession(s.id);
  });

  it('rejects a missing workspace before accepting a message, preserving history and avoiding agent launches', async () => {
    const { repo, s } = await session();
    const before = await api.session(s.id);
    const calls = mockCalls.length;
    renameSync(repo, repo + '.moved');
    try {
      await expect(api.send(s.id, '@claude inspect this project')).rejects.toMatchObject({ status: 409, code: 'workspace_missing' });
      const after = await api.session(s.id);
      expect(after.session.title).toBe(before.session.title);
      expect(after.session.status).toBe(before.session.status);
      expect(after.events).toEqual(before.events);
      expect(mockCalls.length).toBe(calls);
    } finally { renameSync(repo + '.moved', repo); }
    await api.deleteSession(s.id);
  });

  it.each(['failed', 'crashed'] as const)('retries the actual @mention after %s recovery, rather than silently resuming the previous task', async (recovery) => {
    const { repo, s } = await session();
    await api.send(s.id, 'What does this project do?');
    await completed(s.id);
    failures.add(s.id);
    const before = attemptedQuestions.length;
    await api.send(s.id, '@claude Please assess the actual changes');
    await waitUntil(async () => (await api.session(s.id)).session.status === 'failed');
    if (recovery === 'crashed') srv.manager.db.sql.prepare("UPDATE sessions SET status = 'running' WHERE id = ?").run(s.id);
    await srv.close();
    await start();
    expect((await api.session(s.id)).session.status).toBe(recovery === 'crashed' ? 'interrupted' : 'failed');
    await api.control(s.id, 'resume');
    const snap = await completed(s.id);
    expect(attemptedQuestions.slice(before)).toHaveLength(2);
    expect(attemptedQuestions.slice(before).every((p) => p.includes('addresses you directly:\nPlease assess the actual changes'))).toBe(true);
    expect(snap.events.some((e) => e.type === 'message' && e.actor === 'claude' && e.data.text.includes('Please assess the actual changes'))).toBe(true);
    expect(mockCalls.filter((c) => c.opts.cwd === repo && c.step === 'chat')).toHaveLength(1);
    await api.deleteSession(s.id);
  });

  it('reviews a measured baseline even after an explicit commit and reports the actual clean working tree', async () => {
    const { repo, s } = await session();
    await api.updateSession(s.id, { config: { mode: 'pair', developer: 'codex', reviewer: 'claude' } });
    const oldHead = sh(repo, 'git', ['rev-parse', 'HEAD']);
    commits.add(s.id);
    await api.send(s.id, 'Build hello and commit the requested files');
    const snap = await completed(s.id);
    expect(sh(repo, 'git', ['rev-parse', 'HEAD'])).not.toBe(oldHead);
    expect(sh(repo, 'git', ['status', '--porcelain'])).toBe('');
    const review = mockCalls.find((c) => c.opts.cwd === repo && c.step === 'review')!;
    expect(review.prompt).toContain('may be uncommitted or explicitly committed');
    expect(review.prompt).toContain('hello.js');
    expect(review.opts.access).toBe('read');
    expect(snap.events.some((e) => e.type === 'message' && e.data.kind === 'notice' && e.data.text.includes('working tree is clean'))).toBe(true);
    expect(snap.events.some((e) => e.type === 'message' && e.data.kind === 'summary' && e.data.text.includes('hello.js'))).toBe(true);
    expect((await api.turnChanges(s.id)).some((t) => t.files.some((f) => f.path === 'hello.js'))).toBe(true);
    await api.deleteSession(s.id);
  });

  it('allows explicit deletion of session records after their workspace was removed', async () => {
    const { repo, s } = await session();
    await api.send(s.id, 'Build hello');
    await completed(s.id);
    expect((await api.turnChanges(s.id)).length).toBeGreaterThan(0);
    renameSync(repo, repo + '.moved');
    try {
      await api.deleteSession(s.id);
      await expect(api.session(s.id)).rejects.toMatchObject({ status: 404 });
      expect(srv.manager.db.sql.prepare('SELECT COUNT(*) AS n FROM turn_changes WHERE session_id = ?').get(s.id)).toMatchObject({ n: 0 });
    } finally { renameSync(repo + '.moved', repo); }
  });

  it('prevents role changes during an active turn and leaves rejected title/config updates atomic', async () => {
    const { repo, s } = await session();
    held.add(s.id);
    try {
      await api.send(s.id, 'What is in this project?');
      await waitUntil(() => mockCalls.some((c) => c.opts.cwd === repo && c.step === 'chat'));
      const before = (await api.session(s.id)).session;
      await expect(api.updateSession(s.id, { title: 'Should not persist', config: { developer: 'claude' } })).rejects.toMatchObject({ status: 409, code: 'busy' });
      const after = (await api.session(s.id)).session;
      expect(after.config).toEqual(before.config);
      expect(after.title).toBe(before.title);
      await api.control(s.id, 'cancel');
      await expect(api.updateSession(s.id, { title: 'Also should not persist', config: { workspaceMode: 'isolated' } })).rejects.toMatchObject({ status: 400, code: 'invalid' });
      expect((await api.session(s.id)).session.title).toBe(before.title);
    } finally {
      held.delete(s.id);
      await api.deleteSession(s.id);
    }
  });

});
