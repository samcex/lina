import React from 'react';
import { describe, expect, it } from 'vitest';
import { render, renderToString } from 'ink';
import { PassThrough, Writable } from 'node:stream';
import { LinaApiError } from '../../src/shared/client.js';
import { viewFromSnapshot } from '../../src/shared/reducer.js';
import { AGENT_IDS, type AnyLinaEvent, type Candidate, type Finding, type Session, type SessionSnapshot, type TestRun, type TeamConfig } from '../../src/shared/types.js';
import { stripAnsi } from '../../src/cli/ansi.js';
import { buildTranscript, candidateComparison, renderEvent } from '../../src/cli/transcript.js';
import { agentScopes, headerLines, pipelineRail, railFor } from '../../src/cli/tui/chrome.js';
import { cycleTeam, diffTargets, modePickerLines, teamPickerLines } from '../../src/cli/tui/overlays.js';
import { App } from '../../src/cli/tui/App.js';
import { TuiStore, type ClientLike } from '../../src/cli/tui/store.js';
import { project, session as pairSession } from './fixture.js';

const T0 = Date.UTC(2026, 0, 2, 10, 0, 0);
const usage = (inputTokens: number, outputTokens: number, turns: number, costUsd = 0) => ({ inputTokens, outputTokens, cachedInputTokens: 0, costUsd, turns });
const variant = (agent: 'codex' | 'claude') => ({ agent, branch: `lina/sess_cmp-${agent}`, workspacePath: `/tmp/ws--${agent}`, baseCommit: 'aaaaaaa', headCommit: agent === 'codex' ? 'c0dec0de1' : 'c1aude001' });

const competeSession: Session = {
  ...pairSession, id: 'sess_compete01', title: 'Add rate limiting', status: 'awaiting_approval', phase: 'awaiting_approval', round: 1,
  config: { ...pairSession.config, mode: 'compete' }, variants: { codex: variant('codex'), claude: variant('claude') },
};

const run = (o: Partial<TestRun>): TestRun => ({ command: 'npm test', exitCode: 0, ok: true, durationMs: 3100, output: 'ok', sandboxed: true, ...o });
const candidates: Candidate[] = [
  { agent: 'codex', headCommit: 'c0dec0de1', files: 4, additions: 120, deletions: 8, tests: run({ passed: 14, failed: 0 }), openFindings: 1, blockingFindings: 0, verdict: 'approve', usage: usage(41_200, 6_100, 3, 0.42) },
  { agent: 'claude', headCommit: 'c1aude001', files: 6, additions: 210, deletions: 30, tests: run({ ok: false, exitCode: 1, passed: 12, failed: 2, sandboxed: false }), openFindings: 3, blockingFindings: 1, verdict: 'request_changes', usage: usage(52_000, 9_800, 4) },
];
const competeFindings: Finding[] = [
  { id: 'F1', severity: 'minor', title: 'Magic number for the window', detail: 'x', status: 'open', raisedBy: 'claude', round: 1, history: [], owner: 'codex', variant: 'codex' },
  { id: 'F2', severity: 'blocker', title: 'Limiter is not shared across workers', detail: 'y', file: 'src/limit.ts', line: 9, status: 'open', raisedBy: 'codex', round: 1, history: [], owner: 'claude', variant: 'claude' },
];

let seq = 0;
const ev = (type: AnyLinaEvent['type'], actor: AnyLinaEvent['actor'], data: unknown, sessionId = competeSession.id): AnyLinaEvent =>
  ({ sessionId, seq: ++seq, ts: T0 + seq * 1000, type, actor, data } as AnyLinaEvent);

