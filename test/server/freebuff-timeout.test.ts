import {beforeAll,afterAll,expect,it} from 'vitest';
import {writeFileSync,readFileSync} from 'node:fs';import {join} from 'node:path';
import {setupEnv,makeRepo,waitUntil} from './helpers.js';
import type {AgentId} from '../../src/shared/types.js';
setupEnv();
const {startServer}=await import('../../src/server/daemon.js');
const {LinaClient}=await import('../../src/shared/client.js');
const {MockAdapter}=await import('../../src/server/agents/mock.js');
const {setAdapterOverride}=await import('../../src/server/agents/index.js');
const attempts=new Map<string,number>();const repeats=new Set<string>();const stops=new Map<string,'pause'|'cancel'>();
const calls:{id:string;agent:AgentId;resume?:string;prompt:string}[]=[];
let srv:Awaited<ReturnType<typeof startServer>>,api:InstanceType<typeof LinaClient>;
async function boot(){srv=await startServer({port:0});api=new LinaClient({baseUrl:`http://127.0.0.1:${srv.port}`,token:srv.token});}
setAdapterOverride((agent,ctx)=>({id:agent,async runTurn(opts,emit){
 const id=ctx.sessionId!,step=/lina:step=(\w+)/.exec(opts.prompt)?.[1];
 if(step==='implement'){
  calls.push({id,agent,resume:opts.resumeId,prompt:opts.prompt});
  if(agent==='freebuff'){
   const n=(attempts.get(id)??0)+1;attempts.set(id,n);
   if(n===1||repeats.has(id)){
    writeFileSync(join(opts.cwd,'partial.txt'),'Saved progress; validation still pending.');
    const stop=stops.get(id);if(stop)void api.control(id,stop);
    if(stop)await new Promise(r=>setTimeout(r,50));
    return {ok:false,text:'Partial implementation; inspect the existing build log.',providerSessionId:'saved-freebuff-chat',durationMs:opts.turnTimeoutMs,usage:{},error:{code:'timeout',message:'Configured turn time limit reached'}};
   }
   expect(opts.resumeId).toBe('saved-freebuff-chat');expect(readFileSync(join(opts.cwd,'partial.txt'),'utf8')).toContain('Saved progress');
  }
 }
 return new MockAdapter(agent,{delayMs:0}).runTurn(opts,emit);
}}));
beforeAll(boot);afterAll(async()=>{await srv.close();});
async function create(){const p=await api.addProject({path:makeRepo()});return api.createSession({projectId:p.id,config:{mock:true,mode:'custom',team:{planner:null,planCritic:null,developer:'freebuff',reviewers:['codex','claude']},interactionMode:'workflow',goal:'Build hello',models:{freebuff:{model:'pinned'}} as any}});}
const done=(id:string)=>waitUntil(()=>srv.manager.db.getSession(id)?.status==='completed',15000);
it('continues the same Freebuff conversation after a full time slice without fallback',async()=>{
 const s=await create();await api.send(s.id,'Build hello');await done(s.id);
 expect(calls.filter(c=>c.id===s.id).map(c=>c.agent)).toEqual(['freebuff','freebuff']);
 expect(calls.filter(c=>c.id===s.id)[1].prompt).toContain('existing background builds');
 expect(srv.manager.db.getSessionState<any>(s.id)!.freebuffTimeSlices).toBeUndefined();
});
it('persists the same-provider continuation across daemon restart without owner input',async()=>{
 const s=await create();await api.send(s.id,'Build hello');await waitUntil(()=>!!srv.manager.db.getSessionState<any>(s.id)!.goalResumePending,15000);
 await srv.close();await boot();await done(s.id);
 expect(calls.filter(c=>c.id===s.id).map(c=>c.agent)).toEqual(['freebuff','freebuff']);
});
it.each(['pause','cancel'] as const)('honors owner %s instead of starting a timeout continuation or fallback',async action=>{
 const s=await create();stops.set(s.id,action);await api.send(s.id,'Build hello');
 await waitUntil(()=>srv.manager.db.getSession(s.id)?.status===(action==='pause'?'paused':'cancelled'),15000);
 await new Promise(r=>setTimeout(r,1200));expect(calls.filter(c=>c.id===s.id)).toHaveLength(1);
});
it('bounds repeated time slices and falls back after two continuations',async()=>{
 const s=await create();repeats.add(s.id);await api.send(s.id,'Build hello');await done(s.id);
 expect(calls.filter(c=>c.id===s.id).map(c=>c.agent)).toEqual(['freebuff','freebuff','freebuff','codex']);
});
