import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { makeRepo, setupEnv, waitUntil } from './helpers.js';
setupEnv();
const { startServer } = await import('../../src/server/daemon.js');
const { LinaClient } = await import('../../src/shared/client.js');
const { MockAdapter, mockCalls } = await import('../../src/server/agents/mock.js');
const { setAdapterOverride } = await import('../../src/server/agents/index.js');
type Scenario = { protocol?: boolean; reviewFlag?: boolean; reject?: number; approved?: boolean; implemented?: boolean; proposals?: number; hold?: boolean };
const scenarios = new Map<string, Scenario>();
const handoff = '\n```lina-chat\n{"handoff":{"agent":"codex","message":"Review this proposed plan before implementation."}}\n```';
setAdapterOverride((agent, ctx) => ({ id: agent, async runTurn(opts, onEvent) {
  const scenario = scenarios.get(ctx.sessionId!);
  const step = /lina:step=(\w+)/.exec(opts.prompt)?.[1];
  const result = await new MockAdapter(agent, { delayMs: 0, holdMs: scenario?.hold && agent === 'codex' ? { consult: 60000 } : undefined }).runTurn(opts, onEvent);
  if (!scenario || !result.ok) return result;
  if ((step === 'consult' || step === 'chat') && agent === 'claude') {
    scenario.proposals = (scenario.proposals ?? 0) + 1;
    return { ...result, text: 'Plan: remember email and country only. No implementation yet. Codex should approve before I implement.' + (scenario.protocol ? handoff : scenario.reviewFlag ? '\n```lina-chat\n{"review":true}\n```' : '') };
  }
  if (step === 'consult' && agent === 'codex') {
    const reject = (scenario.reject ?? 0) > 0;
    scenario.reject = Math.max(0, (scenario.reject ?? 0) - 1);
    scenario.approved = !reject;
    return { ...result, text: `Plan ${reject ? 'needs changes' : 'approved'}.\n\`\`\`lina-review\n${JSON.stringify({ verdict: reject ? 'request_changes' : 'approve', summary: 'Plan review', findings: [], resolved: [], withdrawn: [] })}\n\`\`\`` };
  }
  if (step === 'feedback' && !scenario.approved) {
    expect(opts.access).toBe('read');
    expect(existsSync(join(opts.cwd, 'remember-me.txt'))).toBe(false);
    return { ...result, text: 'Revised plan: protect edited fields from asynchronous prefill.' + handoff };
  }
  if (step === 'feedback' && scenario.approved && !scenario.implemented) {
    expect(opts.access).toBe('write');
    scenario.implemented = true;
    writeFileSync(join(opts.cwd, 'remember-me.txt'), 'Remember email and country; never the password.\n');
    return { ...result, text: 'Implemented the approved plan.\n```lina-response\n{"items":[]}\n```' };
  }
  if (step === 'review') return { ...result, text: 'Implementation approved.\n```lina-review\n{"verdict":"approve","summary":"Implementation reviewed","findings":[],"resolved":[],"withdrawn":[]}\n```' };
  return result;
} }));
let srv: Awaited<ReturnType<typeof startServer>>;
let api: InstanceType<typeof LinaClient>;
async function start() { srv = await startServer({ port: 0 }); api = new LinaClient({ baseUrl: `http://127.0.0.1:${srv.port}`, token: srv.token }); }
beforeAll(start); afterAll(async () => { await srv.close(); });
async function create(scenario: Scenario, maxRounds = 3) {
  const repo = makeRepo(); const project = await api.addProject({ path: repo });
  const s = await api.createSession({ projectId: project.id, config: { mock: true, developer: 'claude', reviewer: 'codex', maxRounds } });
  scenarios.set(s.id, scenario); return { repo, s };
}
async function complete(id: string) { await waitUntil(async () => (await api.session(id)).session.status === 'completed', 15000); return api.session(id); }
const calls = (repo: string) => mockCalls.filter((c) => c.opts.cwd === repo);