function competeSnapshot(over: Partial<Session> = {}): SessionSnapshot {
  seq = 0;
  const s = { ...competeSession, ...over };
  const events = [
    ev('message', 'user', { id: 'm1', text: 'Add rate limiting', kind: 'chat' }),
    ev('turn', 'codex', { agent: 'codex', state: 'start', role: 'developer', phase: 'implementing', model: 'gpt-6.1-sol', variant: 'codex' }),
    ev('turn', 'claude', { agent: 'claude', state: 'start', role: 'developer', phase: 'implementing', model: 'opus', variant: 'claude' }),
    ev('checkpoint', 'lina', { commit: 'c0dec0de1', message: 'Codex: rate limiter', files: [{ path: 'src/limit.ts', additions: 80, deletions: 2, status: 'added' }], variant: 'codex' }),
    ev('tests', 'lina', run({ passed: 14, failed: 0, variant: 'codex' })),
    ev('tests', 'lina', run({ ok: false, exitCode: 1, passed: 12, failed: 2, sandboxed: false, output: 'FAIL limit.test.ts', variant: 'claude' })),
    ev('turn', 'codex', { agent: 'codex', state: 'start', role: 'reviewer', phase: 'reviewing', model: 'gpt-6.1-sol', variant: 'claude' }),
    ev('message', 'codex', { id: 'm2', text: 'The limiter state lives in memory.', kind: 'review', role: 'reviewer', variant: 'claude' }),
    ev('review', 'codex', { round: 1, reviewer: 'codex', verdict: 'request_changes', summary: 'Not shared across workers.', findings: competeFindings, variant: 'claude' }),
    ev('approval', 'lina', { state: 'requested', summary: 'Both candidates are ready. **Codex** passes all tests.', candidates }),
  ];
  return {
    session: s, project, events, findings: competeFindings,
    live: { agents: { codex: { status: 'idle', since: T0 }, claude: { status: 'idle', since: T0 }, freebuff: { status: 'idle', since: T0 } }, streams: {}, rateLimits: {} },
  };
}

const parallelSession: Session = { ...pairSession, id: 'sess_parallel1', config: { ...pairSession.config, mode: 'parallel' }, phase: 'integrating', status: 'running' };
function parallelEvents(): AnyLinaEvent[] {
  seq = 100;
  const sid = parallelSession.id;
  return [
    ev('split', 'codex', { lead: 'codex', parts: [
      { agent: 'codex', title: 'API endpoints', scope: 'Add /api/limits and the persistence layer.', files: ['src/api/limits.ts', 'src/db.ts'] },
      { agent: 'claude', title: 'Settings page', scope: 'Build the settings UI that calls the new endpoints.', files: ['web/Settings.tsx'] },
    ] }, sid),
    ev('integration', 'lina', { state: 'conflict', conflicts: ['src/types.ts', 'README.md'] }, sid),
    ev('integration', 'lina', { state: 'resolved', commit: 'feedbeef99', conflicts: ['src/types.ts', 'README.md'] }, sid),
    ev('integration', 'lina', { state: 'merged', commit: 'abc1234567' }, sid),
    ev('integration', 'lina', { state: 'failed', note: 'Conflict markers remain in src/types.ts' }, sid),
    ev('review', 'claude', { round: 1, reviewer: 'claude', verdict: 'request_changes', summary: 'One issue in the API part.', findings: [{ id: 'F1', severity: 'major', title: 'No input validation', detail: 'z', status: 'open', raisedBy: 'claude', round: 1, history: [], owner: 'codex' }] }, sid),
  ];
}

const text = (lines: string[]) => stripAnsi(lines.join('\n'));

function stubClient(calls: { name: string; args: unknown[] }[], over: Partial<Record<keyof ClientLike, (...a: unknown[]) => Promise<unknown>>> = {}): ClientLike {
  const rec = (name: string, value: unknown) => async (...args: unknown[]) => { calls.push({ name, args }); if (over[name as keyof ClientLike]) return over[name as keyof ClientLike]!(...args); return value as never; };
  const names = ['session', 'createSession', 'send', 'control', 'approval', 'updateSession', 'sessions', 'projects', 'addProject', 'models', 'validateModel', 'diff', 'doctor', 'getSettings', 'putSettings'];
  return Object.fromEntries(names.map((n) => [n, rec(n, n === 'approval' || n === 'updateSession' ? competeSession : undefined)])) as unknown as ClientLike;
}

