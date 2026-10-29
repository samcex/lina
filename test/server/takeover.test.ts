import {beforeAll,afterAll,expect,it} from 'vitest';
import {writeFileSync,readFileSync} from 'node:fs';import {join} from 'node:path';
import {setupEnv,makeRepo,waitUntil} from './helpers.js';
import type {AgentId} from '../../src/shared/types.js';
setupEnv();
const {startServer}=await import('../../src/server/daemon.js');
const {LinaClient}=await import('../../src/shared/client.js');
const {MockAdapter}=await import('../../src/server/agents/mock.js');
const {setAdapterOverride}=await import('../../src/server/agents/index.js');
const calls:{id:string;agent:AgentId;step:string;access:string;prompt:string}[]=[];
const holds=new Map<string,{entered:boolean;release?:()=>void}>();
const limited=new Map<string,number>();
setAdapterOverride((agent,ctx)=>({id:agent,async runTurn(opts,emit){
 const id=ctx.sessionId!,step=/lina:step=(\w+)/.exec(opts.prompt)?.[1]??'';
 calls.push({id,agent,step,access:opts.access,prompt:opts.prompt});
 if((limited.get(id)??0)>Date.now())return {ok:false,text:'',usage:{},durationMs:0,error:{code:'rate_limited',message:'Real fixture quota is still active',retryAt:limited.get(id)}};
 const hold=holds.get(id);
 if(hold&&!hold.entered&&step==='implement'){
  hold.entered=true;writeFileSync(join(opts.cwd,'handoff.txt'),'Existing partial work must survive.');
  await new Promise<void>(resolve=>{hold.release=resolve;opts.signal.addEventListener('abort',()=>resolve(),{once:true});});
  if(opts.signal.aborted)return {ok:false,text:'Partial work retained.',usage:{},durationMs:0,error:{code:'cancelled',message:'Stopped by owner or daemon'}};
 }
 return new MockAdapter(agent,{delayMs:0}).runTurn(opts,emit);
}}));
let srv:Awaited<ReturnType<typeof startServer>>,api:InstanceType<typeof LinaClient>;
async function boot(){srv=await startServer({port:0});api=new LinaClient({baseUrl:`http://127.0.0.1:${srv.port}`,token:srv.token});}
beforeAll(boot);afterAll(async()=>{await srv.close();});
async function create(developer:AgentId='claude'){
 const project=await api.addProject({path:makeRepo()});
 return api.createSession({projectId:project.id,config:{mock:true,mode:'pair',workspaceMode:'direct',interactionMode:'workflow',developer,reviewer:developer==='claude'?'codex':'claude'}});
}
async function status(id:string,value:string){await waitUntil(()=>srv.manager.db.getSession(id)?.status===value,15000);return api.session(id);}
async function held(){const s=await create();holds.set(s.id,{entered:false});await api.send(s.id,'Build hello');await waitUntil(()=>!!holds.get(s.id)?.entered,15000);return s;}
const writes=(id:string,agent:AgentId)=>calls.filter(c=>c.id===id&&c.agent===agent&&c.step==='implement'&&c.access==='write');
it('transfers a running task at a turn boundary, preserving partial files and original objective',async()=>{
 const s=await held();const reply=await api.send(s.id,'@freebuff take over');expect(reply).toMatchObject({takeover:'freebuff',queued:true});
 expect((await api.session(s.id)).session.config.developer).toBe('claude');expect(writes(s.id,'freebuff')).toHaveLength(0);
 holds.get(s.id)!.release!();const snap=await status(s.id,'completed');
 expect(snap.session.config.developer).toBe('freebuff');expect(new Set(snap.session.config.team!.reviewers)).toEqual(new Set(['codex','claude']));
 expect(srv.manager.db.getSessionState<any>(s.id)!.task).toBe('Build hello');
 expect(readFileSync(join(s.workspacePath,'handoff.txt'),'utf8')).toBe('Existing partial work must survive.');
 expect(writes(s.id,'freebuff')[0].prompt).toContain('Owner-requested takeover');
 expect(calls.some(c=>c.id===s.id&&c.step==='consult')).toBe(false);
});
it.each(['codex','claude','freebuff'] as const)('%s can take over a cancelled task without a separate resume',async agent=>{
 const s=await held();await api.control(s.id,'cancel');await status(s.id,'cancelled');
 const reply=await api.send(s.id,`@${agent} take over`);expect(reply.takeover).toBe(agent);
 const snap=await status(s.id,'completed');expect(snap.session.config.developer).toBe(agent);expect(writes(s.id,agent).length).toBeGreaterThan(0);
 expect(readFileSync(join(s.workspacePath,'handoff.txt'),'utf8')).toContain('Existing partial work');
});
it('restores a pending takeover after restart without opening the session',async()=>{
 const s=await held();await api.send(s.id,'@freebuff take over the work');
 await srv.close();await boot();await waitUntil(()=>srv.manager.db.getSession(s.id)?.status==='completed',15000);
 expect(srv.manager.db.getSession(s.id)!.config.developer).toBe('freebuff');expect(writes(s.id,'freebuff').length).toBeGreaterThan(0);
});
it.each(['pause','cancel'] as const)('a later %s wins over an earlier takeover across restart',async action=>{
 const s=await held();await api.send(s.id,'@freebuff take over');
 if(action==='pause'){await api.control(s.id,'pause');holds.get(s.id)!.release!();await status(s.id,'paused');}
 else{await api.control(s.id,'cancel');await status(s.id,'cancelled');}
 await srv.close();await boot();await new Promise(r=>setTimeout(r,250));
 expect(writes(s.id,'freebuff')).toHaveLength(0);expect(srv.manager.db.getSession(s.id)!.status).toBe(action==='pause'?'paused':'cancelled');
 if(action==='pause'){await api.control(s.id,'resume');await status(s.id,'completed');expect(writes(s.id,'freebuff').length).toBeGreaterThan(0);}
});
it('does not erase genuine quota limits when requesting takeover from a failed task',async()=>{
 const s=await create();limited.set(s.id,Date.now()+2200);await api.send(s.id,'Build hello');await status(s.id,'failed');
 const until=limited.get(s.id)!;await api.send(s.id,'@codex take over');
 await new Promise(r=>setTimeout(r,150));expect(writes(s.id,'codex')).toHaveLength(0);
 expect(srv.manager.db.getSessionState<any>(s.id)!.providerLimits.codex.until).toBe(until);
 const snap=await status(s.id,'completed');expect(snap.session.config.developer).toBe('codex');
});
it('rejects an empty takeover instead of creating a task literally named take over',async()=>{
 const s=await create();await expect(api.send(s.id,'@freebuff take over')).rejects.toThrow('no current task');
 expect(srv.manager.db.getSessionState<any>(s.id)!.task).toBeUndefined();
});

