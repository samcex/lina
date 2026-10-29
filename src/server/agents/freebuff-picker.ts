// Read and operate Freebuff's own model picker. No provider credentials or APIs are bridged.
import xterm from '@xterm/headless';
import {readFileSync,writeFileSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {agentEnv,runProcess} from './proc.js';

export interface FreebuffModelRow {id:string;label:string;description:string;locked:boolean;multimodal:boolean;multiplier?:number}
export const pickerId=(label:string)=>'picker:'+label.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/-$/,'');
export function parsePicker(screen:string):{rows:FreebuffModelRow[];focused?:string}{
 const lines=screen.split('\n');const begin=lines.findIndex(l=>l.includes('choose model')&&l.includes('Enter select'));
 if(begin<0)return {rows:[]};
 const rows:FreebuffModelRow[]=[];let focused:string|undefined;
 for(let i=begin+1;i<lines.length;i++){
  if(!/^\s*┌[─]+┐/.test(lines[i]))continue;
  const body:string[]=[];while(++i<lines.length&&!/^\s*└/.test(lines[i])){
   const m=/^\s*│(.*?)│/.exec(lines[i]);if(m)body.push(m[1].trim());
  }
  if(!body.length)continue;
  const focus=/^[›❯]/.test(body[0]);const first=body[0].replace(/^[›❯]\s*/, '');
  const label=first.split(/[•·]/)[0].trim();
  if(!label||/^(?:more|show|hide|less)\b/i.test(label))continue;
  const description=body.join(' ').replace(/^[›❯]\s*/,'');
  const row:FreebuffModelRow={id:pickerId(label),label,description,locked:/paid plan|\blocked\b|upgrade to/i.test(description),multimodal:/\bimages\b/i.test(description)};
  const price=/\b(\d+(?:\.\d+)?)x\b/i.exec(description);if(price)row.multiplier=Number(price[1]);
  if(focus)focused=row.id;rows.push(row);
 }
 return {rows,focused};
}
export class FreebuffScreen{
 private term=new xterm.Terminal({cols:160,rows:70,allowProposedApi:true});
 feed(text:string){this.term.write(text);}
 text(){return Array.from({length:this.term.rows},(_,i)=>this.term.buffer.active.getLine(i)?.translateToString(true)??'').join('\n');}
 dispose(){this.term.dispose();}
}
const sleep=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms));
let tail:Promise<unknown>=Promise.resolve();
/** Freebuff saves picker preferences globally: serialize LINA turns and restore only our own pick. */
export async function withFreebuffLock<T>(signal:AbortSignal,fn:()=>Promise<T>):Promise<T>{
 let entered=false;
 const work=tail.then(()=>{entered=true;if(signal.aborted)throw new Error('Freebuff operation cancelled');return fn();});
 tail=work.catch(()=>{});
 return new Promise<T>((resolve,reject)=>{
  const abort=()=>{if(!entered)reject(new Error('Freebuff operation cancelled'));};
  signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
  work.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
 });
}
export function preserveModelPreference(root:string):()=>void{
 const path=join(root,'settings.json');const read=()=>{try{return JSON.parse(readFileSync(path,'utf8')) as Record<string,unknown>;}catch{return {};}};
 const keys=['freebuffModel','freebuffModelKey','freebuffReasoningEfforts','freebuffCatalogReasoningEfforts'];
 const before=read();let picked:Record<string,unknown>|undefined;
 const restore=()=>{
  const current=read();if(!picked){picked=current;return;}
  if(keys.some(k=>JSON.stringify(current[k])!==JSON.stringify(picked![k])))return; // preserve a later manual choice
  for(const k of keys)if(k in before)current[k]=before[k];else delete current[k];
  const tmp=`${path}.${process.pid}.lina.tmp`;writeFileSync(tmp,JSON.stringify(current,null,2)+'\n',{mode:0o600});renameSync(tmp,path);
 };
 return restore;
}
export async function operatePicker(screen:FreebuffScreen,write:(s:string)=>unknown,signal:AbortSignal,requested?:string):Promise<FreebuffModelRow[]>{
 const check=()=>{if(signal.aborted)throw new Error('Freebuff model selection cancelled');};
 for(let i=0;i<100&&!screen.text().includes('/model to change');i++){check();await sleep(100);}
 check();write('/model');await sleep(350);write('\r');
 for(let i=0;i<100&&!parsePicker(screen.text()).focused;i++){check();await sleep(100);}
 const found=new Map<string,FreebuffModelRow>();const visited=new Set<string>();
 for(let i=0;i<80;i++){
  check();const parsed=parsePicker(screen.text());for(const row of parsed.rows)found.set(row.id,row);
  if(!parsed.focused){if(process.env.LINA_FREEBUFF_PICKER_DEBUG)writeFileSync(process.env.LINA_FREEBUFF_PICKER_DEBUG,screen.text());break;}
  const selected=found.get(parsed.focused)!;
  if(requested===selected.id){
   if(selected.locked)throw new Error(`Freebuff model ${selected.label} requires a paid plan`);
   write('\r');
   for(let n=0;n<50;n++){check();await sleep(100);const text=screen.text();if(!text.includes('Enter select')&&text.split('\n').some(l=>l.trim().startsWith(selected.label+' ')&&l.includes('/model to change')))return [selected];}
   throw new Error(`Freebuff did not confirm selected model ${selected.label}`);
  }
  if(visited.has(parsed.focused))break;visited.add(parsed.focused);write('\x1b[B');await sleep(160);
 }
 write('\x1b');if(requested)throw new Error(`Freebuff model ${requested} is not currently selectable`);
 return [...found.values()];
}
let cache:{key:string;at:number;rows:FreebuffModelRow[]}|undefined;
export function invalidateFreebuffCatalogue(){cache=undefined;}
export async function freebuffCatalogue(bin:string,cwd:string,root:string,refresh=false):Promise<FreebuffModelRow[]>{
 const key=bin+'\n'+root;
 if(!refresh&&cache?.key===key&&Date.now()-cache.at<600000)return cache.rows;
 const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),25000);
 try{return await withFreebuffLock(AbortSignal.timeout(26000),async()=>{
  const screen=new FreebuffScreen();let write:((s:string)=>unknown)|undefined;
  const quote=(s:string)=>"'"+s.replace(/'/g,"'\\''")+"'";
  const proc=runProcess({cmd:'script',args:['-qfc',`stty cols 160 rows 70; exec ${quote(bin)} --cwd ${quote(cwd)}`,'/dev/null'],cwd,env:agentEnv({TERM:'xterm-256color',FREEBUFF_CONFIG_DIR:root}),signal:controller.signal,turnTimeoutMs:25000,idleTimeoutMs:0,stdinControl:w=>{write=w;},onData:t=>screen.feed(t)});
  void proc.then(()=>controller.abort(),()=>controller.abort());
  try{while(!write&&!controller.signal.aborted)await sleep(50);if(!write)throw new Error('Freebuff did not start');const rows=await operatePicker(screen,write,controller.signal);if(!rows.length)throw new Error('Freebuff did not expose any model rows');cache={key,at:Date.now(),rows};return rows;}
  finally{controller.abort();await proc;screen.dispose();}
 });}finally{clearTimeout(timer);}
}
