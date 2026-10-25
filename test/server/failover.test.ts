import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { makeRepo, setupEnv, waitUntil } from './helpers.js';
import type { AgentId } from '../../src/shared/types.js';
setupEnv();
const { startServer } = await import('../../src/server/daemon.js');
const { LinaClient } = await import('../../src/shared/client.js');
const { MockAdapter, mockCalls } = await import('../../src/server/agents/mock.js');
const { setAdapterOverride } = await import('../../src/server/agents/index.js');
type Scenario = { blocked: AgentId[]; code?: 'auth' | 'rate_limited' | 'timeout'; partial?: boolean; signal?: boolean; hold?: boolean; warning?: boolean };
const scenarios = new Map<string, Scenario>();
const attempts: { id:string; agent:AgentId; prompt:string; cwd:string; access:string; at:number; resume?:string; model:string }[] = [];
setAdapterOverride((agent, ctx) => ({ id:agent, async runTurn(opts,onEvent) {
 const scenario=scenarios.get(ctx.sessionId!);
 attempts.push({id:ctx.sessionId!,agent,prompt:opts.prompt,cwd:opts.cwd,access:opts.access,at:Date.now(),resume:opts.resumeId,model:opts.model});
 if(scenario?.warning) { onEvent({t:'rate_limit',info:{observedAt:Date.now(),windows:{five_hour:{utilization:1,status:'allowed'}}}}); expect(opts.signal.aborted).toBe(false); }
 if(scenario?.blocked.includes(agent)) {
  if(scenario.partial&&opts.access==='write') appendFileSync(join(opts.cwd,'README.md'),'\nPartial work from limited provider.\n');
  if(scenario.signal) {
   onEvent({t:'rate_limit',info:{observedAt:Date.now(),windows:{five_hour:{utilization:1,status:'rejected',resetsAt:Date.now()+3600000}}}});
   expect(opts.signal.aborted).toBe(true);
   return {ok:false,text:'Partial progress',usage:{},durationMs:0,error:{code:'cancelled',message:'Process cancelled after quota signal'}};
  }
  return {ok:false,text:'Partial progress',providerSessionId:`blocked-${agent}`,usage:{},durationMs:0,error:{code:scenario.code??'rate_limited',message:'Provider session limit reached'}};
 }
 return new MockAdapter(agent,{delayMs:0,holdMs:scenario?.hold?{chat:60000}:undefined}).runTurn(opts,onEvent);
} }));
let srv:Awaited<ReturnType<typeof startServer>>;let api:InstanceType<typeof LinaClient>;
async function start(){srv=await startServer({port:0});api=new LinaClient({baseUrl:`http://127.0.0.1:${srv.port}`,token:srv.token});}
beforeAll(start);afterAll(async()=>{await srv.close();});
async function create(developer:AgentId,scenario:Scenario,mode:'solo'|'pair'='solo'){
 const repo=makeRepo();const p=await api.addProject({path:repo});const s=await api.createSession({projectId:p.id,config:{mock:true,mode,developer,reviewer:developer==='claude'?'codex':'claude'}});scenarios.set(s.id,scenario);return {repo,s};
}
async function settled(id:string,status='completed'){await waitUntil(async()=>(await api.session(id)).session.status===status,15000);return api.session(id);}
const of=(id:string)=>attempts.filter(x=>x.id===id);

