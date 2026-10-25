import { appendFileSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { makeRepo, setupEnv, waitUntil } from './helpers.js';
import type { AgentId } from '../../src/shared/types.js';
setupEnv();
const { startServer } = await import('../../src/server/daemon.js');
const { LinaClient } = await import('../../src/shared/client.js');
const { MockAdapter } = await import('../../src/server/agents/mock.js');
const { setAdapterOverride } = await import('../../src/server/agents/index.js');
type Scenario = { until: Partial<Record<AgentId,number>>; hint?: Partial<Record<AgentId,number>>; unknown?:boolean; unknownAfterFirst?:boolean; hold?:boolean; approve?:boolean; extra?:boolean };
const scenarios=new Map<string,Scenario>();
const calls:{id:string;agent:AgentId;role:string;step:string;at:number;prompt:string}[]=[];
setAdapterOverride((agent,ctx)=>({id:agent,async runTurn(opts,onEvent){
 const s=scenarios.get(ctx.sessionId!)!;
 const step=/lina:step=(\w+)/.exec(opts.prompt)?.[1]??'consult';
 calls.push({id:ctx.sessionId!,agent,role:opts.access,step,at:Date.now(),prompt:opts.prompt});
 if((s?.until[agent]??0)>Date.now()) {
  const unknown=s.unknown||(s.unknownAfterFirst&&calls.filter(c=>c.id===ctx.sessionId).length>2);
  return {ok:false,text:'Provider limit',usage:{},durationMs:0,error:{code:'rate_limited',message:'Usage limit reached',...(!unknown?{retryAt:s.hint?.[agent]??s.until[agent]}:{})}};
 }
 if(s?.extra&&step==='chat'&&opts.access==='write'){appendFileSync(join(opts.cwd,'README.md'),'\nA new contribution by Claude.\n');s.extra=false;}
 const result=await new MockAdapter(agent,{delayMs:0,holdMs:s?.hold?{chat:60000}:undefined}).runTurn(opts,onEvent);
 if(s?.approve&&step==='review') return {...result,text:'Reviewed independently.\n```lina-review\n{"verdict":"approve","summary":"Approved","findings":[],"resolved":[],"withdrawn":[]}\n```'};
 return result;
}}));
let srv:Awaited<ReturnType<typeof startServer>>;let api:InstanceType<typeof LinaClient>;
async function start(){srv=await startServer({port:0});api=new LinaClient({baseUrl:`http://127.0.0.1:${srv.port}`,token:srv.token});}
beforeAll(start);afterAll(async()=>{await srv.close();});
async function create(scenario:Scenario,mode:'solo'|'pair'='solo',repo=makeRepo()){
 const p=await api.addProject({path:repo});const s=await api.createSession({projectId:p.id,config:{mock:true,mode,developer:'claude',reviewer:'codex'}});
 scenarios.set(s.id,scenario);return {repo,s};
}
const of=(id:string)=>calls.filter(c=>c.id===id);
async function status(id:string,expected:string){await waitUntil(async()=>(await api.session(id)).session.status===expected,15000);return api.session(id);}
async function reviewed(id:string){await waitUntil(async()=>{
 const snap=await api.session(id);return snap.session.status==='completed'&&!srv.manager.db.getSessionState<any>(id)!.deferredReview&&snap.events.some(e=>e.type==='message'&&e.data.text==='Deferred independent review completed.');
},15000);return api.session(id);}

describe('durable reset retries and independent review',()=>{
 it('automatically resumes at the earliest provider reset without another owner message',async()=>{
  const now=Date.now();const {s}=await create({until:{claude:now+10000,codex:now+1200}});
  await api.send(s.id,'Build hello');const waiting=await status(s.id,'failed');
  expect(waiting.session.retryAt).toBeGreaterThan(now+1200);
  expect(waiting.session.retryAt).toBeLessThan(now+4000);
  const snap=await status(s.id,'completed');
  expect(of(s.id).slice(0,3).map(c=>c.agent)).toEqual(['claude','codex','codex']);
  expect(of(s.id)[2].at).toBeGreaterThanOrEqual(now+1200);
  expect(snap.events.filter(e=>e.type==='message'&&e.actor==='user')).toHaveLength(1);
  expect(snap.session.retryAt).toBeNull();
  await api.deleteSession(s.id);
 });
 it('restores a waiting reset timer after daemon restart',async()=>{
  const at=Date.now()+1200;const {s}=await create({until:{claude:at,codex:at}});
  await api.send(s.id,'Build hello');const waiting=await status(s.id,'failed');const retry=waiting.session.retryAt;
  await srv.close();await start();expect((await api.session(s.id)).session.retryAt).toBe(retry);
  await status(s.id,'completed');expect(of(s.id)).toHaveLength(3);await api.deleteSession(s.id);
 });
 it('continues an automatic retry interrupted by daemon shutdown',async()=>{
  const at=Date.now()+1200;const scenario:Scenario={until:{claude:at,codex:at},hold:true};const {s}=await create(scenario);
  await api.send(s.id,'Build hello');await status(s.id,'failed');
  await waitUntil(()=>of(s.id).length>=3,15000);await srv.close();scenario.hold=false;await start();
  await status(s.id,'completed');expect(of(s.id)).toHaveLength(4);await api.deleteSession(s.id);
 });
 it.each(['pause','cancel'] as const)('%s stops a waiting retry across restart',async(action)=>{
  const at=Date.now()+1200;const {s}=await create({until:{claude:at,codex:at}});
  await api.send(s.id,'Build hello');await status(s.id,'failed');await api.control(s.id,action);
  const stopped=await api.session(s.id);expect(stopped.session.retryAt).toBeNull();
  expect(stopped.session.status).toBe(action==='pause'?'paused':'cancelled');
  await srv.close();await start();await new Promise(r=>setTimeout(r,2500));
  expect(of(s.id)).toHaveLength(2);
  if(action==='pause'){await api.control(s.id,'resume');await status(s.id,'completed');}
  await api.deleteSession(s.id);
 });
 it('automatically gets a real independent-provider review after fallback work is completed',async()=>{
  const at=Date.now()+3000;const {s}=await create({until:{claude:at},approve:true},'pair');
  await api.send(s.id,'Build hello');const first=await status(s.id,'completed');
  expect(first.session.retryAt).toBeGreaterThanOrEqual(at);
  expect(first.events.some(e=>e.type==='review'&&e.actor==='codex'&&e.data.summary.includes('Self-review'))).toBe(true);
  const snap=await reviewed(s.id);
  expect(of(s.id).some(c=>c.agent==='claude'&&c.step==='review'&&c.role==='read')).toBe(true);
  expect(snap.events.some(e=>e.type==='message'&&e.data.kind==='summary'&&e.data.text.includes('by claude — approved'))).toBe(true);
  expect(snap.session.retryAt).toBeNull();
  expect(snap.events.filter(e=>e.type==='message'&&e.actor==='user')).toHaveLength(1);
  await api.deleteSession(s.id);
 });
 it('keeps a deferred review through restart without rerunning the implementation',async()=>{
  const at=Date.now()+3000;const {s}=await create({until:{claude:at},approve:true},'pair');
  await api.send(s.id,'Build hello');await status(s.id,'completed');const chats=of(s.id).filter(c=>c.step==='chat').length;
  await srv.close();await start();await reviewed(s.id);
  expect(of(s.id).filter(c=>c.step==='chat')).toHaveLength(chats);await api.deleteSession(s.id);
 });
 it('waits when the independent reviewer is still limited instead of repeatedly self-reviewing',async()=>{
  const at=Date.now()+3000;const scenario:Scenario={until:{claude:at+2500},hint:{claude:at},approve:true};const {s}=await create(scenario,'pair');
  await api.send(s.id,'Build hello');await status(s.id,'completed');scenario.hint={claude:at+3500};
  const count=of(s.id).filter(c=>c.agent==='codex'&&c.step==='review').length;
  await reviewed(s.id);
  expect(of(s.id).filter(c=>c.agent==='codex'&&c.step==='review')).toHaveLength(count);
  expect(of(s.id).filter(c=>c.agent==='claude'&&c.step==='review').length).toBeGreaterThanOrEqual(2);
  await api.deleteSession(s.id);
 });
 it('backs off when the provider gives no useful reset time after another rejection',async()=>{
  const at=Date.now()+1200;const {s}=await create({until:{claude:Date.now()+100000,codex:Date.now()+100000},hint:{claude:at,codex:at},unknownAfterFirst:true});
  await api.send(s.id,'Build hello');
  await waitUntil(()=>of(s.id).length>=4,15000);await status(s.id,'failed');
  const next=(await api.session(s.id)).session.retryAt!;
  expect(next-Date.now()).toBeGreaterThan(9*60000);expect(next-Date.now()).toBeLessThan(12*60000);
  await api.deleteSession(s.id);
 });
 it('defers a due job while another session owns the workspace',async()=>{
  const at=Date.now()+400;const {repo,s}=await create({until:{claude:at,codex:at}});await api.send(s.id,'Build hello');await status(s.id,'failed');
  const busy=await create({until:{},hold:true},'solo',repo);await api.send(busy.s.id,'Build hello');
  await waitUntil(()=>of(busy.s.id).length>0);await new Promise(r=>setTimeout(r,1700));
  expect(of(s.id)).toHaveLength(2);
  await api.control(busy.s.id,'cancel');await status(s.id,'completed');
  await api.deleteSession(busy.s.id);await api.deleteSession(s.id);
 });
 it('does not keep retrying a deleted workspace',async()=>{
  const at=Date.now()+1200;const {repo,s}=await create({until:{claude:at,codex:at}});await api.send(s.id,'Build hello');await status(s.id,'failed');
  renameSync(repo,repo+'.moved');
  try{
   await waitUntil(async()=> (await api.session(s.id)).events.some(e=>e.type==='message'&&e.data.text.includes('Automatic continuation stopped')),15000);
   expect(of(s.id)).toHaveLength(2);expect((await api.session(s.id)).session.retryAt).toBeNull();
  }finally{renameSync(repo+'.moved',repo);}
  await api.deleteSession(s.id);
 });
 it.each(['pause','cancel'] as const)('%s also stops a scheduled independent review across restart',async(action)=>{
  const at=Date.now()+3000;const {s}=await create({until:{claude:at},approve:true},'pair');
  await api.send(s.id,'Build hello');await status(s.id,'completed');
  await api.control(s.id,action);const before=of(s.id).length;
  await srv.close();await start();await new Promise(r=>setTimeout(r,4200));
  expect(of(s.id)).toHaveLength(before);expect((await api.session(s.id)).session.retryAt).toBeNull();
  if(action==='pause'){await api.control(s.id,'resume');await reviewed(s.id);}
  await api.deleteSession(s.id);
 });

 it('does not resurrect undone fallback work when the independent reviewer returns',async()=>{
  const at=Date.now()+3000;const {repo,s}=await create({until:{claude:at},approve:true},'pair');
  await api.send(s.id,'Build hello');await status(s.id,'completed');
  await api.undo(s.id);expect(existsSync(join(repo,'hello.js'))).toBe(false);const before=of(s.id).length;
  await srv.close();await start();await new Promise(r=>setTimeout(r,4200));
  expect(of(s.id)).toHaveLength(before);expect(existsSync(join(repo,'hello.js'))).toBe(false);
  expect((await api.session(s.id)).session.retryAt).toBeNull();await api.deleteSession(s.id);
 });

 it('independently reviews separate fallback contributions after the two providers trade roles',async()=>{
  const at=Date.now()+3000;const scenario:Scenario={until:{claude:at},approve:true};const {s}=await create(scenario,'pair');
  await api.send(s.id,'Build hello');await status(s.id,'completed');await api.control(s.id,'pause');
  await new Promise(r=>setTimeout(r,Math.max(0,at-Date.now()+100)));
  scenario.until={codex:Date.now()+3000};scenario.extra=true;
  await api.send(s.id,'Build the next contribution');await api.control(s.id,'resume');await status(s.id,'completed');
  const snap=await reviewed(s.id);
  const independent=snap.events.filter(e=>e.type==='review'&&!e.data.summary.includes('Self-review'));
  expect(new Set(independent.map(e=>e.actor))).toEqual(new Set(['claude','codex']));
  expect(snap.events.filter(e=>e.type==='message'&&e.data.text==='Deferred independent review completed.')).toHaveLength(2);
  await api.deleteSession(s.id);
 });

 it('recovers the full unreviewed fallback scope when upgrading an older completed session',async()=>{
  const at=Date.now()+3000;const {repo,s}=await create({until:{claude:at},approve:true},'pair');
  await api.send(s.id,'Build hello');await status(s.id,'completed');
  const writes=await api.turnChanges(s.id);const first=writes.filter(w=>w.agent==='codex'&&w.files.length).at(-1)!;
  const later=await srv.manager.history.begin(s.id,repo,500,'claude','consulting');
  appendFileSync(join(repo,'README.md'),'\nLater primary-agent changes.\n');await srv.manager.history.finish(s.id,repo,later);
  const event=srv.manager.events.append(s.id,'error','claude',{agent:'claude',code:'rate_limited',message:'Legacy quota failure'});
  srv.manager.db.sql.prepare('UPDATE events SET ts = ? WHERE session_id = ? AND seq = ?').run(first.createdAt-1,s.id,event.seq);
  const state=srv.manager.db.getSessionState<any>(s.id)!;delete state.deferredReview;delete state.independentReviewCompleted;state.selfReviewed=false;state.chatBase=later.before;state.lastWriters={main:'claude'};state.lastDeveloperAgent='claude';
  srv.manager.db.updateSession((await api.session(s.id)).session,state);
  await srv.close();await start();
  await new Promise(r=>setTimeout(r,Math.max(0,at-Date.now()+2300)));
  const snap=await api.session(s.id);
  expect(snap.events.some(e=>e.type==='message'&&e.data.text==='Deferred independent review completed.')).toBe(true);
  expect(of(s.id).find(c=>c.agent==='claude'&&c.step==='review')?.prompt).toMatch(/Live diff:[\s\S]*\nhello\.js\ndiff --git a\/hello\.js b\/hello\.js/);
  await api.deleteSession(s.id);
 });

 it('automatically restores a running fallback after restart even when only one provider was limited',async()=>{
  const scenario:Scenario={until:{claude:Date.now()+100000},hold:true,approve:true};const {s}=await create(scenario,'pair');
  await api.send(s.id,'Build hello');await waitUntil(()=>of(s.id).some(c=>c.agent==='codex'&&c.step==='chat'),15000);
  await srv.close();scenario.hold=false;await start();const snap=await status(s.id,'completed');
  expect(of(s.id).filter(c=>c.agent==='codex'&&c.step==='chat')).toHaveLength(2);
  expect(snap.events.filter(e=>e.type==='message'&&e.actor==='user')).toHaveLength(1);
  await api.deleteSession(s.id);
 });

});
