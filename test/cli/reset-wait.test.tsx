import React from 'react';
import {renderToString} from 'ink';
import {describe,it,expect} from 'vitest';
import {App} from '../../src/cli/tui/App.js';
import {TuiStore,type ClientLike} from '../../src/cli/tui/store.js';
import {viewFromSnapshot} from '../../src/shared/reducer.js';
import {stripAnsi} from '../../src/cli/ansi.js';
import {project,snapshot} from './fixture.js';
describe('automatic reset wait status',()=>{
 it.each(['complete','waiting-review'] as const)('distinguishes %s goals from waiting for owner input',goalStatus=>{
  const snap=snapshot();snap.session={...snap.session,status:'completed',phase:'completed',config:{...snap.session.config,goal:'Build hello'},goalStatus,retryAt:goalStatus==='waiting-review'?Date.now()+3600000:null};
  const store=new TuiStore({} as ClientLike,{project,view:viewFromSnapshot(snap),live:false});
  try{
   const text=stripAnsi(renderToString(<App store={store} cwd="/tmp" onQuit={()=>{}} size={{columns:160,rows:30}}/>,{columns:160}));
   expect(text).toContain(goalStatus==='complete'?'Goal complete':'Independent review pending');
   expect(text).toContain(goalStatus==='complete'?'no further input needed':'continues automatically');
  }finally{store.dispose();}
 });
 it('shows the retry time and stop action for quota waits',()=>{
  const snap=snapshot();snap.session={...snap.session,status:'failed',phase:'failed',retryAt:Date.now()+3600000};
  const store=new TuiStore({} as ClientLike,{project,view:viewFromSnapshot(snap),live:false});
  try{
   const text=stripAnsi(renderToString(<App store={store} cwd="/tmp" onQuit={()=>{}} size={{columns:140,rows:30}}/>,{columns:140}));
   expect(text).toContain('Waiting for usage reset');expect(text).toContain('automatic retry');expect(text).toContain('/pause stops retry');
  }finally{store.dispose();}
 });
});