describe('automatic provider-limit takeover',()=>{
 it.each(['claude','codex'] as const)('immediately continues %s work with the other provider, in the same workspace and without another message',async(developer)=>{
  const fallback=developer==='claude'?'codex':'claude';const {repo,s}=await create(developer,{blocked:[developer],partial:true});
  await api.send(s.id,'Build hello');const snap=await settled(s.id);
  expect(of(s.id).slice(0,2).map(x=>x.agent)).toEqual([developer,fallback]);
  expect(of(s.id)[1].at-of(s.id)[0].at).toBeLessThan(2000);
  expect(of(s.id).every(x=>x.cwd===repo)).toBe(true);
  expect(of(s.id)[1].prompt).toContain('preserve partial edits');
  expect(of(s.id)[1].prompt).toContain('Partial progress');
  expect(of(s.id)[1].prompt).toContain('README.md');
  expect(of(s.id)[1].resume).toBeUndefined();
  expect(of(s.id)[1].model).toBe(s.config.models[fallback].model);
  expect(readFileSync(join(repo,'README.md'),'utf8')).toContain('Partial work from limited provider');
  expect(existsSync(join(repo,'hello.js'))).toBe(true);
  expect(snap.events.filter(e=>e.type==='message'&&e.actor==='user')).toHaveLength(1);
  expect(snap.events.some(e=>e.type==='message'&&e.actor===fallback&&e.data.role==='developer')).toBe(true);
  expect(snap.events.some(e=>e.type==='message'&&e.actor==='lina'&&e.data.text.includes(`${fallback} (developer) said`))).toBe(true);
  expect(of(s.id).filter(x=>x.agent===developer)).toHaveLength(1);
  await api.deleteSession(s.id);
 });
 it('handles a rejected quota stream immediately rather than waiting for retries or a timeout',async()=>{
  const {s}=await create('claude',{blocked:['claude'],signal:true});await api.send(s.id,'Build hello');await settled(s.id);
  expect(of(s.id).slice(0,2).map(x=>x.agent)).toEqual(['claude','codex']);
  expect(srv.manager.db.getSessionState<{providerLimits:Record<string,{until:number}>}>(s.id)!.providerLimits.claude.until).toBeGreaterThan(Date.now()+3000000);
  await api.deleteSession(s.id);
 });
 it('keeps reviewer takeover read-only and explicitly labels self-review',async()=>{
  const {s}=await create('codex',{blocked:['claude']},'pair');await api.send(s.id,'Build hello');const snap=await settled(s.id);
  const limited=of(s.id).findIndex(x=>x.agent==='claude');expect(limited).toBeGreaterThan(0);
  expect(of(s.id)[limited+1]).toMatchObject({agent:'codex',access:'read'});
  expect(of(s.id)[limited+1].prompt).toContain('self-review');
  const reviews=snap.events.filter(e=>e.type==='review');expect(reviews.length).toBeGreaterThan(0);
  expect(reviews.every(e=>e.data.reviewer==='codex')).toBe(true);
  expect(reviews.some(e=>e.data.summary.includes('independent reviewer unavailable'))).toBe(true);
  expect(snap.events.some(e=>e.type==='message'&&e.data.kind==='summary'&&e.data.text.includes('self-review after provider takeover'))).toBe(true);
  expect(snap.findings.every(f=>f.raisedBy==='codex'&&f.reviewerSlot==='claude')).toBe(true);
  await api.deleteSession(s.id);
 });
 it('stops once if both providers are exhausted, preserving the failed step and edits',async()=>{
  const {repo,s}=await create('claude',{blocked:['claude','codex'],partial:true});await api.send(s.id,'Build hello');const snap=await settled(s.id,'failed');
  expect(of(s.id).map(x=>x.agent)).toEqual(['claude','codex']);
  expect(snap.events.some(e=>e.type==='error'&&e.data.message.includes('Both providers are limited'))).toBe(true);
  expect(readFileSync(join(repo,'README.md'),'utf8')).toContain('Partial work');
  await api.control(s.id,'resume');await settled(s.id,'failed');expect(of(s.id)).toHaveLength(2);
  await api.deleteSession(s.id);
 });
 it.each(['auth','timeout'] as const)('does not treat %s failures as a quota takeover',async(code)=>{
  const {s}=await create('claude',{blocked:['claude'],code});await api.send(s.id,'Build hello');await settled(s.id,'failed');expect(of(s.id).map(x=>x.agent)).toEqual(['claude']);await api.deleteSession(s.id);
 });
 it('persists provider cooldown through daemon restart and still routes a targeted request exactly once',async()=>{
  const {s}=await create('claude',{blocked:['claude']});await api.send(s.id,'@claude add a note');await settled(s.id);
  const before=of(s.id).length;await srv.close();await start();await api.send(s.id,'@claude add another note');const snap=await settled(s.id);
  expect(of(s.id).slice(before).every(x=>x.agent==='codex')).toBe(true);
  expect(snap.session.pendingMessages).toBe(0);
  await api.deleteSession(s.id);
 });
 it('reconsiders the original provider after its cooldown expires',async()=>{
  const scenario:Scenario={blocked:['claude']};const {s}=await create('claude',scenario);await api.send(s.id,'Build hello');await settled(s.id);
  const state=srv.manager.db.getSessionState<any>(s.id)!;state.providerLimits.claude.until=Date.now()-1;
  srv.manager.db.updateSession((await api.session(s.id)).session,state);scenario.blocked=[];
  await srv.close();await start();const before=of(s.id).length;await api.send(s.id,'What changed?');await settled(s.id);
  expect(of(s.id)[before].agent).toBe('claude');await api.deleteSession(s.id);
 });
 it('does not switch providers for an allowed usage warning',async()=>{
  const {s}=await create('claude',{blocked:[],warning:true});await api.send(s.id,'Build hello');await settled(s.id);
  expect(of(s.id).every(x=>x.agent==='claude')).toBe(true);
  expect(srv.manager.db.getSessionState<any>(s.id)!.providerLimits).toBeUndefined();
  await api.deleteSession(s.id);
 });

 it('lets a direct owner request reach the acting developer after takeover instead of treating it as a read-only review',async()=>{
  const {repo,s}=await create('claude',{blocked:['claude']});await api.send(s.id,'Build hello');await settled(s.id);
  const before=of(s.id).length;await api.send(s.id,'@codex add a pickup note');await settled(s.id);
  expect(of(s.id)[before]).toMatchObject({agent:'codex',access:'write'});
  expect(readFileSync(join(repo,'NOTES.md'),'utf8')).toContain('add a pickup note');
  await api.deleteSession(s.id);
 });

});
