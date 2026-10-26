// Disposable process acceptance fixture. Never used by the installed daemon.
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
const {startServer}=await import('../src/server/daemon.ts');
const {setAdapterOverride}=await import('../src/server/agents/index.ts');
const {MockAdapter}=await import('../src/server/agents/mock.ts');
setAdapterOverride(agent=>({id:agent,async runTurn(opts,onEvent){
 if(process.env.QA_FAIL==='1'&&opts.prompt.includes('lina:step=implement ')) {
  writeFileSync(join(opts.cwd,`partial-${agent}.txt`),'Preserved partial work.\n');
  return {ok:false,text:'Partial work retained.',usage:{},durationMs:0,error:{code:agent==='codex'?'timeout':'crashed',message:'Injected provider transport failure'}};
 }
 return new MockAdapter(agent,{delayMs:0,holdMs:process.env.QA_HOLD_AUDIT==='1'?{goal_completion_audit:60000}:undefined}).runTurn(opts,onEvent);
}}));
const srv=await startServer({port:0});
writeFileSync(process.env.QA_INFO,JSON.stringify({port:srv.port,token:srv.token}),{mode:0o600});
let closing=false;
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,async()=>{if(closing)return;closing=true;await srv.close();process.exit(0);});
