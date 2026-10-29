import {expect,it} from 'vitest';
import {mkdtempSync,writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {parsePicker,pickerId,preserveModelPreference,withFreebuffLock} from '../../src/server/agents/freebuff-picker.js';
import {parseModelDecision} from '../../src/server/model-selection.js';
const screen=` ↑↓ choose model · Tab reasoning · Enter select · Esc cancel
 ┌──────────────────────────────────────────────────────────┐
 │ › Fast Coder • high · Balanced · Images                  │
 │ 1x                                                      │
 └──────────────────────────────────────────────────────────┘
 ┌──────────────────────────────────────────────────────────┐
 │   Frontier · Strong reasoning                            │
 │ Paid plan                                               │
 └──────────────────────────────────────────────────────────┘`;
it('reads names, actual picker cost, image support and locked rows',()=>{
 const parsed=parsePicker(screen);expect(parsed.focused).toBe('picker:fast-coder');
 expect(parsed.rows[0]).toMatchObject({id:'picker:fast-coder',multiplier:1,multimodal:true,locked:false});expect(parsed.rows[1].locked).toBe(true);
 expect(parsePicker('Unrelated screen').rows).toEqual([]);
});
it('rejects invented models, locked models and missing rationale',()=>{
 const rows=parsePicker(screen).rows;
 const choice=(model:string,reason='Suitable for this small UI fix')=>'```lina-model\n'+JSON.stringify({model,reason})+'\n```';
 expect(parseModelDecision(choice('picker:fast-coder'),rows)?.model).toBe('picker:fast-coder');
 for(const model of ['invented','picker:frontier'])expect(parseModelDecision(choice(model),rows)).toBeUndefined();
 expect(parseModelDecision(choice('picker:fast-coder',''),rows)).toBeUndefined();
});
it('restores the prior model without reverting other settings or a later manual model choice',()=>{
 const root=mkdtempSync(join(tmpdir(),'picker-settings-'));const path=join(root,'settings.json');
 const save=(x:unknown)=>writeFileSync(path,JSON.stringify(x));const read=()=>JSON.parse(readFileSync(path,'utf8'));
 save({freebuffModel:'original',theme:'dark'});const restore=preserveModelPreference(root);
 save({freebuffModel:'chosen',theme:'dark'});restore();save({freebuffModel:'chosen',theme:'light'});restore();expect(read()).toEqual({freebuffModel:'original',theme:'light'});
 const next=preserveModelPreference(root);save({freebuffModel:'chosen',theme:'light'});next();save({freebuffModel:'manual',theme:'light'});next();expect(read().freebuffModel).toBe('manual');
});
it('serializes Freebuff sessions so one task cannot change another task model',async()=>{
 const calls:string[]=[];const c=new AbortController();
 const first=withFreebuffLock(c.signal,async()=>{calls.push('start');await new Promise(r=>setTimeout(r,30));calls.push('end');});
 const second=withFreebuffLock(c.signal,async()=>{calls.push('second');});await Promise.all([first,second]);expect(calls).toEqual(['start','end','second']);
});
it('does not release the model lock until a cancelled active turn finishes cleanup',async()=>{
 const c=new AbortController(),next=new AbortController();const calls:string[]=[];
 const first=withFreebuffLock(c.signal,async()=>{calls.push('active');await new Promise(r=>setTimeout(r,35));calls.push('cleaned');});
 await new Promise(r=>setTimeout(r,5));c.abort();
 const second=withFreebuffLock(next.signal,async()=>{calls.push('next');});
 await Promise.all([first,second]);expect(calls).toEqual(['active','cleaned','next']);
});
