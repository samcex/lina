import { expect, it } from 'vitest';
import { parseGoalQueue, deferredIssues } from '../../src/server/goal-queue.js';
const previous = [{ key:'packaging',reason:'Await trace',retryAt:1000,attempts:1 }];
const block = (d: unknown) => '```lina-goal-queue\n'+JSON.stringify(d)+'\n```';
const waiting = [{key:'packaging',reason:'Await an actionable trace.'}];
it('retains a deferred issue while selecting concrete other work',()=>{
  const d=parseGoalQueue(block({next:{key:'feature',task:'Finish the requested feature.',evidence:'docs/approved-plan.md'},waiting,resolved:[],complete:false}),previous);
  expect(d.next?.key).toBe('feature');
  expect(deferredIssues(d,previous,5000)).toEqual([{...waiting[0],kind:'evidence',attempts:2,retryAt:5000+30*60000}]);
});
it.each([
  {next:{key:'feature',task:'Work',evidence:'Goal'},waiting:[],resolved:[],complete:false},
  {next:null,waiting,resolved:[],complete:true},
  {next:{key:'packaging',task:'Retry the same waiting issue',evidence:'Goal'},waiting,resolved:[],complete:false},
  {next:null,waiting:[],resolved:[{key:'packaging',evidence:''}],complete:true},
])('rejects dropped issues, premature completion and contradictory work',d=>{
  expect(()=>parseGoalQueue(block(d),previous)).toThrow();
});
it('requires explicit resolution evidence before completing a goal with deferred work',()=>{
  const d=parseGoalQueue(block({next:null,waiting:[],resolved:[{key:'packaging',evidence:'The underlying defect is reproduced, fixed and its regression test passes.'}],complete:true}),previous);
  expect(d.complete).toBe(true);expect(deferredIssues(d,previous,5000)).toEqual([]);
});
it('preserves a missing owner fact across queue reassessment rather than converting it into a timer',()=>{
  const pending=[{...previous[0],kind:'owner' as const}];
  const d=parseGoalQueue(block({next:null,waiting,resolved:[],complete:false}),pending);
  expect(deferredIssues(d,pending,5000)[0].kind).toBe('owner');
});
it('promotes a deferred issue when evidence arrives and retains it pending verified resolution',()=>{
  const d=parseGoalQueue(block({next:{key:'packaging',task:'Fix the captured exception.',evidence:'A new actionable stack trace is retained.'},waiting:[],resolved:[],complete:false}),previous);
  expect(deferredIssues(d,previous,5000)).toEqual([{...previous[0],active:true}]);
  expect(()=>parseGoalQueue(block({next:null,waiting:[],resolved:[],complete:true}),deferredIssues(d,previous,5000))).toThrow();
});