describe('transcript: modes v2', () => {
  it('renders the parallel split with each part, scope and files', () => {
    const out = text(renderEvent(parallelEvents()[0], 100, { mode: 'parallel', lead: 'codex' }));
    for (const s of ['⑂ Task split by Codex (lead) · 2 parts', 'CODEX', 'API endpoints', 'Add /api/limits and the persistence layer.', 'files src/api/limits.ts, src/db.ts', 'CLAUDE', 'Settings page', 'web/Settings.tsx', 'cross-review by Claude', 'cross-review by Codex']) expect(out).toContain(s);
  });
  it('renders every integration state', () => {
    const [, conflict, resolved, merged, failed] = parallelEvents();
    const ctx = { mode: 'parallel' as const, lead: 'codex' as const };
    const c = text(renderEvent(conflict, 100, ctx));
    expect(c).toContain('⚠ Merge conflict · Codex is resolving 2 files');
    expect(c).toContain('U src/types.ts');
    expect(c).toContain('U README.md');
    expect(text(renderEvent(resolved, 100, ctx))).toContain('✔ Conflicts resolved feedbee');
    expect(text(renderEvent(merged, 100, ctx))).toContain('Parts merged abc1234');
    const f = text(renderEvent(failed, 100, ctx));
    expect(f).toContain('✖ Integration failed');
    expect(f).toContain('/retry');
    expect(f).toContain('Conflict markers remain in src/types.ts');
  });
  it('labels variant reviews, messages, tests and checkpoints', () => {
    const view = viewFromSnapshot(competeSnapshot());
    const out = text(buildTranscript(view, [], 110));
    expect(out).toContain('◇ Review by Codex · reviewing Claude\'s version · round 1 — changes requested');
    expect(out).toContain('review · reviewing Claude\'s version');
    expect(out).toContain('✔ Tests passed · Codex\'s worktree');
    expect(out).toContain('✖ Tests failed · Claude\'s worktree');
    expect(out).toContain('not sandboxed');
    expect(out).toContain('Checkpoint c0dec0d · Codex\'s worktree');
    // the review card shows only the reviewed candidate's findings, labelled with it
    const review = text(renderEvent(view.timeline.find((e) => e.type === 'review')!, 110, { mode: 'compete' }));
    expect(review).toContain('F2 Limiter is not shared across workers src/limit.ts:9 on Claude\'s version');
    expect(review).not.toContain('Magic number');
  });
  it('shows the finding owner in parallel mode', () => {
    const out = text(renderEvent(parallelEvents()[5], 100, { mode: 'parallel', lead: 'codex' }));
    expect(out).toContain('No input validation → Codex');
  });
  it('renders the compete candidate comparison side by side, and stacked when narrow', () => {
    const view = viewFromSnapshot(competeSnapshot());
    const wide = text(buildTranscript(view, [], 110));
    for (const s of ['◆ Pick the winner', 'CODEX  c0dec0d', 'CLAUDE  c1aude0', '✔ 14 passed · sandboxed', '✖ 2 failed · not sandboxed',
      '4 files +120 −8', '6 files +210 −30', '1 open · 0 blocking', '3 open · 1 blocking', 'approved (Claude)', 'changes requested (Codex)',
      '41k in · 6.1k out · 3 turns · $0.42', '/choose codex|claude', '/approve codex|claude [squash|merge|branch]', '/diff codex|claude']) expect(wide).toContain(s);
    // side by side: both heads on one row
    expect(wide.split('\n').some((l) => l.includes('CODEX  c0dec0d') && l.includes('CLAUDE  c1aude0'))).toBe(true);
    const narrow = text(candidateComparison(candidates, 50));
    expect(narrow.split('\n').some((l) => l.includes('CODEX') && l.includes('CLAUDE'))).toBe(false);
    expect(narrow).toContain('Tests     ✖ 2 failed · not sandboxed');
  });
  it('after choosing, the approval card shows the pick and plain approve actions', () => {
    const view = viewFromSnapshot(competeSnapshot({ chosenVariant: 'claude', config: { ...competeSession.config, mode: 'pair', developer: 'claude', reviewer: 'codex' } }));
    const out = text(buildTranscript(view, [], 110));
    expect(out).toContain('◆ Awaiting your approval');
    expect(out).toContain('★ chosen');
    expect(out).toContain('You picked Claude\'s version — it is now the session branch; Codex reviews');
    expect(out).not.toContain('Pick the winner');
  });
});

