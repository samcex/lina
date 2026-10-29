import { expect, it } from 'vitest';
import { agentDisplayText } from '../../src/shared/agent-display.js';
import { renderEvent, renderStream } from '../../src/cli/transcript.js';
import { stripAnsi } from '../../src/cli/ansi.js';
import { panelUpdate } from '../../src/cli/tui/chrome.js';
import { viewFromSnapshot } from '../../src/shared/reducer.js';
import { snapshot } from './fixture.js';
import type { LinaEvent } from '../../src/shared/types.js';

const review='```lina-review\n'+JSON.stringify({verdict:'approve',summary:'Plan is viable; implementation remains unreviewed.',findings:[],resolved:[],withdrawn:[]})+'\n```';
it('presents the screenshot review as readable approval and preserves its implementation caveat',()=>{
  const text=agentDisplayText('Self-review only.\n\n'+review);
  expect(text).toContain('Review: Approved');expect(text).toContain('implementation remains unreviewed');expect(text).toContain('Self-review only.');
  expect(text).not.toContain('lina-review');expect(text).not.toContain('"verdict"');
});
it('retains findings from JSON-only reviews rather than hiding the review content',()=>{
  const text=agentDisplayText('```lina-review\n{"verdict":"request_changes","summary":"Fix validation","findings":[{"title":"Missing ownership guard","detail":"Recheck before sending."}]}\n```');
  expect(text).toContain('Changes requested');expect(text).toContain('Missing ownership guard');expect(text).toContain('Recheck before sending.');
});
it.each(['~~~ LINA-REVIEW\n{"verdict":"approve","summary":"Plan only."}\n~~~','```` lina-review\n{"verdict":"approve","summary":"Plan only."}\n````'])('handles accepted fence variants: %s',text=>{
  expect(agentDisplayText(text)).toContain('Review: Approved');expect(agentDisplayText(text)).not.toContain('verdict');
});
it.each(['```lina-rev','```lina-review\n{"verdict":','```lina-review\n{"verdict":"approve"}\n```'])('never leaks a partially streamed control block: %s',block=>{
  expect(agentDisplayText('Checking the plan.\n'+block,true)).toBe('Checking the plan.');
  expect(stripAnsi(renderStream({agent:'codex',text:'Checking the plan.\n'+block},70,false).join('\n'))).not.toContain('lina-rev');
});
it('keeps normal code blocks and strips other internal coordination blocks',()=>{
  const code='```json\n{"example":true}\n```';
  expect(agentDisplayText(code)).toBe(code);
  expect(agentDisplayText('Ready.\n```lina-chat\n{"review":true}\n```')).toBe('Ready.');
  expect(agentDisplayText('Rechecking.\n```lina-goal-queue\n{"next":null}\n```')).toBe('Rechecking.');
});
it('cleans saved agent messages in the terminal without changing owner messages or the event data',()=>{
  const e:LinaEvent<'message'>={sessionId:'saved',seq:1,ts:0,type:'message',actor:'codex',data:{id:'review',text:review,kind:'review',role:'reviewer'}};
  const rendered=stripAnsi(renderEvent(e,70).join('\n'));
  expect(rendered).toContain('Review: Approved');expect(rendered).not.toContain('lina-review');expect(e.data.text).toBe(review);
  expect(stripAnsi(renderEvent({...e,actor:'user'},70).join('\n'))).toContain('lina-review');
});
it('keeps raw internal blocks out of live agent panels',()=>{
  const v=viewFromSnapshot(snapshot());v.streams={control:{agent:'codex',text:'Checking.\n```lina-review\n{"verdict":'}};
  expect(panelUpdate(v,'codex')?.text).toBe('Checking.');
});

it('hides model-selection control blocks while keeping the readable rationale',()=>{
 const text='Choose a fast model for this small edit.\n```lina-model\n{"model":"picker:fast","reason":"small edit"}\n```';
 expect(agentDisplayText(text)).toBe('Choose a fast model for this small edit.');
 expect(agentDisplayText('Choosing.\n```lina-mo',true)).toBe('Choosing.');
});
