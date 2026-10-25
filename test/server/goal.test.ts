import { afterAll, beforeAll, expect, it } from 'vitest';
import { setupEnv, makeRepo, waitUntil } from './helpers.js';
setupEnv();
const { startServer } = await import('../../src/server/daemon.js');
const { LinaClient } = await import('../../src/shared/client.js');
const { MockAdapter, mockCalls } = await import('../../src/server/agents/mock.js');
const { setAdapterOverride } = await import('../../src/server/agents/index.js');
const scenarios = new Map<string, string>();
const holds = new Map<string, Record<string, number>>();
setAdapterOverride((agent, ctx) => new MockAdapter(agent, { delayMs: 0, scenario: scenarios.get(ctx.sessionId!), holdMs: holds.get(ctx.sessionId!) }));
let srv: Awaited<ReturnType<typeof startServer>>;
let api: InstanceType<typeof LinaClient>;
async function boot() { srv = await startServer({ port: 0 }); api = new LinaClient({ baseUrl: `http://127.0.0.1:${srv.port}`, token: srv.token }); }
beforeAll(boot);
afterAll(async () => { await srv.close(); });
async function goal(scenario = 'default') {
  const project = await api.addProject({ path: makeRepo() });
  const s = await api.createSession({ projectId: project.id, config: { mock: true, mode: 'architect', interactionMode: 'workflow', goal: 'Build hello' } });
  scenarios.set(s.id, scenario);
  return s;
}
async function status(id: string, value: string) {
  await waitUntil(async () => (await api.session(id)).session.status === value, 20_000);
  return api.session(id);
}
it('automatically continues remaining goal work without another owner message', async () => {
  const s = await goal('goal-continue');
  await api.send(s.id, 'Build hello');
  const snap = await status(s.id, 'completed');
  expect(snap.session.goalStatus).toBe('complete');
  const calls = mockCalls.filter((c) => c.opts.cwd === s.workspacePath);
  expect(calls.filter((c) => c.step === 'goal_check')).toHaveLength(2);
  expect(calls.some((c) => c.step === 'implement' && c.prompt.includes('Finish the requested input validation.'))).toBe(true);
  expect(snap.events.filter((e) => e.type === 'message' && e.actor === 'user')).toHaveLength(1);
});
it.each(['goal-blocked', 'goal-malformed'])('pauses %s for owner input and resumes only on request', async (scenario) => {
  const s = await goal(scenario);
  await api.send(s.id, 'Build hello');
  expect((await status(s.id, 'paused')).session.goalStatus).toBe('blocked');
  await srv.close(); await boot();
  expect((await api.session(s.id)).session.status).toBe('paused');
  scenarios.set(s.id, 'default');
  await api.control(s.id, 'resume');
  expect((await status(s.id, 'completed')).session.goalStatus).toBe('complete');
});
it('recovers an active goal after restart without a manual resume', async () => {
  const s = await goal();
  holds.set(s.id, { goal_check: 60_000 });
  await api.send(s.id, 'Build hello');
  await waitUntil(() => mockCalls.some((c) => c.opts.cwd === s.workspacePath && c.step === 'goal_check'));
  await srv.close(); holds.delete(s.id); await boot();
  expect((await status(s.id, 'completed')).session.goalStatus).toBe('complete');
});
it('continues a blocked goal after the owner supplies the decision and resumes', async () => {
  const s = await goal('goal-blocked');
  await api.send(s.id, 'Build hello');
  await status(s.id, 'paused');
  scenarios.set(s.id, 'default');
  await api.send(s.id, 'Use the existing local deployment target.');
  await api.control(s.id, 'resume');
  expect((await status(s.id, 'completed')).session.goalStatus).toBe('complete');
  expect(srv.manager.db.getSessionState<{ automaticDisabled?: boolean }>(s.id)?.automaticDisabled).toBe(false);
});
it('validates goal settings instead of silently ignoring them', async () => {
  const project = await api.addProject({ path: makeRepo() });
  await expect(api.createSession({ projectId: project.id, config: { goal: '   ', interactionMode: 'workflow' } })).rejects.toThrow();
  await expect(api.createSession({ projectId: project.id, config: { goal: 'Build hello', interactionMode: 'chat' } })).rejects.toThrow();
  await expect(api.createSession({ projectId: project.id, config: { goal: 'Build hello', mode: 'solo', interactionMode: 'workflow' } })).rejects.toThrow();
});
