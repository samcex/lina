// Modes v2: custom, parallel, compete, plus concurrency, provider-session keying and session.deleted.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeRepo, setupEnv, sh, WsClient } from './helpers.js';
import type { AgentId, AnyLinaEvent, LinaEvent } from '../../src/shared/types.js';

setupEnv();
const { startServer } = await import('../../src/server/daemon.js');
const { LinaClient } = await import('../../src/shared/client.js');
const { mockCalls, MockAdapter } = await import('../../src/server/agents/mock.js');
const { setAdapterOverride } = await import('../../src/server/agents/index.js');
type MockOptions = NonNullable<ConstructorParameters<typeof MockAdapter>[1]>;
/** Per-session mock options, per agent. */
const perSession = new Map<string, (agent: AgentId) => MockOptions | undefined>();
setAdapterOverride((agent, ctx) => {
  const o = ctx.sessionId ? perSession.get(ctx.sessionId)?.(agent) : undefined;
  return o ? new MockAdapter(agent, o) : undefined;
});

let srv: Awaited<ReturnType<typeof startServer>>;
let api: InstanceType<typeof LinaClient>;
let ws: WsClient;

beforeAll(async () => {
  srv = await startServer({ port: 0 });
  api = new LinaClient({ baseUrl: `http://127.0.0.1:${srv.port}`, token: srv.token });
  ws = new WsClient(srv.port, srv.token);
  await ws.open();
});
afterAll(async () => { ws?.close(); await srv?.close(); });

const ofType = <T extends AnyLinaEvent['type']>(evs: AnyLinaEvent[], t: T) => evs.filter((e) => e.type === t) as LinaEvent<T>[];
/** Mock calls in the session workspace or one of its worktrees. */
const callsFor = (wsPath: string) => mockCalls.filter((c) => c.opts.cwd === wsPath || c.opts.cwd.startsWith(wsPath + '--'));
const steps = (wsPath: string) => callsFor(wsPath).map((c) => `${c.agent}:${c.step}`);
const state = (id: string) => srv.manager.db.getSessionState<Record<string, unknown>>(id)!;

async function newSession(config: Record<string, unknown> = {}, opts?: (agent: AgentId) => MockOptions | undefined) {
  const repo = makeRepo();
  const project = await api.addProject({ path: repo });
  const session = await api.createSession({ projectId: project.id, config: { workspaceMode: 'isolated', mock: true, ...config } });
  if (opts) perSession.set(session.id, opts);
  ws.send({ op: 'subscribe', sessionId: session.id, since: 0 });
  await ws.waitFor(() => ws.msgs.some((m) => m.kind === 'snapshot' && m.sessionId === session.id), 5000, 'snapshot');
  return { repo, project, session };
}