it('continues a paused task immediately and preserves the full persistent goal',async()=>{
 const s=await create();const objective='Build hello';await api.updateSession(s.id,{config:{goal:objective}});
 holds.set(s.id,{entered:false});await api.send(s.id,objective);await waitUntil(()=>!!holds.get(s.id)?.entered,15000);
 await api.control(s.id,'pause');holds.get(s.id)!.release!();await status(s.id,'paused');
 const response=await api.send(s.id,'@freebuff take over');expect(response).toMatchObject({takeover:'freebuff',queued:false});
 const snap=await status(s.id,'completed');expect(snap.session.config.goal).toBe(objective);expect(snap.session.goalStatus).toBe('complete');
 expect(srv.manager.db.getSessionState<any>(s.id)!.task).toBe(objective);
});
it('includes bounded Freebuff handoff reports in the other agents shared context',async()=>{
 const s=await create();
 srv.manager.events.append(s.id,'message','freebuff',{id:'report',kind:'chat',text:'Implemented the partial module; next verify the error case.'});
 for(let i=0;i<8;i++)srv.manager.events.append(s.id,'message','codex',{id:'report-'+i,kind:'chat',text:'Codex follow-up '+i});
 const context=srv.manager.db.recentConversation(s.id,'claude');
 expect(context.some(m=>m.agent==='freebuff'&&m.text.includes('partial module'))).toBe(true);
 expect(context.filter(m=>m.agent==='codex')).toHaveLength(2);
});
it('keeps ordinary agent questions as consultations rather than takeover commands',async()=>{
 const s=await create();await api.send(s.id,'@freebuff Explain how takeover works');await status(s.id,'idle');
 expect((await api.session(s.id)).session.config.developer).toBe('claude');
 expect(calls.some(c=>c.id===s.id&&c.step==='consult')).toBe(true);
});
