import { DELEGATION_TEAM } from '../../src/shared/types.js';
import React from 'react';
import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { render, renderToString } from 'ink';
import { App } from '../../src/cli/tui/App.js';
import { TuiStore, type ClientLike } from '../../src/cli/tui/store.js';
import { applyEvent, viewFromSnapshot } from '../../src/shared/reducer.js';
import { stripAnsi, strWidth } from '../../src/cli/ansi.js';
import { computeLayout } from '../../src/cli/layout.js';
import { footerControls, panelLines, panelUpdate } from '../../src/cli/tui/chrome.js';
import { liveAgentLines } from '../../src/cli/tui/overlays.js';
import { installMouse } from '../../src/cli/tui/mouse.js';
import { parseSlash } from '../../src/cli/slash.js';
import { project, snapshot } from './fixture.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 120));
const detailed = () => {
  const snap=snapshot();
  return applyEvent(viewFromSnapshot(snap),{sessionId:snap.session.id,seq:100,ts:Date.now(),type:'activity',actor:'codex',data:{agent:'codex',id:'visible-command',kind:'command',title:'npm run build',state:'ok',output:'Full output opens on tap\n42 modules transformed\nbuilt in 1.2s',files:['dist/index.js'],source:'observed'}});
};

describe('original appearance with more visible agent work', () => {
  it.each([[24,12],[32,24],[40,20],[56,24],[80,24],[140,40]])('fits %i columns by %i rows', (columns, rows) => {
    const store = new TuiStore({ sessions: async () => [] } as unknown as ClientLike, { view: detailed(), project, live: false });
    try {
      const text = stripAnsi(renderToString(<App store={store} cwd="/tmp" onQuit={() => {}} size={{ columns, rows }} />, { columns }));
      const lines = text.split('\n');
      expect(lines.length).toBeLessThanOrEqual(rows);
      expect(Math.max(...lines.map(strWidth))).toBeLessThanOrEqual(columns);
      expect(text).toContain('◆ LINA');
      expect(text).toContain('╭');
      const layout = computeLayout({ columns, rows, composerLines:1, bannerLines:1, suggestionLines:0 });
      if (layout.compactRowHeight > 0) {expect(text).toContain('Codex');expect(text).toContain('Claude');}
    } finally { store.dispose(); }
  });

  it('shows streamed/latest text, observed commands and output in the original cards', () => {
    const view=detailed();
    const p={agent:'codex' as const,view:view.agents.codex,width:46,frame:0,now:Date.now(),update:panelUpdate(view,'codex')};
    const lines=stripAnsi(panelLines(p,14).join('\n'));
    expect(lines).toContain('Latest response');expect(lines).toContain('Plan');
    expect(lines).toContain('npm run build');expect(lines).toContain('built in 1.2s');
    const writing=panelUpdate(view,'claude');expect(writing?.streaming).toBe(true);
    expect(stripAnsi(panelLines({...p,agent:'claude',view:view.agents.claude,update:writing},9).join('\n'))).toContain('Looking at the diff now');
    for (const width of [20,24,32,40,56])expect(strWidth(footerControls(width,false).text)).toBeLessThanOrEqual(width);
    expect(parseSlash('/menu')).toEqual({type:'menu'});
  });

  it('taps an agent card, expands its command output and returns without losing or sending the draft', async () => {
    let sends=0;
    const view=detailed();
    const client={sessions:async()=>[],send:async()=>{sends++;return {ok:true};}} as unknown as ClientLike;
    const store=new TuiStore(client,{view,project,live:false});
    const frames:string[]=[];
    const stdout=new Writable({write(chunk,_enc,done){frames.push(String(chunk));done();}}) as Writable & {isTTY:boolean;columns:number;rows:number};
    stdout.isTTY=true;stdout.columns=140;stdout.rows=44;
    const stdin=new PassThrough() as PassThrough & {isTTY:boolean;setRawMode:()=>void;ref:()=>void;unref:()=>void};
    stdin.isTTY=true;stdin.setRawMode=()=>{};stdin.ref=()=>{};stdin.unref=()=>{};
    const app=render(<App store={store} cwd="/tmp" onQuit={()=>{}} size={{columns:140,rows:44}}/>,{stdin:stdin as unknown as NodeJS.ReadStream,stdout:stdout as unknown as NodeJS.WriteStream,interactive:true,patchConsole:false,exitOnCtrlC:false});
    const restore=installMouse(stdin as unknown as NodeJS.ReadStream,stdout as unknown as NodeJS.WriteStream);
    const text=()=>stripAnsi(frames.join(''));
    const tap=(x:number,y:number)=>stdin.write(`\x1b[<0;${x};${y}M\x1b[<0;${x};${y}m`);
    try {
      await tick();stdin.write('Keep this draft');await tick();frames.length=0;
      tap(130,5);await tick();
      expect(text()).toContain('◆ Live');expect(text()).toContain('Keep this draft');
      const layout=computeLayout({columns:140,rows:44,composerLines:1,bannerLines:1,suggestionLines:0});
      const h=layout.transcriptHeight-5;
      const block=liveAgentLines(view,'codex',{width:136,frame:0,now:Date.now(),cursor:true,updateRows:Math.max(4,Math.floor(h/3))});
      frames.length=0;tap(12,7+block.items[0].start);await tick();
      expect(text()).toContain('Full output opens on tap');expect(text()).toContain('dist/index.js');
      frames.length=0;tap(135,5);await tick();
      expect(text()).toContain('Keep this draft');expect(text()).toContain('╭');expect(sends).toBe(0);
      // Existing Ctrl+K editing still works when text is present.
      stdin.write('\x01');await tick();stdin.write('\x0b');await tick();
      frames.length=0;stdin.write('Fresh draft');await tick();
      expect(text()).toContain('Fresh draft');expect(text()).not.toContain('Keep this draft');
    } finally {restore();app.unmount();store.dispose();}
  });
});

it.each([[80,24],[140,40]])('shows all three delegation roles at %i columns', (columns,rows)=>{
 const snap=snapshot();snap.session.config={...snap.session.config,mode:'custom',developer:'freebuff',reviewer:'codex',team:DELEGATION_TEAM};
 const store=new TuiStore({sessions:async()=>[]} as unknown as ClientLike,{view:viewFromSnapshot(snap),project,live:false});
 try{
  const text=stripAnsi(renderToString(<App store={store} cwd="/tmp" onQuit={()=>{}} size={{columns,rows}} />,{columns}));
  for(const name of ['Codex','Claude','Freebuff'])expect(text).toContain(name);
  expect(Math.max(...text.split('\n').map(strWidth))).toBeLessThanOrEqual(columns);
  expect(text.split('\n').length).toBeLessThanOrEqual(rows);
 }finally{store.dispose();}
});
