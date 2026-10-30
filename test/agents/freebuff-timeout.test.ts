import {expect,it,vi,afterAll} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
const fixture=vi.hoisted(()=>({dir:'',timedOut:'turn' as 'turn'|null}));
vi.mock('../../src/server/agents/proc.js',async importActual=>({
 ...await importActual<typeof import('../../src/server/agents/proc.js')>(),which:async()=>'/fake/freebuff',
 runProcess:async(opts:any)=>{
  opts.stdinControl(()=>true);opts.onLine('Enter a coding task');
  writeFileSync(join(fixture.dir,'chat-messages.json'),JSON.stringify([{id:'u',variant:'user',content:'task'},{id:'a',variant:'ai',isComplete:true,blocks:[{type:'text',content:'[response interrupted]'}]}]));
  return {exitCode:0,signal:null,timedOut:fixture.timedOut,aborted:false,stderrTail:''};
 }
}));
import {FreebuffAdapter} from '../../src/server/agents/freebuff.js';
const root=mkdtempSync(join(tmpdir(),'freebuff-timeout-')),old=process.env.FREEBUFF_CONFIG_DIR;
process.env.FREEBUFF_CONFIG_DIR=root;fixture.dir=join(root,'projects','test','chats','saved');mkdirSync(fixture.dir,{recursive:true});
afterAll(()=>{if(old===undefined)delete process.env.FREEBUFF_CONFIG_DIR;else process.env.FREEBUFF_CONFIG_DIR=old;rmSync(root,{recursive:true,force:true});});
it.each(['turn',null] as const)('uses process timeout %s rather than shutdown transcript to classify interruption',async timedOut=>{
 fixture.timedOut=timedOut;writeFileSync(join(fixture.dir,'chat-messages.json'),'[]');
 const result=await new FreebuffAdapter().runTurn({cwd:root,resumeId:'saved',prompt:'task',model:'auto',access:'write',network:false,signal:new AbortController().signal,turnTimeoutMs:10000,idleTimeoutMs:10000},()=>{});
 expect(result.ok).toBe(false);if(timedOut){expect(result.error?.code).toBe('timeout');expect(result.error?.message).toContain('time limit');}else expect(result.error?.message).toContain('interrupted');
});
