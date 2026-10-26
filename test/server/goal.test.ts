import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { setupEnv, makeRepo, waitUntil } from './helpers.js';
setupEnv();
const { startServer } = await import('../../src/server/daemon.js');
const { LinaClient } = await import('../../src/shared/client.js');
const { MockAdapter, mockCalls } = await import('../../src/server/agents/mock.js');
const { setAdapterOverride } = await import('../../src/server/agents/index.js');
const scenarios = new Map<string, string>();
const holds = new Map<string, Record<string, number>>();
setAdapterOverride((agent, ctx) => ({ id: agent, async runTurn(opts, emit) {
  const scenario = scenarios.get(ctx.sessionId!);
  if (scenario === 'goal-test-fix' && opts.prompt.includes('Fix the failing verification')) writeFileSync(join(opts.cwd,'hello.js'), 'exports.hello = name => { if (typeof name !== "string" || !name.trim()) throw new TypeError("name required"); return `Hello, ${name.trim()}!`; };\n');
  const result = await new MockAdapter(agent, { delayMs: 0, scenario, holdMs: holds.get(ctx.sessionId!) }).runTurn(opts, emit);
  const marker = /lina:step=(\w+) round=(\d+)/.exec(opts.prompt);
  if (marker?.[1] === 'review' && scenario === 'goal-test-fix') return { ...result, text: '```lina-review\n'+JSON.stringify({verdict:'approve',summary:'Reviewed',findings:[],resolved:[],withdrawn:[]})+'\n```' };
  if (marker?.[1] === 'review' && marker[2] === '1' && ['minor-only','nit-only'].includes(scenario!)) {
    return { ...result, text: '```lina-review\n'+JSON.stringify({verdict:'request_changes',summary:'Small fix remains',findings:[{severity:scenario==='minor-only'?'minor':'nit',title:'Polish the compact warning',detail:'Keep it concise.'}],resolved:[],withdrawn:[]})+'\n```' };
  }
  if (marker?.[1] === 'review' && scenario === 'goal-review-limit' && Number(marker[2]) <= 2) {
    return { ...result, text: '```lina-review\n'+JSON.stringify({verdict:'request_changes',summary:'Verification still needs work',findings:[{...(marker[2]==='2'?{id:'F1'}:{}),severity:'major',title:'Validation missing',detail:'Fix the validation test.'}],resolved:[],withdrawn:[]})+'\n```' };
  }
  return result;
}}));
let srv: Awaited<ReturnType<typeof startServer>>;
let api: InstanceType<typeof LinaClient>;
async function boot() { srv = await startServer({ port: 0 }); api = new LinaClient({ baseUrl: `http://127.0.0.1:${srv.port}`, token: srv.token }); }
beforeAll(boot);
afterAll(async () => { await srv.close(); });
async function goal(scenario = 'default', files: Record<string,string> = {}) {
  const project = await api.addProject({ path: makeRepo(files) });
  const s = await api.createSession({ projectId: project.id, config: { mock: true, mode: 'architect', interactionMode: 'workflow', goal: 'Build hello' } });
  scenarios.set(s.id, scenario);
  return s;
}
async function status(id: string, value: string) {
  await waitUntil(async () => (await api.session(id)).session.status === value, 20_000);
  return api.session(id);
}
it('starts a full goal workflow when its objective begins with agent mentions', async () => {
  const s = await goal();
  const objective = '@codex @claude Make a plan, discuss it, then build hello';
  await api.updateSession(s.id, { config: { goal: objective } });
  await api.send(s.id, objective);
  expect((await status(s.id, 'completed')).session.goalStatus).toBe('complete');
  const calls = mockCalls.filter((c) => c.opts.cwd === s.workspacePath);
  expect(calls.some((c) => c.step === 'plan' && c.prompt.includes(objective))).toBe(true);
  expect(calls.some((c) => c.step === 'plan_review')).toBe(true);
  expect(calls.some((c) => c.step === 'goal_check')).toBe(true);
  expect(calls.some((c) => c.step === 'consult')).toBe(false);
});
it('can resume a legacy idle goal that has not entered its workflow', async () => {
  const s = await goal();
  await api.control(s.id, 'resume');
  expect((await status(s.id, 'completed')).session.goalStatus).toBe('complete');
});
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
it.each(['goal-blocked'])('pauses %s for owner input and resumes only on request', async (scenario) => {
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
it.each(['minor-only','nit-only'])('automatically resolves %s findings without a second owner message', async (scenario) => {
  const s = await goal(scenario);
  await api.send(s.id,'Build hello');
  const snap = await status(s.id,'completed');
  expect(snap.session.goalStatus).toBe('complete');
  expect(mockCalls.some(c=>c.opts.cwd===s.workspacePath&&c.step==='revise')).toBe(true);
  expect(snap.findings.every(f=>['resolved','withdrawn','waived'].includes(f.status))).toBe(true);
  expect(snap.events.filter(e=>e.type==='message'&&e.actor==='user')).toHaveLength(1);
  expect(snap.events.some(e=>e.type==='message'&&e.data.text.startsWith('Goal needs your input'))).toBe(false);
});
it('renews review cycles after a round limit without waiving maintained findings',async()=>{
  const s=await goal('goal-review-limit');
  await api.updateSession(s.id,{config:{maxRounds:1}});
  await api.send(s.id,'Build hello');
  const snap=await status(s.id,'completed');
  expect(snap.session.goalStatus).toBe('complete');
  expect(mockCalls.filter(c=>c.opts.cwd===s.workspacePath&&c.step==='review').length).toBeGreaterThanOrEqual(3);
  expect(snap.findings.some(f=>f.status==='waived')).toBe(false);
});
it('repairs malformed goal output without asking for owner approval',async()=>{
  const s=await goal('goal-malformed-once');await api.send(s.id,'Build hello');
  expect((await status(s.id,'completed')).session.goalStatus).toBe('complete');
  expect(mockCalls.some(c=>c.opts.cwd===s.workspacePath&&c.step==='goal_check_repair')).toBe(true);
});
it('schedules malformed assessments for automatic retry and respects explicit pause across restart',async()=>{
  const s=await goal('goal-malformed');await api.send(s.id,'Build hello');
  const snap=await status(s.id,'failed');expect(snap.session.retryAt).toBeGreaterThan(Date.now());
  expect(snap.session.goalStatus).toBe('working');
  await api.control(s.id,'pause');await srv.close();await boot();
  expect((await api.session(s.id)).session.status).toBe('paused');
  expect((await api.session(s.id)).session.retryAt).toBeNull();
  scenarios.set(s.id,'default');await api.control(s.id,'resume');
  expect((await status(s.id,'completed')).session.goalStatus).toBe('complete');
});
it('rechecks stale findings on a legacy blocked goal before writing any more code',async()=>{
  const s=await goal();await api.send(s.id,'Build hello');const snap=await status(s.id,'completed');
  const state=srv.manager.db.getSessionState<any>(s.id)!;
  state.goalStatus='blocked';state.automaticDisabled=true;state.step='verify';
  state.findings=[{id:'F99',severity:'minor',status:'open',title:'Already shipped fix',detail:'Check current files',raisedBy:'claude',round:state.round,history:[]}];
  srv.manager.db.updateSession({...snap.session,status:'paused',phase:'verifying'},state);
  await srv.close();await boot();const before=mockCalls.length;
  await api.control(s.id,'resume');expect((await status(s.id,'completed')).session.goalStatus).toBe('complete');
  expect(mockCalls.slice(before).some(c=>c.step==='review')).toBe(true);
  expect(mockCalls.slice(before).some(c=>c.step==='revise'||c.step==='implement')).toBe(false);
});
it('fixes failed verification automatically even when the reviewer approves',async()=>{
  const s=await goal('goal-test-fix',{'validation.test.js':`const {test}=require('node:test');const assert=require('node:assert/strict');test('validates names',()=>assert.throws(()=>require('./hello.js').hello('')));`});
  await api.send(s.id,'Build hello');const snap=await status(s.id,'completed');
  expect(snap.session.goalStatus).toBe('complete');
  expect(snap.events.some(e=>e.type==='tests'&&!e.data.ok)).toBe(true);
  expect(mockCalls.some(c=>c.opts.cwd===s.workspacePath&&c.step==='implement'&&c.prompt.includes('Fix the failing verification'))).toBe(true);
  expect(snap.events.filter(e=>e.type==='message'&&e.actor==='user')).toHaveLength(1);
});
it('recovers a scheduled assessment repair automatically after restart',async()=>{
  const s=await goal('goal-malformed');await api.send(s.id,'Build hello');const snap=await status(s.id,'failed');
  const state=srv.manager.db.getSessionState<any>(s.id)!;state.goalRetryAt=Date.now()+200;
  srv.manager.db.updateSession(snap.session,state);await srv.close();scenarios.set(s.id,'default');await boot();
  const completed=await status(s.id,'completed');expect(completed.session.goalStatus).toBe('complete');
  expect(completed.events.filter(e=>e.type==='message'&&e.actor==='user')).toHaveLength(1);
});
it('durably queues a resumed goal while its project is busy instead of asking the owner again',async()=>{
  const first=await goal();holds.set(first.id,{goal_check:60_000});
  const second=await api.createSession({projectId:first.projectId,config:{mock:true,mode:'architect',interactionMode:'workflow',goal:'Build hello'}});
  await api.send(first.id,'Build hello');await waitUntil(()=>mockCalls.some(c=>c.opts.cwd===first.workspacePath&&c.step==='goal_check'));
  await api.control(second.id,'resume');const queued=await api.session(second.id);
  expect(queued.session.goalResumeQueued).toBe(true);expect(queued.session.retryAt).toBeGreaterThan(Date.now());
  await api.control(first.id,'cancel');await srv.close();holds.delete(first.id);await boot();
  const snap=await status(second.id,'completed');expect(snap.session.goalStatus).toBe('complete');expect(snap.session.goalResumeQueued).toBe(false);
  expect((await api.session(first.id)).session.status).toBe('cancelled');
});
it('validates goal settings instead of silently ignoring them', async () => {
  const project = await api.addProject({ path: makeRepo() });
  await expect(api.createSession({ projectId: project.id, config: { goal: '   ', interactionMode: 'workflow' } })).rejects.toThrow();
  await expect(api.createSession({ projectId: project.id, config: { goal: 'Build hello', interactionMode: 'chat' } })).rejects.toThrow();
  await expect(api.createSession({ projectId: project.id, config: { goal: 'Build hello', mode: 'solo', interactionMode: 'workflow' } })).rejects.toThrow();
});