describe('chrome: modes v2', () => {
  it('the rail follows pipelineFor(config)', () => {
    expect(railFor({ mode: 'pair', workspaceMode: 'direct' })).not.toContain('awaiting_approval');
    expect(stripAnsi(pipelineRail('completed', true, railFor({ mode: 'solo', workspaceMode: 'direct' })))).toContain('✓ Chatting');
    expect(railFor({ mode: 'parallel', developer: 'codex' })).toContain('integrating');
    expect(railFor({ mode: 'compete' })[0]).toBe('implementing');
    const custom = railFor({ mode: 'custom', developer: 'claude', team: { planner: null, planCritic: null, developer: 'claude', reviewers: [] } });
    expect(custom).toEqual(['implementing', 'testing', 'verifying', 'awaiting_approval']);
    const rail = stripAnsi(pipelineRail('integrating', false, railFor({ mode: 'parallel', developer: 'codex' })));
    expect(rail).toContain('✓ Implementing');
    expect(rail).toContain(' Integrating ');
    expect(stripAnsi(pipelineRail('plan_review', true, railFor({ mode: 'architect', developer: 'codex' })))).toContain('✓ Plan ›  Critique ');
  });
  it('preserves the original model/role header and chosen version', () => {
    const view = viewFromSnapshot(competeSnapshot({ chosenVariant: 'claude' }));
    const h = text(headerLines({ width: 160, projectName: 'acme', view, models: {}, developer: 'codex', mode: 'compete', config: view.session.config, conn: 'open', everOpen: true }));
    expect(h).toContain('codex — rival');
    expect(h).toContain("compete · Claude's version");
    const team = { planner: 'claude', planCritic: 'codex', developer: 'claude', reviewers: ['codex', 'claude'] } as const;
    const hc = text(headerLines({ width: 160, models: {}, developer: 'codex', mode: 'custom', config: { mode: 'custom', team: { ...team, reviewers: [...team.reviewers] } }, conn: 'open', everOpen: true }));
    expect(hc).toContain('claude — plan+dev+rev  codex — crit+rev');
    expect(hc).toContain('Critique');
  });
  it('panels know which worktree each concurrent agent works in', () => {
    const view = viewFromSnapshot(competeSnapshot());
    expect(agentScopes(view)).toEqual({ codex: { variant: 'claude', label: "Claude's version" }, claude: { variant: 'claude', label: 'own version' } });
    expect(agentScopes(viewFromSnapshot({ ...competeSnapshot(), session: pairSession }))).toEqual({});
  });
  it('mode and team pickers', () => {
    const modes = text(modePickerLines('compete', 4, 100));
    for (const s of ['pair', 'Developer + Reviewer', 'parallel', 'The lead splits the task', '● compete', 'Competition', 'custom', 'Custom team']) expect(modes).toContain(s);
    const t0 = { planner: 'codex', planCritic: 'claude', developer: 'codex', reviewers: ['claude'] } as const;
    const t1 = cycleTeam(cycleTeam({ ...t0, reviewers: ['claude'] }, 3, 1), 3, 1);
    expect(t1.reviewers).toEqual(['codex', 'claude']);
    expect(cycleTeam(t1, 0, 1).planner).toBe('claude');
    expect(cycleTeam(cycleTeam(t1, 0, 1), 0, 1).planner).toBe('freebuff');
    expect(cycleTeam(cycleTeam(cycleTeam(t1, 0, 1), 0, 1), 0, 1).planner).toBeNull();
    const lines = text(teamPickerLines(t1, 0, 100));
    expect(lines).toContain('Review              ‹ Codex + Claude ›');
    expect(lines).toContain('Planning (Codex) › Plan review (Claude) › Implementing (Codex) › Testing › Reviewing (Codex, Claude)');
    expect(lines).toContain('/team plan=codex,critic=claude,dev=codex,review=codex+claude');
    expect(lines).toContain('Codex also reviews its own code');
    expect(diffTargets(competeSession)).toEqual([undefined, 'claude', 'codex']);
    expect(diffTargets(pairSession)).toEqual([undefined]);
  });
});

