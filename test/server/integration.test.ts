import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeRepo, setupEnv, sh, WsClient } from './helpers.js';
import type { AnyLinaEvent, LinaEvent, Session } from '../../src/shared/types.js';

setupEnv();
const { startServer } = await import('../../src/server/daemon.js');
const { LinaClient, LinaApiError } = await import('../../src/shared/client.js');
const { mockCalls, MockAdapter } = await import('../../src/server/agents/mock.js');
const { setAdapterOverride } = await import('../../src/server/agents/index.js');
type MockOptions = ConstructorParameters<typeof MockAdapter>[1];
const perSession = new Map<string, MockOptions>();
setAdapterOverride((agent, ctx) => {
  const o = ctx.sessionId ? perSession.get(ctx.sessionId) : undefined;
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

async function newSession(config: Record<string, unknown> = {}, files?: Record<string, string>) {
  const repo = makeRepo(files);
  const project = await api.addProject({ path: repo });
  const session = await api.createSession({ projectId: project.id, config: { workspaceMode: 'isolated', mock: true, ...config } });
  ws.send({ op: 'subscribe', sessionId: session.id, since: 0 });
  await ws.waitFor(() => ws.msgs.some((m) => m.kind === 'snapshot' && m.sessionId === session.id), 5000, 'snapshot');
  return { repo, project, session };
}

describe('pair flow (mock agents)', () => {
  it('runs plan → implement → test → review → revise → review → verify → approval, then squash-applies', async () => {
    const { repo, project, session } = await newSession();
    expect(session.mock).toBe(true);
    expect(session.status).toBe('idle');
    const res = await api.send(session.id, 'Add a hello(name) function with tests');
    expect(res.queued).toBe(false);
    await ws.waitStatus(session.id, 'awaiting_approval');

    const evs = ws.persisted(session.id);
    const idx = (pred: (e: AnyLinaEvent) => boolean, from = 0) => { const i = evs.findIndex((e, k) => k >= from && pred(e)); expect(i, 'event missing').toBeGreaterThanOrEqual(0); return i; };
    const phase = (p: string) => (e: AnyLinaEvent) => e.type === 'phase' && e.data.phase === p;
    let i = idx(phase('planning'));
    i = idx((e) => e.type === 'message' && e.data.kind === 'plan', i);
    i = idx(phase('implementing'), i);
    i = idx((e) => e.type === 'checkpoint', i);
    i = idx((e) => e.type === 'tests', i);
    i = idx(phase('reviewing'), i);
    i = idx((e) => e.type === 'review' && e.data.verdict === 'request_changes' && e.data.findings.length === 2, i);
    i = idx(phase('revising'), i);
    i = idx((e) => e.type === 'response' && e.data.items.some((x) => x.action === 'disputed'), i);
    i = idx((e) => e.type === 'checkpoint', i);
    i = idx((e) => e.type === 'tests', i);
    i = idx((e) => e.type === 'review' && e.data.verdict === 'approve' && e.data.round === 2, i);
    i = idx(phase('verifying'), i);
    i = idx((e) => e.type === 'message' && e.data.kind === 'summary' && e.actor === 'lina', i);
    i = idx((e) => e.type === 'approval' && e.data.state === 'requested', i);
    idx(phase('awaiting_approval'), i);

    // seqs are contiguous and monotonic
    expect(evs.map((e) => e.seq)).toEqual(evs.map((_, k) => k + 1));
    // tests really ran in the workspace and passed
    const tests = ofType(evs, 'tests');
    expect(tests.at(-1)!.data).toMatchObject({ command: 'npm test --silent', ok: true, passed: 2, failed: 0 });
    // observed + narrated activity, statuses, turns
    const acts = ofType(evs, 'activity');
    expect(acts.some((a) => a.data.source === 'narrated' && a.data.kind === 'note')).toBe(true);
    expect(acts.some((a) => a.data.source === 'observed' && a.data.kind === 'edit' && a.data.state === 'ok')).toBe(true);
    const statuses = ofType(evs, 'agent.status').map((e) => `${e.data.agent}:${e.data.status}`);
    expect(statuses).toEqual(expect.arrayContaining(['codex:thinking', 'codex:writing', 'codex:testing', 'claude:waiting', 'claude:reviewing', 'codex:done']));
    const turnEnds = ofType(evs, 'turn').filter((t) => t.data.state === 'end');
    expect(turnEnds.every((t) => t.data.ok)).toBe(true);
    // stream deltas were broadcast (ephemeral)
    expect(ws.events(session.id).some((e) => e.type === 'stream' && e.seq === 0)).toBe(true);
    // the reviewer message is the prose without the JSON block
    const reviewMsg = ofType(evs, 'message').find((m) => m.data.kind === 'review')!;
    expect(reviewMsg.data.text).not.toContain('lina-review');
    expect(reviewMsg.actor).toBe('claude');

    const snap = await api.session(session.id);
    expect(snap.findings.map((f) => [f.id, f.severity, f.status])).toEqual([['F1', 'major', 'resolved'], ['F2', 'minor', 'withdrawn']]);
    expect(snap.session.phase).toBe('awaiting_approval');
    expect(snap.session.round).toBe(2);
    expect(snap.session.usage.codex.turns).toBe(3);
    expect(snap.session.usage.claude.turns).toBe(2);
    expect(snap.session.usage.codex.inputTokens).toBeGreaterThan(0);
    expect(snap.session.usage.claude.costUsd).toBeGreaterThan(0);
    expect(snap.live.rateLimits.claude?.windows.five_hour.utilization).toBe(0.12);
    expect(snap.session.title).toBe('Add a hello(name) function with tests');
    const summary = ofType(evs, 'message').find((m) => m.data.kind === 'summary')!.data.text;
    expect(summary).toContain('hello.js');
    expect(summary).toMatch(/Resolved: F1/);
    expect(summary).toMatch(/Withdrawn: F2/);

    // provider sessions are resumed across turns (same mock session id)
    const codexCalls = mockCalls.filter((c) => c.agent === 'codex');
    expect(codexCalls[0].opts.resumeId).toBeUndefined();
    expect(codexCalls[1].opts.resumeId).toMatch(/^mock-codex-/);
    expect(codexCalls[1].prompt).not.toContain('Request from the project owner'); // primed: request not resent
    expect(codexCalls[1].opts.access).toBe('write');
    expect(mockCalls.filter((c) => c.agent === 'claude').every((c) => c.opts.access === 'read')).toBe(true);

    // diff / tree / file / search
    const diff = await api.diff(session.id);
    expect(diff.files.map((f) => f.path).sort()).toEqual(['hello.js', 'hello.test.js']);
    const tree = await api.tree(session.id);
    expect(tree.find((t) => t.path === 'hello.js')?.changed).toBe(true);
    expect((await api.file(session.id, 'hello.js')).content).toContain('TypeError');
    await expect(api.file(session.id, '../../etc/passwd')).rejects.toMatchObject({ status: 403 });
    const hits = await api.search('validation');
    expect(hits.some((h) => h.sessionId === session.id)).toBe(true);
    expect((await api.sessions({ projectId: project.id })).map((s) => s.id)).toContain(session.id);

    // project untouched until approval
    expect(existsSync(join(repo, 'hello.js'))).toBe(false);
    const approved = await api.approval(session.id, { decision: 'approve', strategy: 'squash' });
    expect(approved.status).toBe('approved');
    expect(readFileSync(join(repo, 'hello.js'), 'utf8')).toContain('TypeError');
    expect(sh(repo, 'git', ['log', '--format=%s']).trim().split('\n')).toEqual(['Add a hello(name) function with tests', 'init']);
    expect(sh(repo, 'git', ['status', '--porcelain']).trim()).toBe('');
  });
});

const callsFor = (sessionPath: string) => mockCalls.filter((c) => c.opts.cwd === sessionPath);

describe('escalation', () => {
  it("'stubborn' reviewer is bounded by maxRounds and unresolved findings go to the human", async () => {
    const { session } = await newSession({ maxRounds: 2 });
    perSession.set(session.id, { delayMs: 0, scenario: 'stubborn' });
    await api.send(session.id, 'Do the thing');
    await ws.waitStatus(session.id, 'awaiting_approval');
    const evs = ws.persisted(session.id);
    const reviews = ofType(evs, 'review');
    expect(reviews.map((r) => r.data.verdict)).toEqual(['request_changes', 'request_changes']);
    const approval = ofType(evs, 'approval').at(-1)!;
    expect(approval.data.state).toBe('requested');
    expect(approval.data.unresolved?.map((f) => f.id)).toEqual(['F2']);
    expect(approval.data.note).toMatch(/max|Stopped/i);
    const snap = await api.session(session.id);
    expect(snap.findings.map((f) => [f.id, f.status])).toEqual([['F1', 'resolved'], ['F2', 'open']]);
    expect(ofType(evs, 'message').some((m) => m.data.kind === 'notice' && /maximum of 2/.test(m.data.text))).toBe(true);
  });

  it("'insist' reviewer: identical open set two rounds in a row escalates; human can waive", async () => {
    const { session } = await newSession({ maxRounds: 5 });
    perSession.set(session.id, { delayMs: 0, scenario: 'insist' });
    await api.send(session.id, 'Do the thing');
    await ws.waitStatus(session.id, 'awaiting_approval');
    const evs = ws.persisted(session.id);
    expect(ofType(evs, 'review')).toHaveLength(2);
    let snap = await api.session(session.id);
    expect(snap.findings.find((f) => f.id === 'F1')?.status).toBe('escalated');
    expect(snap.findings.find((f) => f.id === 'F2')?.status).toBe('withdrawn');
    expect(ofType(evs, 'approval').at(-1)!.data.unresolved?.map((f) => f.status)).toEqual(['escalated']);
    const after = await api.approval(session.id, { decision: 'waive', findingId: 'F1', note: 'Acceptable for now' });
    expect(after.status).toBe('awaiting_approval');
    snap = await api.session(session.id);
    expect(snap.findings.find((f) => f.id === 'F1')?.status).toBe('waived');
    await expect(api.approval(session.id, { decision: 'waive', findingId: 'F9' })).rejects.toMatchObject({ status: 404 });
    const rej = await api.approval(session.id, { decision: 'reject', note: 'nah' });
    expect(rej.status).toBe('rejected');
  });

  it("'garbage' reviewer output: one repair turn, then verdict 'unparsed' escalates to the human", async () => {
    const { session } = await newSession();
    perSession.set(session.id, { delayMs: 0, scenario: 'garbage' });
    await api.send(session.id, 'Do the thing');
    await ws.waitStatus(session.id, 'awaiting_approval');
    const evs = ws.persisted(session.id);
    expect(ofType(evs, 'review').map((r) => r.data.verdict)).toEqual(['unparsed']);
    expect(callsFor(session.workspacePath).filter((c) => c.step === 'repair')).toHaveLength(1);
    expect(ofType(evs, 'approval').at(-1)!.data.note).toMatch(/could not be parsed/);
  });
});

describe('modes', () => {
  it('solo: implement → test → verify → approval with no reviewer', async () => {
    const { session } = await newSession({ mode: 'solo', developer: 'claude' });
    expect(session.config.reviewer).toBe('codex');
    await api.send(session.id, 'Solo task');
    await ws.waitStatus(session.id, 'awaiting_approval');
    const steps = callsFor(session.workspacePath).map((c) => `${c.agent}:${c.step}`);
    expect(steps).toEqual(['claude:implement']);
    const phases = ofType(ws.persisted(session.id), 'phase').map((p) => p.data.phase);
    expect(phases).toEqual(['implementing', 'testing', 'verifying', 'awaiting_approval']);
  });

  it('architect: the reviewer critiques the plan and the developer receives the critique', async () => {
    const { session } = await newSession({ mode: 'architect' });
    await api.send(session.id, 'Architect task');
    await ws.waitStatus(session.id, 'awaiting_approval');
    const calls = callsFor(session.workspacePath);
    expect(calls.slice(0, 3).map((c) => `${c.agent}:${c.step}`)).toEqual(['codex:plan', 'claude:plan_review', 'codex:implement']);
    expect(calls[2].prompt).toContain("Architect's critique");
    expect(ofType(ws.persisted(session.id), 'phase').map((p) => p.data.phase)).toContain('plan_review');
  });
});

describe('control', () => {
  it('pause stops at the next step boundary; resume completes', async () => {
    const { session } = await newSession();
    perSession.set(session.id, { delayMs: 0, holdMs: { plan: 400 } });
    await api.send(session.id, 'Pausable task');
    await ws.waitFor(() => ofType(ws.persisted(session.id), 'turn').length > 0, 5000, 'turn start');
    const s = await api.control(session.id, 'pause');
    expect(s.status).toBe('running');
    await ws.waitStatus(session.id, 'paused');
    const snap = await api.session(session.id);
    expect(snap.session.phase).toBe('planning'); // plan finished, implement not started
    expect(callsFor(session.workspacePath).map((c) => c.step)).toEqual(['plan']);
    await api.control(session.id, 'resume');
    await ws.waitStatus(session.id, 'awaiting_approval');
  });

  it('cancel kills the running turn and marks cancelled; resume re-runs the step and completes', async () => {
    const { session } = await newSession();
    perSession.set(session.id, { delayMs: 0, holdMs: { implement: 30_000 } });
    await api.send(session.id, 'Cancellable task');
    await ws.waitFor(() => ofType(ws.persisted(session.id), 'activity').some((a) => a.data.title === 'Write hello.test.js' && a.data.state === 'ok'), 10_000, 'implement edits');
    const t0 = Date.now();
    const s = await api.control(session.id, 'cancel');
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(s.status).toBe('cancelled');
    expect(s.phase).toBe('cancelled');
    const ends = ofType(ws.persisted(session.id), 'turn').filter((t) => t.data.state === 'end');
    expect(ends.at(-1)!.data.ok).toBe(false);
    perSession.set(session.id, { delayMs: 0 });
    await api.control(session.id, 'resume');
    await ws.waitStatus(session.id, 'awaiting_approval');
    expect(callsFor(session.workspacePath).filter((c) => c.step === 'implement')).toHaveLength(2);
  });

  it('a failed turn marks the session failed with a classified error; retry resumes', async () => {
    const { session } = await newSession();
    perSession.set(session.id, { delayMs: 0, scenario: 'fail' });
    await api.send(session.id, 'Will fail');
    await ws.waitStatus(session.id, 'failed');
    const err = ofType(ws.persisted(session.id), 'error').at(-1)!;
    expect(err.data).toMatchObject({ agent: 'codex', code: 'auth' });
    expect(err.data.hint).toMatch(/login/);
    perSession.set(session.id, { delayMs: 0 });
    await api.control(session.id, 'retry');
    await ws.waitStatus(session.id, 'awaiting_approval');
  });

  it('extra review round on request', async () => {
    const { session } = await newSession({ mode: 'solo' });
    await api.send(session.id, 'Solo then review');
    await ws.waitStatus(session.id, 'awaiting_approval');
    await api.control(session.id, 'review');
    await ws.waitFor(() => ofType(ws.persisted(session.id), 'review').length === 1, 10_000, 'extra review');
    await ws.waitStatus(session.id, 'awaiting_approval');
  });
});

describe('messages', () => {
  it('queues interjections while running and injects them into the next prompt', async () => {
    const { session } = await newSession();
    perSession.set(session.id, { delayMs: 0, holdMs: { plan: 500 } });
    await api.send(session.id, 'Original task');
    await ws.waitFor(() => ofType(ws.persisted(session.id), 'turn').length > 0, 5000, 'turn start');
    const r = await api.send(session.id, 'Please also add a README note');
    expect(r.queued).toBe(true);
    const queuedMsg = ofType(ws.persisted(session.id), 'message').find((m) => m.data.text === 'Please also add a README note')!;
    expect(queuedMsg.data.queued).toBe(true);
    expect((await api.session(session.id)).session.pendingMessages).toBe(1);
    await ws.waitStatus(session.id, 'awaiting_approval');
    const calls = callsFor(session.workspacePath);
    expect(calls[0].prompt).not.toContain('README note');
    const impl = calls.find((c) => c.step === 'implement')!;
    expect(impl.prompt).toContain('Message from the project owner:\nPlease also add a README note');
    const rev = calls.find((c) => c.step === 'review')!;
    expect(rev.prompt).toContain('README note'); // delivered to the reviewer too
    expect(calls.filter((c) => c.prompt.split('Your current workspace:')[0].includes('README note'))).toHaveLength(2);
    expect((await api.session(session.id)).session.pendingMessages).toBe(0);
  });

  it('interrupt cancels the current turn and re-runs it with the message', async () => {
    const { session } = await newSession({ mode: 'solo' });
    perSession.set(session.id, { delayMs: 0, holdMs: { implement: 30_000 } });
    await api.send(session.id, 'Task to interrupt');
    await ws.waitFor(() => callsFor(session.workspacePath).length === 1, 5000, 'first turn');
    perSession.set(session.id, { delayMs: 0 });
    const r = await api.send(session.id, 'Use tabs instead', { interrupt: true });
    expect(r.queued).toBe(true);
    await ws.waitStatus(session.id, 'awaiting_approval');
    const impl = callsFor(session.workspacePath).filter((c) => c.step === 'implement');
    expect(impl).toHaveLength(2);
    expect(impl[1].prompt).toContain('Use tabs instead');
    expect(ofType(ws.persisted(session.id), 'message').some((m) => m.data.kind === 'notice' && /Interrupted/.test(m.data.text))).toBe(true);
  });

  it('@mention when idle runs a consult turn with that agent and returns to the previous state', async () => {
    const { session } = await newSession();
    await api.send(session.id, 'Task for consult');
    await ws.waitStatus(session.id, 'awaiting_approval');
    const before = callsFor(session.workspacePath).length;
    const r = await api.send(session.id, '@claude what do you think of the error handling?');
    expect(r.queued).toBe(false);
    await ws.waitFor(() => ofType(ws.persisted(session.id), 'message').some((m) => m.actor === 'claude' && m.data.kind === 'chat'), 10_000, 'consult reply');
    await ws.waitStatus(session.id, 'awaiting_approval');
    const c = callsFor(session.workspacePath).slice(before);
    expect(c.map((x) => `${x.agent}:${x.step}:${x.opts.access}`)).toEqual(['claude:consult:read']);
    expect(c[0].prompt).toContain('what do you think of the error handling?');
    const userMsg = ofType(ws.persisted(session.id), 'message').find((m) => m.actor === 'user' && m.data.mention === 'claude');
    expect(userMsg).toBeTruthy();
    expect(ofType(ws.persisted(session.id), 'phase').map((p) => p.data.phase)).toContain('consulting');
    // developer consult with a write request → checkpoint
    const cps = ofType(ws.persisted(session.id), 'checkpoint').length;
    await api.send(session.id, '@codex please add a line to the notes');
    await ws.waitFor(() => ofType(ws.persisted(session.id), 'checkpoint').length === cps + 1, 10_000, 'consult checkpoint');
    await ws.waitStatus(session.id, 'awaiting_approval');
  });

  it('@mention while running is queued for that agent only', async () => {
    const { session } = await newSession();
    perSession.set(session.id, { delayMs: 0, holdMs: { plan: 400 } });
    await api.send(session.id, 'Task with mention');
    await ws.waitFor(() => callsFor(session.workspacePath).length === 1, 5000, 'first turn');
    const r = await api.send(session.id, '@claude check the edge cases carefully');
    expect(r.queued).toBe(true);
    await ws.waitStatus(session.id, 'awaiting_approval');
    // Shared history may retain a delivered question; only the active request delivers it.
    const with_ = callsFor(session.workspacePath).filter((c) => c.prompt.split('Your current workspace:')[0].includes('check the edge cases carefully'));
    expect(callsFor(session.workspacePath).filter((c) => c.agent === 'codex').every((c) => !c.prompt.includes('check the edge cases carefully'))).toBe(true);
    expect(with_.map((c) => `${c.agent}:${c.step}`)).toEqual(['claude:review']);
  });

  it('a message while awaiting approval starts a revision cycle', async () => {
    const { session } = await newSession();
    await api.send(session.id, 'Initial');
    await ws.waitStatus(session.id, 'awaiting_approval');
    const before = callsFor(session.workspacePath).length;
    await api.send(session.id, 'Also document it in NOTES.md');
    await ws.waitFor(() => callsFor(session.workspacePath).length > before, 5000, 'revision start');
    await ws.waitStatus(session.id, 'awaiting_approval');
    const c = callsFor(session.workspacePath).slice(before);
    expect(c[0].step).toBe('implement');
    expect(c[0].prompt).toContain('requests changes:\nAlso document it in NOTES.md');
    expect(c.some((x) => x.step === 'review')).toBe(true);
    const files = (await api.diff(session.id)).files.map((f) => f.path);
    expect(files).toContain('NOTES.md');
    expect(ofType(ws.persisted(session.id), 'approval').filter((a) => a.data.state === 'requested')).toHaveLength(2);
  });

  it('approval refuses a dirty project (dirty_worktree) and branch strategy still works', async () => {
    const { repo, session } = await newSession();
    await api.send(session.id, 'Dirty test');
    await ws.waitStatus(session.id, 'awaiting_approval');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(repo, 'README.md'), 'local edits\n');
    await expect(api.approval(session.id, { decision: 'approve', strategy: 'squash' })).rejects.toMatchObject({ status: 409, code: 'dirty_worktree' });
    const failed = ofType(ws.persisted(session.id), 'approval').at(-1)!;
    expect(failed.data.state).toBe('failed');
    expect((await api.session(session.id)).session.status).toBe('awaiting_approval');
    const s = await api.approval(session.id, { decision: 'approve', strategy: 'branch' });
    expect(s.status).toBe('approved');
    expect(sh(repo, 'git', ['branch', '--list', s.branch]).trim()).toContain(s.branch);
    expect(readFileSync(join(repo, 'README.md'), 'utf8')).toBe('local edits\n');
  });
});

describe('api surface', () => {
  it('validates input and returns ApiError codes', async () => {
    const repo = makeRepo();
    const project = await api.addProject({ path: repo });
    expect((await api.addProject({ path: repo })).id).toBe(project.id); // idempotent
    await expect(api.createSession({ projectId: project.id, config: { developer: 'gpt' as never } })).rejects.toMatchObject({ status: 400 });
    await expect(api.createSession({ projectId: project.id, config: { models: { codex: { model: '' } } as never } })).rejects.toMatchObject({ status: 400 });
    await expect(api.createSession({ projectId: project.id, config: { developer: 'codex', reviewer: 'codex' } })).rejects.toMatchObject({ status: 400 });
    await expect(api.createSession({ projectId: 'nope' })).rejects.toMatchObject({ status: 404, code: 'not_found' });
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const plain = mkdtempSync(join(tmpdir(), 'lina-plain-'));
    await expect(api.addProject({ path: plain })).rejects.toMatchObject({ code: 'not_git' });
    expect((await api.addProject({ path: plain, initGit: true })).path).toBe(plain);
    await expect(api.putSettings({ maxRounds: 0 })).rejects.toMatchObject({ status: 400 });
    const st = await api.putSettings({ maxRounds: 4, models: { claude: { model: 'sonnet' } } as never });
    expect(st.maxRounds).toBe(4);
    expect(st.models.claude.model).toBe('sonnet');
    expect(st.models.codex.model).toBeTruthy();
    const s = await api.createSession({ projectId: project.id, config: { workspaceMode: 'isolated', mock: true } });
    expect(s.config.maxRounds).toBe(3); // project settings captured at project creation
    const patched = await api.updateSession(s.id, { title: 'Renamed', config: { developer: 'claude', models: { codex: { model: 'gpt-x', effort: 'high' } } as never } });
    expect(patched.title).toBe('Renamed');
    expect(patched.config.reviewer).toBe('codex');
    expect(patched.config.models.codex).toEqual({ model: 'gpt-x', effort: 'high' });
    expect(patched.config.models.claude.model).toBeTruthy();
    await expect(api.removeProject(project.id)).rejects.toMatchObject({ code: 'has_sessions' });
    // attachments
    const att = await api.upload(s.id, '../../evil name?.txt', 'text/plain', new TextEncoder().encode('hello'));
    expect(att.name).toBe('evil name_.txt');
    expect(att.size).toBe(5);
    expect(att.path.startsWith(join(process.env.LINA_HOME!, 'attachments', s.id))).toBe(true);
    await api.send(s.id, 'Use the attachment', { attachments: [att.id] });
    await ws.waitFor(() => mockCalls.some((c) => c.opts.cwd === s.workspacePath), 5000, 'turn');
    expect(mockCalls.find((c) => c.opts.cwd === s.workspacePath)!.prompt).toContain(att.path);
    // delete requires confirm and removes the workspace
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/sessions/${s.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${srv.token}` } });
    expect(res.status).toBe(400);
    await api.deleteSession(s.id);
    expect(existsSync(s.workspacePath)).toBe(false);
    await expect(api.session(s.id)).rejects.toMatchObject({ status: 404 });
    await api.removeProject(project.id);
    expect((await api.projects()).some((p) => p.id === project.id)).toBe(false);
    expect((await api.events('nope').catch((e) => e)).status).toBe(404);
  });

  it('enforces auth, Host and Origin checks; serves / without a token', async () => {
    const base = `http://127.0.0.1:${srv.port}`;
    expect((await fetch(`${base}/api/health`)).status).toBe(401);
    expect((await fetch(`${base}/api/health`, { headers: { authorization: 'Bearer wrong' } })).status).toBe(401);
    expect((await fetch(`${base}/api/health`, { headers: { authorization: `Bearer ${srv.token}` } })).status).toBe(200);
    const { request } = await import('node:http');
    const status = (path: string, headers: Record<string, string>) => new Promise<number>((resolve, reject) => {
      const r = request({ host: '127.0.0.1', port: srv.port, path, headers }, (res) => { res.resume(); resolve(res.statusCode!); });
      r.on('error', reject);
      r.end();
    });
    expect(await status('/api/health', { host: 'evil.com', authorization: `Bearer ${srv.token}` })).toBe(403);
    expect(await status('/', { host: 'evil.com' })).toBe(403);
    expect(await status('/', { host: `localhost:${srv.port}` })).toBe(200);
    expect(await status('/some/spa/route', { host: `127.0.0.1:${srv.port}` })).toBe(200);
    expect(await status('/api/health', { host: `127.0.0.1:${srv.port}`, authorization: `Bearer ${srv.token}`, origin: 'http://evil.com' })).toBe(403);
    const { default: WebSocket } = await import('ws');
    const wsStatus = (url: string, headers: Record<string, string> = {}) => new Promise<number>((resolve) => {
      const w = new WebSocket(url, { headers });
      w.on('unexpected-response', (_req, res) => resolve(res.statusCode!));
      w.on('open', () => { w.close(); resolve(101); });
      w.on('error', () => {});
    });
    const wsUrl = `ws://127.0.0.1:${srv.port}/ws`;
    expect(await wsStatus(wsUrl)).toBe(401);
    expect(await wsStatus(`${wsUrl}?token=bad`)).toBe(401);
    expect(await wsStatus(`${wsUrl}?token=${srv.token}`, { origin: 'http://evil.com' })).toBe(403);
    expect(await wsStatus(`${wsUrl}?token=${srv.token}`, { origin: `http://localhost:${srv.port}` })).toBe(101);
    expect(await wsStatus(`${wsUrl}?token=${srv.token}`, { origin: 'http://localhost:5173' })).toBe(403);
    expect(await wsStatus(`${wsUrl}?token=${srv.token}`)).toBe(101);
  });

  it('WS: hello, ping/pong, watchAll gets session.updated + projects, resubscribe with since', async () => {
    const c = new WsClient(srv.port, srv.token);
    await c.open();
    await c.waitFor(() => c.msgs.some((m) => m.kind === 'hello'), 2000, 'hello');
    c.send({ op: 'ping' });
    await c.waitFor(() => c.msgs.some((m) => m.kind === 'pong'), 2000, 'pong');
    c.send({ op: 'watchAll' });
    await c.waitFor(() => c.msgs.some((m) => m.kind === 'projects'), 2000, 'projects');
    const { session } = await newSession();
    await api.send(session.id, 'Watched');
    await ws.waitStatus(session.id, 'awaiting_approval');
    await c.waitFor(() => c.msgs.some((m) => m.kind === 'event' && m.event.type === 'session.updated' && m.event.sessionId === session.id && m.event.data.session.status === 'awaiting_approval'), 5000, 'watchAll update');
    expect(c.msgs.filter((m) => m.kind === 'event').every((m) => m.kind === 'event' && m.event.type === 'session.updated')).toBe(true);
    const total = ws.persisted(session.id).length;
    c.send({ op: 'subscribe', sessionId: session.id, since: total - 3 });
    await c.waitFor(() => c.msgs.some((m) => m.kind === 'snapshot'), 2000, 'snapshot');
    const snap = c.msgs.find((m) => m.kind === 'snapshot')!;
    if (snap.kind !== 'snapshot') throw new Error();
    expect(snap.snapshot.events.map((e) => e.seq)).toEqual([total - 2, total - 1, total]);
    expect(snap.snapshot.findings.length).toBe(2);
    expect(snap.snapshot.live.agents.codex.status).toBeTruthy();
    c.send({ op: 'subscribe', sessionId: 'missing' });
    await c.waitFor(() => c.msgs.some((m) => m.kind === 'error'), 2000, 'error');
    c.close();
  });
});
