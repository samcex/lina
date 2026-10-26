import {expect,it} from 'vitest';
import {parseGoalAudit} from '../../src/server/goal-audit.js';
import type {GoalRequirement} from '../../src/shared/types.js';
const previous:GoalRequirement[]=[{key:'behavior',requirement:'Implement the requested behavior',status:'remaining',evidence:'Implementation is missing',next:'Implement and test it'}];
const block=(requirements:unknown)=>'```lina-goal-audit\n'+JSON.stringify({requirements})+'\n```';
it('retains explicit requirement wording and observed completion evidence',()=>{
 expect(parseGoalAudit(block([{...previous[0],status:'verified',evidence:'src/feature.ts and node --test: 3 passed'}]),previous)[0]).toEqual({key:'behavior',requirement:previous[0].requirement,status:'verified',evidence:'src/feature.ts and node --test: 3 passed'});
});
it.each([
 [],
 [{...previous[0],key:'easier-substitute'}],
 [{...previous[0],requirement:'A narrower task'}],
 [{...previous[0],status:'verified',evidence:''}],
 [{...previous[0],next:''}],
 [{...previous[0],status:'blocked',kind:'permission'}],
 [previous[0],previous[0]],
].map(requirements=>({requirements})))('rejects missing, silently narrowed or unproven requirements: %j',({requirements})=>{
 expect(()=>parseGoalAudit(block(requirements),previous)).toThrow();
});
it('rejects ambiguous multiple audit blocks',()=>expect(()=>parseGoalAudit(block(previous)+block(previous),previous)).toThrow());