describe('store: session.deleted', () => {
  it('leaves the open session with a notice and drops it from lists', () => {
    const sub: string[] = [];
    const conn = { subscribe: (id: string) => sub.push(`sub ${id}`), unsubscribe: (id: string) => sub.push(`unsub ${id}`), watchAll: () => sub.push('watchAll'), close: () => {} };
    const client = { ...stubClient([]), connect: () => conn } as unknown as ClientLike;
    const view = viewFromSnapshot(competeSnapshot());
    const other = { ...pairSession, id: 'sess_other' };
    const store = new TuiStore(client, { view, project, recent: [competeSession, other] });
    expect(sub).toEqual(['watchAll']);
    const msg = (sessionId: string) => (store as unknown as { onServerMessage: (m: unknown) => void }).onServerMessage({ kind: 'event', event: { sessionId, seq: 0, ts: Date.now(), type: 'session.deleted', actor: 'lina', data: { sessionId } } });

    msg('sess_other');
    expect(store.getState().recent.map((s) => s.id)).toEqual([competeSession.id]);
    expect(store.getState().view?.session.id).toBe(competeSession.id);
    expect(store.getState().deletedIds).toEqual(['sess_other']);

    msg(competeSession.id);
    const st = store.getState();
    expect(st.view).toBeUndefined();
    expect(st.sessionId).toBeUndefined();
    expect(st.recent).toEqual([]);
    expect(sub).toContain(`unsub ${competeSession.id}`);
    expect(st.notices).toHaveLength(1);
    expect(st.notices[0]).toMatchObject({ level: 'warn', text: expect.stringContaining('“Add rate limiting”) was deleted') });
    // the App falls back to the welcome screen with the notice
    const out = stripAnsi(renderToString(<App store={store} cwd="/tmp" onQuit={() => {}} size={{ columns: 120, rows: 30 }} />, { columns: 120 }));
    expect(out).toContain('was deleted');
    expect(out).toContain('new session');
    store.dispose();
  });
});

