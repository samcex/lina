import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeRepo, setupEnv, waitUntil } from './helpers.js';

setupEnv();
const { startServer } = await import('../../src/server/daemon.js');
const { LinaClient } = await import('../../src/shared/client.js');
const { MockAdapter, mockCalls } = await import('../../src/server/agents/mock.js');
const { setAdapterOverride } = await import('../../src/server/agents/index.js');
const edits = new Set<string>();
const partial = new Set<string>();
const holds = new Set<string>();
const minorReviews = new Set<string>();
const claims = new Set<string>();
setAdapterOverride((agent, ctx) => ({
  id: agent,
  async runTurn(opts, onEvent) {
    const feedback = opts.prompt.startsWith('<!-- lina:step=feedback');
    if (feedback && partial.delete(ctx.sessionId!)) appendFileSync(join(opts.cwd, 'README.md'), '\nPartial feedback fix survives restart.\n');
    const result = await new MockAdapter(agent, { delayMs: 0, holdMs: holds.has(ctx.sessionId!) ? { feedback: 60000 } : undefined }).runTurn(opts, onEvent);
    if (opts.prompt.startsWith('<!-- lina:step=review') && minorReviews.has(ctx.sessionId!)) {
      return { ...result, text: 'One minor issue remains.\n```lina-review\n{"verdict":"approve","summary":"Approved with a minor note","findings":[{"id":"F1","severity":"minor","title":"Clarify documentation","detail":"Document the edge case"}],"resolved":[],"withdrawn":[]}\n```' };
    }
    if (feedback && claims.delete(ctx.sessionId!)) return { ...result, text: 'Already fixed.\n```lina-response\n{"items":[{"id":"F1","action":"fixed","note":"Claimed fixed without editing"}]}\n```' };
    if (feedback && opts.access === 'write' && edits.delete(ctx.sessionId!)) {
      appendFileSync(join(opts.cwd, 'README.md'), '\nFixed the minor issue from review.\n');
      return { ...result, text: 'Fixed the minor issue from review.\n```lina-response\n{"items":[]}\n```' };
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
async function session(maxRounds = 3) {
  const repo = makeRepo();
  const project = await api.addProject({ path: repo });
  const s = await api.createSession({ projectId: project.id, config: { mock: true, developer: 'claude', reviewer: 'codex', maxRounds } });
  return { repo, s };
}
const calls = (repo: string) => mockCalls.filter((c) => c.opts.cwd === repo);

describe('automatic reviewer feedback handoff', () => {
  it('starts the developer after approval without another owner message, then stops', async () => {
    const { repo, s } = await session();
    await api.send(s.id, 'Build hello');
    const snap = await completed(s.id);
    const sequence = calls(repo).map((c) => c.step);
    expect(sequence.slice(-2)).toEqual(['review', 'feedback']);
    expect(calls(repo).filter((c) => c.step === 'feedback')).toHaveLength(1);
    const lastReply = snap.events.filter((e) => e.type === 'message').filter((e) => e.actor === 'codex' || e.actor === 'claude').at(-1)!;
    expect(lastReply.actor).toBe('claude');
    expect(lastReply.data.text).toContain('read the reviewer feedback');
    expect(snap.events.filter((e) => e.type === 'message' && e.actor === 'user')).toHaveLength(1);
    expect(calls(repo).at(-1)?.prompt).toContain('no owner nudge or memory note is needed');
    expect(calls(repo).at(-1)?.prompt).toContain("does not expand the task's authorization");
    const count = calls(repo).length;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(calls(repo)).toHaveLength(count);
    await api.deleteSession(s.id);
  });

  it('hands a direct reviewer reply to the developer once, without running unrelated tests for an acknowledgment', async () => {
    const { repo, s } = await session();
    await api.send(s.id, 'What does this project do?');
    await completed(s.id);
    const before = calls(repo).length;
    await api.send(s.id, '@codex Please assess the current implementation');
    const snap = await completed(s.id);
    expect(calls(repo).slice(before).map((c) => `${c.agent}:${c.step}`)).toEqual(['codex:consult', 'claude:feedback']);
    expect(calls(repo).at(-1)?.prompt).toContain('codex replied to the owner');
    expect(calls(repo).at(-1)?.prompt).toContain('Please assess the current implementation');
    expect(snap.events.some((e) => e.type === 'tests' || e.type === 'review')).toBe(false);
    await api.deleteSession(s.id);
  });

  it('tests and independently reviews changes made in response to nonblocking feedback', async () => {
    const { repo, s } = await session(4);
    edits.add(s.id);
    await api.send(s.id, 'Build hello');
    const snap = await completed(s.id);
    const sequence = calls(repo).map((c) => c.step);
    const firstReply = sequence.indexOf('feedback');
    expect(sequence.slice(firstReply + 1)).toEqual(['review', 'feedback']);
    expect(readFileSync(join(repo, 'README.md'), 'utf8')).toContain('Fixed the minor issue');
    expect(snap.events.filter((e) => e.type === 'review')).toHaveLength(3);
    const nextReview = calls(repo).slice(firstReply + 1).find((c) => c.step === 'review')!;
    expect(nextReview.prompt).toContain('Fixed the minor issue from review');
    expect(nextReview.opts.access).toBe('read');
    expect(snap.events.some((e) => e.type === 'tests' && e.data.ok)).toBe(true);
    await api.deleteSession(s.id);
  });

  it('makes the final reply read-only at the round limit instead of starting an endless exchange', async () => {
    const { repo, s } = await session(2);
    edits.add(s.id);
    await api.send(s.id, 'Build hello');
    const snap = await completed(s.id);
    const feedback = calls(repo).filter((c) => c.step === 'feedback');
    expect(feedback).toHaveLength(1);
    expect(feedback[0].opts).toMatchObject({ access: 'read', fullAccess: false });
    expect(feedback[0].prompt).toContain('This reply is read-only');
    expect(readFileSync(join(repo, 'README.md'), 'utf8')).not.toContain('Fixed the minor issue');
    expect(snap.session.round).toBe(2);
    edits.delete(s.id);
    await api.deleteSession(s.id);
  });

  it('retains partial feedback edits across shutdown and reviews them after resume', async () => {
    const { repo, s } = await session(4);
    partial.add(s.id); holds.add(s.id);
    await api.send(s.id, 'Build hello');
    await waitUntil(() => readFileSync(join(repo, 'README.md'), 'utf8').includes('Partial feedback fix'), 15000);
    await srv.close();
    holds.delete(s.id);
    await start();
    expect((await api.session(s.id)).session.status).toBe('interrupted');
    await api.control(s.id, 'resume');
    const snap = await completed(s.id);
    expect(readFileSync(join(repo, 'README.md'), 'utf8')).toContain('Partial feedback fix');
    expect(snap.events.filter((e) => e.type === 'review')).toHaveLength(3);
    expect(calls(repo).filter((c) => c.step === 'review').at(-1)?.prompt).toContain('Partial feedback fix');
    await api.deleteSession(s.id);
  });

  it('keeps direct developer coding mentions in the test/review/handoff loop', async () => {
    const { repo, s } = await session();
    await api.send(s.id, 'Build hello');
    await completed(s.id);
    const before = calls(repo).length;
    await api.send(s.id, '@claude add a release note');
    const snap = await completed(s.id);
    expect(calls(repo).slice(before).map((c) => c.step)).toEqual(['consult', 'review', 'revise', 'review', 'feedback']);
    expect(readFileSync(join(repo, 'NOTES.md'), 'utf8')).toContain('add a release note');
    expect(calls(repo).slice(before).find((c) => c.step === 'review')?.prompt).toContain('NOTES.md');
    expect(snap.events.filter((e) => e.type === 'review')).toHaveLength(4);
    await api.deleteSession(s.id);
  });


  it('independently checks claimed fixes even when the developer made no measured edit', async () => {
    const { repo, s } = await session(3);
    minorReviews.add(s.id); claims.add(s.id);
    await api.send(s.id, 'Build hello');
    const snap = await completed(s.id);
    expect(calls(repo).map((c) => c.step)).toEqual(['chat', 'review', 'feedback', 'review', 'feedback']);
    expect(snap.events.filter((e) => e.type === 'review')).toHaveLength(2);
    expect(snap.findings.find((f) => f.id === 'F1')?.status).toBe('open');
    minorReviews.delete(s.id);
    await api.deleteSession(s.id);
  });

});
