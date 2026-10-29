import type {FreebuffModelRow} from './agents/freebuff-picker.js';
export interface ModelDecision {model:string;reason:string}
/** Only an actually listed, unlocked model can be selected. Never accept a provider-invented ID. */
export function parseModelDecision(text:string,rows:FreebuffModelRow[]):ModelDecision|undefined{
 const match=/```lina-model\s*\n([\s\S]*?)```/i.exec(text);if(!match)return;
 try{const x=JSON.parse(match[1]);if(typeof x.model!=='string'||typeof x.reason!=='string'||!x.reason.trim()||x.reason.length>2000)return;
 if(!rows.some(r=>r.id===x.model&&!r.locked))return;
 return {model:x.model,reason:x.reason.trim()};}catch{return;}
}
export function modelSelectionPrompt(task:string,rows:FreebuffModelRow[],proposal?:ModelDecision):string{
 return `Choose the Freebuff model capable of this delegated task. This is model selection only: do not edit project files, run builds, or implement the task.\nTask and accepted plan:\n${task}\n\nObserved Freebuff picker catalogue (provider descriptions, availability, image support and hour multipliers when displayed; unknown costs/capabilities are not guarantees):\n${JSON.stringify(rows.filter(r=>!r.locked))}\n\n${proposal?`Independently review this proposal; confirm it or choose a better listed model: ${JSON.stringify(proposal)}.`:'Select the least costly model that reasonably meets the task requirements; use a stronger model for difficult reasoning, broad changes or unresolved failures, and require image support when the task needs images.'}\nDo not invent benchmark results, models or capabilities. Never choose locked or unlisted models or suggest upgrading an account. Explain task suitability and tradeoffs using the observed descriptions. End with exactly one control block:\n\`\`\`lina-model\n{"model":"<exact catalogue id>","reason":"<task-specific rationale>"}\n\`\`\``;
}
