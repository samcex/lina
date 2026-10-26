import type { GoalRequirement } from '../shared/types.js';

/** Completion requires an explicit evidence ledger; previous requirements cannot disappear. */
export function parseGoalAudit(text: string, previous: GoalRequirement[]): GoalRequirement[] {
  const blocks=[...text.matchAll(/```lina-goal-audit\s*\n([\s\S]*?)```/g)];
  if(blocks.length!==1)throw new Error('Expected exactly one goal audit');
  const requirements=JSON.parse(blocks[0][1])?.requirements;
  const textValue=(s:unknown,max:number)=>typeof s==='string'&&!!s.trim()&&s.length<=max;
  if(!Array.isArray(requirements)||!requirements.length||requirements.length>64)throw new Error('Audit needs the full requirement list');
  for(const r of requirements) {
    if(!r||!textValue(r.key,80)||!/^[a-z0-9][a-z0-9_-]*$/.test(r.key)||!textValue(r.requirement,4000)||!textValue(r.evidence,8000)||!['verified','remaining','blocked'].includes(r.status))throw new Error('Invalid requirement evidence');
    if(r.status==='remaining'&&!textValue(r.next,8000))throw new Error('Remaining work needs a concrete next action');
    if(r.status==='blocked'&&!['owner','evidence'].includes(r.kind))throw new Error('Blocked requirement needs an actual dependency kind');
  }
  const keys=requirements.map(r=>r.key);
  if(new Set(keys).size!==keys.length||previous.some(r=>!keys.includes(r.key)))throw new Error('Requirements were duplicated or silently dropped');
  // Stable keys preserve the owner's original requirement, including after retries.
  if(previous.some(p=>requirements.find(r=>r.key===p.key)?.requirement!==p.requirement))throw new Error('A saved requirement was redefined');
  return requirements.map(({key,requirement,status,evidence,next,kind})=>({key,requirement,status,evidence,...(status==='remaining'?{next}:{}),...(status==='blocked'?{kind}:{})}));
}
