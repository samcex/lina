import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import {makeRepo,setupEnv,waitUntil} from './helpers.js';
setupEnv();
const {startServer}=await import('../../src/server/daemon.js');
const {LinaClient}=await import('../../src/shared/client.js');
const {MockAdapter}=await import('../../src/server/agents/mock.js');
const {setAdapterOverride}=await import('../../src/server/agents/index.js');
const git=await import('../../src/server/git.js');
let failingPath:string|undefined;
const originalHead=git.headCommit;
const head=vi.spyOn(git,'headCommit').mockImplementation(async cwd=>{
 if(cwd===failingPath){failingPath=undefined;throw new Error('Injected runner failure before tests');}
 return originalHead(cwd);
});
setAdapterOverride(agent=>({id:agent,async runTurn(opts,emit){
 const result=await new MockAdapter(agent,{delayMs:0}).runTurn(opts,emit);
 if(opts.prompt.includes('lina:step=implement ')&&!opts.prompt.includes('Injected runner failure'))failingPath=opts.cwd;
 return result;
}}));
let srv:Awaited<ReturnType<typeof startServer>>;let api:InstanceType<typeof LinaClient>;
async function start(){srv=await startServer({port:0});api=new LinaClient({baseUrl:`http://127.0.0.1:${srv.port}`,token:srv.token});}
beforeAll(start);afterAll(async()=>{head.mockRestore();await srv.close();});
it('restores an automatic unexpected-runner recovery after restart without opening the session',async()=>{
 const project=await api.addProject({path:makeRepo()});
 const s=await api.createSession({projectId:project.id,config:{mock:true,mode:'architect',interactionMode:'workflow',goal:'Build hello'}});
 await api.send(s.id,'Build hello');
 await waitUntil(()=>srv.manager.db.getSession(s.id)?.status==='failed',15000);
 const state=srv.manager.db.getSessionState<any>(s.id)!;
 expect(state.goalRetryAt).toBeGreaterThan(Date.now());expect(state.goalRecoveryContext).toContain('Injected runner failure');
 expect(state.automaticDisabled).not.toBe(true);
 state.goalRetryAt=Date.now()+200;srv.manager.db.updateSession(srv.manager.db.getSession(s.id)!,state);
 await srv.close();await start();
 await waitUntil(()=>srv.manager.db.getSession(s.id)?.status==='completed',15000);
 const snap=await api.session(s.id);
 expect(snap.session.goalStatus).toBe('complete');expect(snap.session.goalRequirements?.every(r=>r.status==='verified')).toBe(true);
 expect(snap.events.filter(e=>e.type==='message'&&e.actor==='user')).toHaveLength(1);
});