describe('store: compete approval flow', () => {
  const setup = (over: Partial<Session> = {}, client: Partial<Record<keyof ClientLike, (...a: unknown[]) => Promise<unknown>>> = {}) => {
    const calls: { name: string; args: unknown[] }[] = [];
    const view = viewFromSnapshot(competeSnapshot(over));
    const store = new TuiStore(stubClient(calls, { approval: async () => view.session, ...client }), { view, live: false, project });
    return { calls, store, approvals: () => calls.filter((c) => c.name === 'approval').map((c) => c.args) };
  };

  it('/choose sends decision choose with the variant', async () => {
    const { store, approvals } = setup();
    await store.choose('claude');
    expect(approvals()).toEqual([[competeSession.id, { decision: 'choose', variant: 'claude' }]]);
    expect(store.getState().notices.at(-1)?.text).toContain("You picked Claude's version");
  });
  it('/approve <agent> [strategy] chooses and applies in one call', async () => {
    const { store, approvals } = setup();
    await store.approve('merge', 'codex');
    await store.approve(undefined, 'claude');
    expect(approvals()).toEqual([
      [competeSession.id, { decision: 'approve', strategy: 'merge', variant: 'codex' }],
      [competeSession.id, { decision: 'approve', variant: 'claude' }],
    ]);
  });
  it('after choosing, /approve needs no agent (and the same agent is dropped)', async () => {
    const { store, approvals } = setup({ chosenVariant: 'claude', config: { ...competeSession.config, mode: 'pair', developer: 'claude', reviewer: 'codex' } });
    await store.approve('squash', 'claude');
    await store.approve('branch', 'codex'); // conflicting pick: refused locally
    await store.choose('codex');
    expect(approvals()).toEqual([[competeSession.id, { decision: 'approve', strategy: 'squash' }]]);
    expect(store.getState().notices.map((n) => n.text)).toEqual(["You already picked Claude's version.", "You already picked Claude's version."]);
  });
  it('explains choose_variant from the daemon', async () => {
    const { store, approvals } = setup({}, { approval: async () => { throw new LinaApiError('No candidate chosen', 409, 'choose_variant'); } });
    await store.approve('squash');
    expect(approvals()).toEqual([[competeSession.id, { decision: 'approve', strategy: 'squash' }]]);
    const n = store.getState().notices.at(-1)!;
    expect(n.level).toBe('error');
    expect(n.text).toContain('Pick a winner first');
    expect(n.hint).toContain(`/choose ${AGENT_IDS.join('|')}`);
    expect(n.hint).toContain(`/approve ${AGENT_IDS.join('|')} [squash|merge|branch]`);
  });
  it('variant picks are refused outside compete', async () => {
    const { store, approvals } = setup({ config: { ...competeSession.config, mode: 'pair' } });
    await store.choose('codex');
    await store.approve(undefined, 'codex');
    expect(approvals()).toEqual([]);
    expect(store.getState().notices.map((n) => n.text)).toEqual(['/choose is for compete sessions (this one is pair).', 'There is only one version in a pair session — nothing to pick.']);
  });
  it('setTeam / setMode(custom) patch the session config with a mirrored developer', async () => {
    const { store, calls } = setup();
    const team = { planner: null, planCritic: null, developer: 'claude' as const, reviewers: ['codex' as const, 'claude' as const] };
    await store.setTeam(team);
    await store.setMode('custom');
    await store.setMode('parallel');
    const patches = calls.filter((c) => c.name === 'updateSession').map((c) => (c.args[1] as { config: unknown }).config);
    expect(patches[0]).toEqual({ mode: 'custom', team, developer: 'claude', reviewer: 'codex' });
    expect(patches[1]).toEqual({ mode: 'custom', team: { planner: 'codex', planCritic: 'claude', developer: 'codex', reviewers: ['claude'] }, developer: 'codex', reviewer: 'claude' });
    expect(patches[2]).toEqual({ mode: 'parallel' });
  });
  it('without a session, mode/team go to the next session config', async () => {
    const calls: { name: string; args: unknown[] }[] = [];
    const store = new TuiStore(stubClient(calls), { live: false, project, pendingConfig: { developer: 'claude', reviewer: 'codex' } });
    await store.setMode('compete');
    expect(store.getState().pendingConfig).toMatchObject({ mode: 'compete' });
    await store.setMode('custom');
    expect(store.getState().pendingConfig).toMatchObject({ mode: 'custom', team: { developer: 'claude', reviewers: ['codex'] } });
    await store.createSession('Build it');
    expect(calls.find((c) => c.name === 'createSession')?.args[0]).toMatchObject({ config: { mode: 'custom', team: { planner: 'claude', planCritic: 'codex', developer: 'claude', reviewers: ['codex'] } }, prompt: 'Build it' });
  });
});

describe('App: compete screen', () => {
  it('shows the pick-the-winner banner and both agents working concurrently', () => {
    const snap = competeSnapshot();
    snap.live.agents = { ...snap.live.agents, codex: { status: 'reviewing', role: 'reviewer', since: T0 }, claude: { status: 'writing', role: 'developer', since: T0, detail: 'src/limit.ts' } };
    const store = new TuiStore(stubClient([]), { view: viewFromSnapshot(snap), live: false, project });
    const out = stripAnsi(renderToString(<App store={store} cwd="/tmp" onQuit={() => {}} size={{ columns: 150, rows: 60 }} />, { columns: 150 }));
    for (const s of ['◆ Pick the winner — /choose codex|claude', 'CODEX  c0dec0d', 'Reviewer · Claude\'s v', 'Developer · own version', 'Reviewing', 'Writing code', 'claude opus rival']) expect(out).toContain(s);
    store.dispose();
  });
});

class FakeStdout extends Writable {
  columns = 140; rows = 45; isTTY = true; frames: string[] = [];
  _write(chunk: Buffer, _enc: string, cb: () => void) { this.frames.push(chunk.toString()); cb(); }
  get text() { return stripAnsi(this.frames.join('')); }
  get last() { return stripAnsi(this.frames.slice(-30).join('')); }
}
const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));