describe('proposal and no-edit peer routing', () => {
  it('runs the exact two-agent request from one owner message, without waiting for file edits or a nudge', async () => {
    const scenario: Scenario = {}; const { repo, s } = await create(scenario);
    const request = '@claude Implement Remember Me at login screen, @codex Review it before implementing it you will give the ok to claude';
    await api.send(s.id, request); const snap = await complete(s.id);
    expect(calls(repo).map((c) => `${c.agent}:${c.step}`)).toEqual(['claude:consult', 'codex:consult', 'claude:feedback', 'codex:review', 'claude:feedback']);
    expect(scenario.implemented).toBe(true);
    expect(snap.events.some((e) => e.type === 'message' && e.data.text.includes("Automatically handing claude's proposal/question to codex"))).toBe(true);
    expect(existsSync(join(repo, 'remember-me.txt'))).toBe(true);
    expect(calls(repo)[1].prompt).toContain('No implementation yet');
    expect(calls(repo)[2].prompt).toContain('Plan approved');
    expect(snap.events.filter((e) => e.type === 'message' && e.actor === 'user')).toHaveLength(1);
    expect(snap.events.some((e) => e.type === 'message' && e.data.kind === 'summary' && e.data.text.includes('Implement Remember Me'))).toBe(true);
    await api.deleteSession(s.id);
  });
  it.each(['mention', 'plain chat'])('routes an explicit agent handoff from %s even without a second owner @mention', async (kind) => {
    const { repo, s } = await create({ protocol: true });
    await api.send(s.id, kind === 'mention' ? '@claude Propose Remember Me' : 'How would you implement Remember Me?');
    await complete(s.id);
    expect(calls(repo).some((c) => c.agent === 'codex' && c.step === 'consult')).toBe(true);
    expect(existsSync(join(repo, 'remember-me.txt'))).toBe(true);
    const messages = (await api.session(s.id)).events.filter((e) => e.type === 'message');
    expect(messages.some((e) => e.actor === 'claude' && e.data.text.includes('```lina-chat'))).toBe(false);
    await api.deleteSession(s.id);
  });
  it('keeps proposal revision read-only until the reviewer approves, then implements automatically', async () => {
    const { repo, s } = await create({ protocol: true, reject: 1 });
    await api.send(s.id, '@claude Propose Remember Me'); await complete(s.id);
    const feedback = calls(repo).filter((c) => c.step === 'feedback');
    expect(feedback.slice(0,2).map((c) => c.opts.access)).toEqual(['read','write']);
    expect(calls(repo).filter((c) => c.agent === 'codex' && c.step === 'consult')).toHaveLength(2);
    expect(existsSync(join(repo, 'remember-me.txt'))).toBe(true);
    await api.deleteSession(s.id);
  });
  it('stops repeated rejected proposals at the handoff limit without implementing', async () => {
    const { repo, s } = await create({ protocol: true, reject: 10 }, 1);
    await api.send(s.id, '@claude Propose Remember Me'); const snap = await complete(s.id);
    expect(calls(repo).filter((c) => c.agent === 'codex')).toHaveLength(1);
    expect(calls(repo).filter((c) => c.step === 'feedback').every((c) => c.opts.access === 'read')).toBe(true);
    expect(existsSync(join(repo, 'remember-me.txt'))).toBe(false);
    expect(snap.events.some((e) => e.type === 'message' && e.data.text.includes('handoff limit reached'))).toBe(true);
    await api.deleteSession(s.id);
  });
  it('resumes an interrupted peer review without repeating the developer proposal or losing the handoff', async () => {
    const scenario: Scenario = { protocol: true, hold: true }; const { repo, s } = await create(scenario);
    await api.send(s.id, '@claude Propose Remember Me');
    await waitUntil(() => calls(repo).some((c) => c.agent === 'codex' && c.step === 'consult'));
    await srv.close(); scenario.hold = false; await start(); await api.control(s.id, 'resume'); await complete(s.id);
    expect(scenario.proposals).toBe(1);
    expect(scenario.implemented).toBe(true);
    expect((await api.session(s.id)).events.filter((e) => e.type === 'message' && e.actor === 'user')).toHaveLength(1);
    await api.deleteSession(s.id);
  });
  it('honors review:true for a proposal even when no files were edited', async () => {
    const { repo, s } = await create({ reviewFlag: true });
    await api.send(s.id, '@claude Propose Remember Me'); await complete(s.id);
    expect(calls(repo).some((c) => c.agent === 'codex' && c.step === 'consult')).toBe(true);
    expect(existsSync(join(repo, 'remember-me.txt'))).toBe(true);
    await api.deleteSession(s.id);
  });

});