describe('custom mode', () => {
  it('runs a planner/critic combination and two concurrent reviewers, one of them the developer itself', async () => {
    const team = { planner: 'claude', planCritic: 'codex', developer: 'codex', reviewers: ['codex', 'claude'] };
    const { session } = await newSession({ mode: 'custom', team });
    expect(session.config.team).toEqual(team);
    expect(session.config.developer).toBe('codex');
    expect(session.config.reviewer).toBe('codex'); // the first reviewer — here a self-review
    await api.send(session.id, 'Custom team task');
    await ws.waitStatus(session.id, 'awaiting_approval');
    const s = steps(session.workspacePath);
    expect(s.slice(0, 3)).toEqual(['claude:plan', 'codex:plan_review', 'codex:implement']);
    const calls = callsFor(session.workspacePath);
    expect(calls[1].prompt).toContain("claude's plan");
    expect(calls[2].prompt).toContain('Plan (drafted by claude)');
    expect(calls[2].prompt).toContain("Architect's critique");
    // round 1: both review; codex fixes; round 2: both review again
    expect(s.slice(3).filter((x) => x.endsWith(':review')).sort()).toEqual(['claude:review', 'claude:review', 'codex:review', 'codex:review']);
    expect(s.filter((x) => x.endsWith(':revise'))).toEqual(['codex:revise']);
    const evs = ws.persisted(session.id);
    const reviews = ofType(evs, 'review');
    expect(reviews.map((r) => `${r.data.round}:${r.data.reviewer}:${r.data.verdict}`).sort())
      .toEqual(['1:claude:request_changes', '1:codex:request_changes', '2:claude:approve', '2:codex:approve']);
    const snap = await api.session(session.id);
    expect(snap.findings).toHaveLength(4);
    expect(snap.findings.filter((f) => f.raisedBy === 'codex')).toHaveLength(2);
    expect(snap.findings.map((f) => f.status).sort()).toEqual(['resolved', 'resolved', 'withdrawn', 'withdrawn']);
    // each reviewer only saw its own findings as ones to judge
    const r2 = calls.filter((c) => c.step === 'review' && c.round === 2);
    for (const c of r2) {
      const own = [...c.prompt.matchAll(/^- (F\d+) \[/gm)].map((m) => m[1]);
      expect(own.every((id) => snap.findings.find((f) => f.id === id)!.raisedBy === c.agent)).toBe(true);
      expect(c.prompt).toContain('raised by the other reviewer');
    }
    // the self-review runs in codex's reviewer session (opened by its plan critique), never in its developer session
    const critique = calls.find((c) => c.step === 'plan_review')!;
    expect(critique.opts.resumeId).toBeUndefined();
    const review1 = calls.find((c) => c.agent === 'codex' && c.step === 'review')!;
    expect(review1.opts.access).toBe('read');
    expect(review1.prompt).toContain('You wrote this code in a separate session');
    const providers = state(session.id).providers as Record<string, string>;
    expect(Object.keys(providers).sort()).toEqual(['claude:reviewer@main', 'codex:developer@main', 'codex:reviewer@main']);
    expect(providers['codex:developer@main']).not.toBe(providers['codex:reviewer@main']);
    expect(review1.opts.resumeId).toBe(providers['codex:reviewer@main']);
    expect(calls.find((c) => c.step === 'implement')!.opts.resumeId).toBeUndefined(); // fresh developer session
    const revise = calls.find((c) => c.step === 'revise')!;
    expect(revise.opts.resumeId).toBe(providers['codex:developer@main']);
    expect(calls.filter((c) => c.agent === 'codex' && c.step === 'review' && c.round === 2)[0].opts.resumeId).toBe(providers['codex:reviewer@main']);
    expect(ofType(evs, 'phase').map((p) => p.data.phase)).toContain('plan_review');
  });

  it('validates the team, defaults from settings.team, and lets settings.team be cleared', async () => {
    const repo = makeRepo();
    const project = await api.addProject({ path: repo });
    const bad = (team: unknown) => api.createSession({ projectId: project.id, config: { workspaceMode: 'isolated', mock: true, mode: 'custom', team: team as never } });
    await expect(bad({ planner: null, planCritic: null, developer: 'codex', reviewers: ['codex', 'claude', 'codex'] })).rejects.toMatchObject({ status: 400 });
    await expect(bad({ planner: null, planCritic: null, developer: 'codex', reviewers: ['claude', 'claude'] })).rejects.toMatchObject({ status: 400 });
    await expect(bad({ planner: 'gpt', planCritic: null, developer: 'codex', reviewers: [] })).rejects.toMatchObject({ status: 400 });
    await expect(bad({ planner: null, planCritic: 'claude', developer: 'codex', reviewers: [] })).rejects.toMatchObject({ status: 400 });
    // pair/architect still refuse developer === reviewer
    await expect(api.createSession({ projectId: project.id, config: { workspaceMode: 'isolated', mock: true, mode: 'pair', developer: 'claude', reviewer: 'claude' } })).rejects.toMatchObject({ status: 400 });
    // custom accepts it (Claude builds, Claude reviews)
    const self = await api.createSession({ projectId: project.id, config: { workspaceMode: 'isolated', mock: true, mode: 'custom', developer: 'claude', reviewer: 'claude' } });
    expect(self.config.team).toMatchObject({ developer: 'claude', reviewers: ['claude'] });
    expect(self.config.reviewer).toBe('claude');
    // leaving custom drops the self-review
    const back = await api.updateSession(self.id, { config: { mode: 'pair' } });
    expect([back.config.developer, back.config.reviewer, back.config.team]).toEqual(['claude', 'codex', undefined]);
    // architect-like preset when nothing else is given
    const preset = await api.createSession({ projectId: project.id, config: { workspaceMode: 'isolated', mock: true, mode: 'custom', developer: 'codex' } });
    expect(preset.config.team).toEqual({ planner: 'codex', planCritic: 'claude', developer: 'codex', reviewers: ['claude'] });
    // settings.team
    await expect(api.putSettings({ team: { planner: null, planCritic: null, developer: 'codex', reviewers: ['x'] } as never })).rejects.toMatchObject({ status: 400 });
    const st = await api.putSettings({ team: { planner: null, planCritic: null, developer: 'claude', reviewers: [] } });
    expect(st.team).toEqual({ planner: null, planCritic: null, developer: 'claude', reviewers: [] });
    const fromSettings = await api.createSession({ projectId: project.id, config: { workspaceMode: 'isolated', mock: true, mode: 'custom' } });
    expect(fromSettings.config.team).toEqual(st.team);
    expect([fromSettings.config.developer, fromSettings.config.reviewer]).toEqual(['claude', 'codex']);
    const cleared = await api.putSettings({ team: null as never });
    expect(cleared.team).toBeUndefined();
    expect((await api.getSettings()).team).toBeUndefined();
  });

  it('a team without reviewers or planner runs implement → test → verify', async () => {
    const { session } = await newSession({ mode: 'custom', team: { planner: null, planCritic: null, developer: 'claude', reviewers: [] } });
    await api.send(session.id, 'No review');
    await ws.waitStatus(session.id, 'awaiting_approval');
    expect(steps(session.workspacePath)).toEqual(['claude:implement']);
  });
});

describe('parallel mode', () => {
  it('splits, builds both parts concurrently in worktrees, merges cleanly, cross-reviews and revises per owner', async () => {
    const { repo, session } = await newSession({ mode: 'parallel' });
    await api.send(session.id, 'Add hello and farewell');
    await ws.waitStatus(session.id, 'awaiting_approval');
    const evs = ws.persisted(session.id);
    const split = ofType(evs, 'split')[0];
    expect(split.data.lead).toBe('codex');
    expect(split.data.parts.map((p) => p.agent)).toEqual(['codex', 'claude']);
    expect(ofType(evs, 'message').some((m) => m.data.kind === 'plan' && m.actor === 'codex')).toBe(true);
    expect(ofType(evs, 'phase').map((p) => p.data.phase).slice(0, 4)).toEqual(['planning', 'implementing', 'integrating', 'testing']);
    const calls = callsFor(session.workspacePath);
    const parts = calls.filter((c) => c.step === 'part');
    expect(parts.map((c) => [c.agent, c.opts.cwd, c.opts.access]).sort()).toEqual([
      ['claude', `${session.workspacePath}--claude`, 'write'], ['codex', `${session.workspacePath}--codex`, 'write'],
    ]);
    const claudePart = parts.find((c) => c.agent === 'claude')!;
    expect(claudePart.prompt).toContain('Your part: **Farewell**');
    expect(claudePart.prompt).toContain('The other part, built by codex');
    expect(claudePart.prompt).toContain('Do NOT edit files the other part owns');
    expect(claudePart.prompt).toContain('Request from the project owner');
    expect(ofType(evs, 'checkpoint').filter((c) => c.data.variant).map((c) => c.data.variant).sort()).toEqual(['claude', 'codex']);
    const integ = ofType(evs, 'integration');
    expect(integ.map((i) => i.data.state)).toEqual(['merged']);
    // cross-review: each reviews the other's part; owners come from the parts
    const r1 = calls.filter((c) => c.step === 'cross_review' && c.round === 1);
    expect(r1.map((c) => c.agent).sort()).toEqual(['claude', 'codex']);
    expect(r1.find((c) => c.agent === 'codex')!.prompt).toContain('Focus on the part claude built');
    const snap = await api.session(session.id);
    expect(snap.findings).toHaveLength(4);
    for (const f of snap.findings) expect(f.owner).toBe(f.raisedBy === 'codex' ? 'claude' : 'codex');
    expect(snap.findings.every((f) => ['resolved', 'withdrawn'].includes(f.status))).toBe(true);
    // revise: lead first, then the other, in the main workspace
    const revs = calls.filter((c) => c.step === 'revise');
    expect(revs.map((c) => [c.agent, c.opts.cwd])).toEqual([['codex', session.workspacePath], ['claude', session.workspacePath]]);
    expect(ofType(evs, 'review').filter((r) => r.data.round === 2).every((r) => r.data.verdict === 'approve')).toBe(true);
    // views
    expect((await api.diff(session.id)).files.map((f) => f.path).sort()).toEqual(['farewell.js', 'farewell.test.js', 'hello.js', 'hello.test.js']);
    expect((await api.diff(session.id, { variant: 'claude' })).files.map((f) => f.path).sort()).toEqual(['farewell.js', 'farewell.test.js']);
    expect((await api.tree(session.id, 'codex')).some((t) => t.path === 'hello.js' && t.changed)).toBe(true);
    expect((await api.file(session.id, 'farewell.js', 'claude')).content).toContain('Goodbye');
    await expect(api.diff(session.id, { variant: 'gpt' as AgentId })).rejects.toMatchObject({ status: 400 });
    expect(snap.session.variants?.codex?.part?.title).toBe('Greeting');
    expect(snap.session.variants?.claude?.branch).toBe(`lina/${session.id.slice(0, 8)}-claude`);
    expect(ofType(evs, 'tests').at(-1)!.data).toMatchObject({ ok: true });
    await api.approval(session.id, { decision: 'approve', strategy: 'squash' });
    expect(existsSync(join(repo, 'farewell.js')) && existsSync(join(repo, 'hello.js'))).toBe(true);
  });

  it('a conflict is resolved by the lead and committed only without markers', async () => {
    const { session } = await newSession({ mode: 'parallel' }, () => ({ delayMs: 0, scenario: 'conflict' }));
    await api.send(session.id, 'Conflicting parts');
    await ws.waitStatus(session.id, 'awaiting_approval');
    const evs = ws.persisted(session.id);
    const integ = ofType(evs, 'integration');
    expect(integ.map((i) => i.data.state)).toEqual(['conflict', 'resolved']);
    expect(integ[0].data.conflicts).toEqual(['index.js']);
    const integrate = callsFor(session.workspacePath).filter((c) => c.step === 'integrate');
    expect(integrate.map((c) => [c.agent, c.opts.cwd, c.opts.access])).toEqual([['codex', session.workspacePath, 'write']]);
    expect(integrate[0].prompt).toContain('- `index.js`');
    const index = readFileSync(join(session.workspacePath, 'index.js'), 'utf8');
    expect(index).not.toMatch(/^(<<<<<<<|>>>>>>>|=======)/m);
    expect(index).toContain('hello.js');
    expect(index).toContain('farewell.js');
    sh(session.workspacePath, 'git', ['merge-base', '--is-ancestor', integ[1].data.commit!, 'HEAD']); // throws if not
    expect(sh(session.workspacePath, 'git', ['rev-list', '--parents', '-n1', integ[1].data.commit!]).trim().split(' ')).toHaveLength(3);
    expect(sh(session.workspacePath, 'git', ['status', '--porcelain']).trim()).toBe('');
  });

  it('markers left in place abort the merge and fail the step; retry runs the integration again', async () => {
    let scenario = 'conflict-stuck';
    const { session } = await newSession({ mode: 'parallel' }, () => ({ delayMs: 0, scenario }));
    await api.send(session.id, 'Stuck conflict');
    await ws.waitStatus(session.id, 'failed');
    let evs = ws.persisted(session.id);
    expect(ofType(evs, 'integration').map((i) => i.data.state)).toEqual(['conflict', 'failed']);
    expect(ofType(evs, 'error').at(-1)!.data.code).toBe('git');
    expect(sh(session.workspacePath, 'git', ['status', '--porcelain']).trim()).toBe(''); // merge aborted
    scenario = 'conflict';
    await api.control(session.id, 'retry');
    await ws.waitStatus(session.id, 'awaiting_approval');
    evs = ws.persisted(session.id);
    expect(ofType(evs, 'integration').map((i) => i.data.state)).toEqual(['conflict', 'failed', 'conflict', 'resolved']);
    expect(steps(session.workspacePath).filter((s) => s.endsWith(':part'))).toHaveLength(2); // parts not redone
  });

  it('without a usable split, one repair prompt, then the session continues as pair', async () => {
    const { session } = await newSession({ mode: 'parallel' }, () => ({ delayMs: 0, scenario: 'nosplit' }));
    await api.send(session.id, 'Unsplittable');
    await ws.waitStatus(session.id, 'awaiting_approval');
    const s = steps(session.workspacePath);
    expect(s.slice(0, 3)).toEqual(['codex:split', 'codex:split_repair', 'codex:implement']);
    expect(s).not.toContain('codex:part');
    const evs = ws.persisted(session.id);
    expect(ofType(evs, 'split')).toHaveLength(0);
    expect(ofType(evs, 'message').some((m) => m.data.kind === 'notice' && /Continuing as Developer \+ Reviewer/.test(m.data.text))).toBe(true);
    const snap = await api.session(session.id);
    expect(snap.session.config.mode).toBe('pair');
    expect(snap.session.variants).toBeUndefined();
    expect(existsSync(`${session.workspacePath}--codex`)).toBe(false);
  });
});

describe('compete mode', () => {
  async function competed(opts?: (agent: AgentId) => MockOptions | undefined) {
    const r = await newSession({ mode: 'compete' }, opts);
    await api.send(r.session.id, 'Competing hello');
    await ws.waitStatus(r.session.id, 'awaiting_approval');
    return r;
  }

  it('keeps candidate implementation context independent until cross-review', async () => {
    const { session } = await newSession({ mode: 'compete' });
    srv.manager.events.append(session.id, 'message', 'codex', { id: 'codex-handoff', kind: 'chat', variant: 'codex', text: 'PRIVATE_CODEX_DESIGN' });
    srv.manager.events.append(session.id, 'message', 'claude', { id: 'claude-handoff', kind: 'chat', variant: 'claude', text: 'PRIVATE_CLAUDE_DESIGN' });
    await api.send(session.id, 'Build independent versions');
    await ws.waitStatus(session.id, 'awaiting_approval');
    const calls = callsFor(session.workspacePath);
    for (const call of calls.filter((c) => c.step === 'compete')) {
      expect(call.prompt).toContain(call.agent === 'codex' ? 'PRIVATE_CODEX_DESIGN' : 'PRIVATE_CLAUDE_DESIGN');
      expect(call.prompt).not.toContain(call.agent === 'codex' ? 'PRIVATE_CLAUDE_DESIGN' : 'PRIVATE_CODEX_DESIGN');
    }
    expect(calls.some((c) => c.step === 'cross_review' && c.prompt.includes('PRIVATE_CODEX_DESIGN') && c.prompt.includes('PRIVATE_CLAUDE_DESIGN'))).toBe(true);
    await api.deleteSession(session.id);
  });

  it('builds two candidates, tests and cross-reviews each, and requests a choice with candidates', async () => {
    const { session } = await competed();
    const evs = ws.persisted(session.id);
    const calls = callsFor(session.workspacePath);
    const impl = calls.filter((c) => c.step === 'compete');
    expect(impl.map((c) => [c.agent, c.opts.cwd]).sort()).toEqual([['claude', `${session.workspacePath}--claude`], ['codex', `${session.workspacePath}--codex`]]);
    expect(impl[0].prompt).toMatch(/implements the same request independently/);
    // tests per variant, sequential, each carrying `variant`
    const tests = ofType(evs, 'tests');
    expect(tests.every((t) => t.data.variant)).toBe(true);
    expect(tests.slice(0, 2).map((t) => t.data.variant).sort()).toEqual(['claude', 'codex']);
    // cross-review: each agent in the other's worktree, read-only
    const xr = calls.filter((c) => c.step === 'cross_review' && c.round === 1);
    expect(xr.map((c) => [c.agent, c.opts.cwd, c.opts.access]).sort()).toEqual([
      ['claude', `${session.workspacePath}--codex`, 'read'], ['codex', `${session.workspacePath}--claude`, 'read'],
    ]);
    const reviews = ofType(evs, 'review');
    expect(reviews.map((r) => `${r.data.round}:${r.data.reviewer}->${r.data.variant}:${r.data.verdict}`).sort())
      .toEqual(['1:claude->codex:request_changes', '1:codex->claude:request_changes', '2:claude->codex:approve', '2:codex->claude:approve']);
    expect(ofType(evs, 'message').filter((m) => m.data.kind === 'review').every((m) => m.data.variant === (m.actor === 'codex' ? 'claude' : 'codex'))).toBe(true);
    const snap = await api.session(session.id);
    for (const f of snap.findings) { expect(f.variant).toBe(f.owner); expect(f.raisedBy).not.toBe(f.variant); }
    // revise: each author in its own worktree
    expect(calls.filter((c) => c.step === 'revise').map((c) => [c.agent, c.opts.cwd]).sort()).toEqual([
      ['claude', `${session.workspacePath}--claude`], ['codex', `${session.workspacePath}--codex`],
    ]);
    const approval = ofType(evs, 'approval').at(-1)!;
    expect(approval.data.state).toBe('requested');
    expect(approval.data.candidates?.map((c) => c.agent)).toEqual(['codex', 'claude']);
    for (const c of approval.data.candidates!) {
      expect(c).toMatchObject({ files: 2, openFindings: 0, blockingFindings: 0, verdict: 'approve' });
      expect(c.tests?.ok).toBe(true);
      expect(c.usage.turns).toBeGreaterThan(0);
    }
    expect(approval.data.summary).toContain('| Tests |');
    // provider sessions per agent, role and worktree
    expect(Object.keys(state(session.id).providers as object).sort()).toEqual(['claude:developer@claude', 'claude:reviewer@codex', 'codex:developer@codex', 'codex:reviewer@claude']);
    // main workspace untouched until a choice
    expect(existsSync(join(session.workspacePath, 'hello.js'))).toBe(false);
    expect((await api.file(session.id, 'hello.js', 'claude')).content).toContain('TypeError'); // revised after round 1
    expect(sh(`${session.workspacePath}--claude`, 'git', ['log', '--format=%s']).split('\n')).toContain("LINA: claude's version");
    expect(sh(`${session.workspacePath}--claude`, 'git', ['show', `HEAD~1:hello.js`])).toContain("join('')"); // its own first version
    await expect(api.approval(session.id, { decision: 'approve', strategy: 'squash' })).rejects.toMatchObject({ status: 409, code: 'choose_variant' });
  });

  it('choose adopts a candidate as a pair session; approve then applies it', async () => {
    const { repo, session } = await competed();
    await expect(api.approval(session.id, { decision: 'choose' })).rejects.toMatchObject({ status: 400 });
    const chosen = await api.approval(session.id, { decision: 'choose', variant: 'claude' });
    expect(chosen.status).toBe('awaiting_approval');
    expect(chosen.chosenVariant).toBe('claude');
    expect(chosen.config).toMatchObject({ mode: 'pair', developer: 'claude', reviewer: 'codex' });
    expect(chosen.headCommit).toBe(chosen.variants!.claude!.headCommit);
    expect(readFileSync(join(session.workspacePath, 'hello.js'), 'utf8')).toContain('TypeError');
    const snap = await api.session(session.id);
    expect(snap.findings.every((f) => f.variant === 'claude')).toBe(true);
    expect(ofType(ws.persisted(session.id), 'approval').at(-1)!.data).toMatchObject({ state: 'requested', variant: 'claude' });
    await expect(api.approval(session.id, { decision: 'choose', variant: 'codex' })).rejects.toMatchObject({ status: 409 });
    const done = await api.approval(session.id, { decision: 'approve', strategy: 'squash' });
    expect(done.status).toBe('approved');
    expect(readFileSync(join(repo, 'hello.js'), 'utf8')).toBe(readFileSync(join(`${session.workspacePath}--claude`, 'hello.js'), 'utf8'));
    expect(ofType(ws.persisted(session.id), 'approval').at(-1)!.data).toMatchObject({ state: 'approved', variant: 'claude' });
  });

  it('approve with a variant chooses and applies in one step', async () => {
    const { repo, session } = await competed();
    const s = await api.approval(session.id, { decision: 'approve', strategy: 'squash', variant: 'codex' });
    expect(s.status).toBe('approved');
    expect(s.chosenVariant).toBe('codex');
    expect(readFileSync(join(repo, 'hello.js'), 'utf8')).toBe(readFileSync(join(`${session.workspacePath}--codex`, 'hello.js'), 'utf8'));
  });

  it('an @mention while competing consults that agent in its own worktree', async () => {
    const { session } = await competed();
    const before = callsFor(session.workspacePath).length;
    await api.send(session.id, '@claude please add a line to the notes');
    await ws.waitFor(() => ofType(ws.persisted(session.id), 'checkpoint').some((c) => c.data.variant === 'claude' && c.data.message === 'LINA: consult'), 10_000, 'consult checkpoint');
    await ws.waitStatus(session.id, 'awaiting_approval');
    const c = callsFor(session.workspacePath).slice(before);
    expect(c.map((x) => [x.agent, x.step, x.opts.cwd, x.opts.access])).toEqual([['claude', 'consult', `${session.workspacePath}--claude`, 'write']]);
    expect(ofType(ws.persisted(session.id), 'message').filter((m) => m.actor === 'claude').at(-1)!.data.variant).toBe('claude');
    expect(c[0].prompt).toContain(`Your current workspace: ${session.workspacePath}--claude`);
    expect(c[0].prompt).toContain('Recent conversation and team handoffs');
    expect(c[0].prompt).toContain('[codex · candidate codex]');
    expect(c[0].prompt).toContain('check that path read-only');
  });

  it('a message before choosing asks both candidates for changes', async () => {
    const { session } = await competed();
    const before = callsFor(session.workspacePath).length;
    await api.send(session.id, 'Also add a NOTES.md entry');
    await ws.waitFor(() => callsFor(session.workspacePath).length > before, 5000, 'revision');
    await ws.waitStatus(session.id, 'awaiting_approval');
    const c = callsFor(session.workspacePath).slice(before);
    const impl = c.filter((x) => x.step === 'compete');
    expect(impl.map((x) => x.agent).sort()).toEqual(['claude', 'codex']);
    expect(impl.every((x) => x.prompt.includes('requests changes:\nAlso add a NOTES.md entry'))).toBe(true);
    expect(c.some((x) => x.step === 'cross_review')).toBe(true);
    for (const a of ['codex', 'claude'] as const) expect((await api.diff(session.id, { variant: a })).files.map((f) => f.path)).toContain('NOTES.md');
    const approvals = ofType(ws.persisted(session.id), 'approval').filter((a) => a.data.state === 'requested');
    expect(approvals).toHaveLength(2);
    expect(approvals[1].data.candidates).toHaveLength(2);
  });
});

describe('concurrent turns', () => {
  it('cancel during concurrent turns stops both', async () => {
    const { session } = await newSession({ mode: 'compete' }, () => ({ delayMs: 0, holdMs: { compete: 30_000 } }));
    await api.send(session.id, 'Hold both');
    await ws.waitFor(() => callsFor(session.workspacePath).filter((c) => c.step === 'compete').length === 2, 10_000, 'both turns');
    const evsNow = ws.persisted(session.id);
    // both agents work; neither is shown as waiting while its own turn runs
    const st = ofType(evsNow, 'agent.status');
    expect(st.filter((e) => e.data.status === 'waiting')).toHaveLength(0);
    const t0 = Date.now();
    const s = await api.control(session.id, 'cancel');
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(s.status).toBe('cancelled');
    const ends = ofType(ws.persisted(session.id), 'turn').filter((t) => t.data.state === 'end');
    expect(ends.map((e) => [e.data.agent, e.data.ok, e.data.variant]).sort()).toEqual([['claude', false, 'claude'], ['codex', false, 'codex']]);
  });

  it('retry after one agent failed re-runs only that agent', async () => {
    let claudeFails = true;
    const { session } = await newSession({ mode: 'compete' }, (agent) => ({ delayMs: 0, scenario: agent === 'claude' && claudeFails ? 'fail' : 'default' }));
    await api.send(session.id, 'One fails');
    await ws.waitStatus(session.id, 'failed');
    expect(ofType(ws.persisted(session.id), 'error').at(-1)!.data).toMatchObject({ agent: 'claude', code: 'auth' });
    expect(state(session.id).done).toEqual(['implement:codex']);
    // codex finished its turn and checkpoint although claude failed
    expect(ofType(ws.persisted(session.id), 'checkpoint').map((c) => c.data.variant)).toEqual(['codex']);
    claudeFails = false;
    await api.control(session.id, 'retry');
    await ws.waitStatus(session.id, 'awaiting_approval');
    const impl = callsFor(session.workspacePath).filter((c) => c.step === 'compete');
    expect(impl.filter((c) => c.agent === 'codex')).toHaveLength(1);
    expect(impl.filter((c) => c.agent === 'claude')).toHaveLength(2);
  });
});

describe('delete', () => {
  it('removes the worktrees and broadcasts session.deleted to subscribers and global watchers', async () => {
    const { session } = await newSession({ mode: 'compete' });
    await api.send(session.id, 'Then delete');
    await ws.waitStatus(session.id, 'awaiting_approval');
    const wts = ['codex', 'claude'].map((a) => `${session.workspacePath}--${a}`);
    expect(wts.every((p) => existsSync(p))).toBe(true);
    const watcher = new WsClient(srv.port, srv.token);
    await watcher.open();
    watcher.send({ op: 'watchAll' });
    await watcher.waitFor(() => watcher.msgs.some((m) => m.kind === 'projects'), 2000, 'projects');
    await api.deleteSession(session.id);
    expect(existsSync(session.workspacePath)).toBe(false);
    expect(wts.some((p) => existsSync(p))).toBe(false);
    const isDeleted = (c: WsClient) => c.events(session.id).some((e) => e.type === 'session.deleted' && e.data.sessionId === session.id && e.seq === 0);
    await ws.waitFor(() => isDeleted(ws), 2000, 'subscriber session.deleted');
    await watcher.waitFor(() => isDeleted(watcher), 2000, 'watcher session.deleted');
    watcher.close();
    await expect(api.diff(session.id, { variant: 'codex' })).rejects.toMatchObject({ status: 404 });
  });

  it('?variant= on a session without worktrees is a 404', async () => {
    const { session } = await newSession();
    await expect(api.tree(session.id, 'claude')).rejects.toMatchObject({ status: 404 });
    await expect(api.file(session.id, 'README.md', 'codex')).rejects.toMatchObject({ status: 404 });
    expect((await api.file(session.id, 'README.md')).content).toContain('demo');
  });
});