describe('App: modes v2 commands', () => {
  it('routes /choose, /approve <agent>, /diff <agent>, /mode and /team', async () => {
    const calls: { name: string; args: unknown[] }[] = [];
    const view = viewFromSnapshot(competeSnapshot());
    const store = new TuiStore(stubClient(calls, { approval: async () => view.session, diff: async () => ({ base: 'aaaaaaa', head: 'c1aude001', files: [{ path: 'src/limit.ts', status: 'added', additions: 1, deletions: 0, patch: '+export const LIMIT = 100;' }] }) }), { view, live: false, project });
    const stdout = new FakeStdout();
    const stdin = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode: (b: boolean) => void; ref: () => void; unref: () => void };
    stdin.isTTY = true; stdin.setRawMode = () => {}; stdin.ref = () => {}; stdin.unref = () => {};
    const inst = render(<App store={store} cwd="/tmp" onQuit={() => {}} size={{ columns: 140, rows: 45 }} />,
      { stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream, exitOnCtrlC: false, patchConsole: false, interactive: true });
    const type = async (t: string) => { stdin.write(t); await tick(); stdin.write('\r'); await tick(120); };
    try {
      await tick();
      await type('/choose claude');
      await type('/approve codex merge');
      expect(calls.filter((c) => c.name === 'approval').map((c) => c.args[1])).toEqual([{ decision: 'choose', variant: 'claude' }, { decision: 'approve', strategy: 'merge', variant: 'codex' }]);

      await type('/diff claude');
      expect(calls.find((c) => c.name === 'diff')?.args).toEqual([competeSession.id, { variant: 'claude' }]);
      expect(stdout.last).toContain("Claude's version");
      expect(stdout.last).toContain('export const LIMIT = 100;');
      stdin.write('\t'); await tick(150); // Tab cycles to the next target
      expect(calls.filter((c) => c.name === 'diff').at(-1)?.args).toEqual([competeSession.id, { variant: 'codex' }]);
      stdin.write('\x1b'); await tick(120);

      await type('/mode');
      expect(stdout.last).toContain('◆ Collaboration mode');
      expect(stdout.last).toContain('The lead splits the task');
      stdin.write('2'); await tick(120); // quick pick: architect
      expect(calls.filter((c) => c.name === 'updateSession').at(-1)?.args[1]).toEqual({ config: { mode: 'architect' } });

      await type('/team');
      expect(stdout.last).toContain('◆ Custom team');
      stdin.write('\x1b[B'); await tick(); stdin.write('\x1b[B'); await tick(); stdin.write('\x1b[C'); await tick(); // Implement → Claude
      stdin.write('\r'); await tick(120);
      expect(calls.filter((c) => c.name === 'updateSession').at(-1)?.args[1]).toEqual({ config: { mode: 'custom', team: { planner: 'codex', planCritic: 'claude', developer: 'claude', reviewers: ['claude'] }, developer: 'claude', reviewer: 'claude' } });

      await type('/team dev=claude review=codex+claude plan=none');
      expect(calls.filter((c) => c.name === 'updateSession').at(-1)?.args[1]).toEqual({ config: { mode: 'custom', team: { planner: null, planCritic: 'codex', developer: 'claude', reviewers: ['codex', 'claude'] }, developer: 'claude', reviewer: 'codex' } });
      await type('/team dev=nobody');
      expect(stdout.text).toContain('Unknown agent "nobody" for dev=');
    } finally {
      inst.unmount();
      store.dispose();
    }
  });
});

it('offers Freebuff in every team role and every supported reviewer pairing',()=>{
 const initial={planner:'codex',planCritic:'claude',developer:'codex',reviewers:['codex']} as TeamConfig;
 for(const [row,key] of [[0,'planner'],[1,'planCritic'],[2,'developer']] as const){
  let team=initial;const found=new Set<unknown>();for(let n=0;n<5;n++){found.add(team[key]);team=cycleTeam(team,row,1);}
  expect(found.has('freebuff')).toBe(true);
 }
 let team=initial;const options:string[]=[];for(let n=0;n<7;n++){options.push([...team.reviewers].sort().join('+'));team=cycleTeam(team,3,1);}
 for(const option of ['freebuff','codex+freebuff','claude+freebuff','claude+codex'])expect(options).toContain(option);
});
