import { describe, expect, it } from 'vitest';
import { parseChatReply, developerSystemPrompt, consultPrompt } from '../../src/server/prompts.js';

describe('chat verification controls', () => {
  it('removes explicit protocol fences from the visible answer', () => {
    expect(parseChatReply('Updated the guide.\n\n```lina-chat\n{"test":false,"review":false}\n```')).toEqual({ text: 'Updated the guide.', test: false, review: false });
  });
  it('accepts the unfenced control JSON observed in a real Codex writing turn', () => {
    expect(parseChatReply('Implemented add. Tests pass (1 test).\n\n{"test":true,"review":true}', true)).toEqual({ text: 'Implemented add. Tests pass (1 test).', test: true, review: true });
  });
  it('keeps ordinary JSON answers and incomplete or unrelated JSON visible', () => {
    const natural = 'These are the flags:\n\n{"test":true,"review":true}';
    expect(parseChatReply(natural)).toEqual({ text: natural });
    for (const text of ['{"test":true,"review":true}', 'Result:\n\n{"test":true}', 'Result:\n\n{"test":true,"review":true,"note":"example"}', 'Result:\n\n{"test":"false","review":true}']) {
      expect(parseChatReply(text, true)).toEqual({ text });
    }
  });
});


describe('developer Git policy', () => {
  it('allows explicit owner commits in direct projects without automatically committing edits', () => {
    const policy = developerSystemPrompt(true);
    expect(policy).toContain('Git inspection commands');
    expect(policy).toContain('Leave changes uncommitted by default');
    expect(policy).toContain('When the owner explicitly requests a commit');
    expect(policy).toContain('preserve unrelated staged and unstaged work');
    const consult = consultPrompt({text:'Commit the changes',primed:true,role:'developer'});
    expect(consult).toContain('explicitly requested commits in direct projects');
    expect(consult).not.toContain('do not commit');
  });
  it('keeps isolated workspaces under LINA checkpoint control', () => {
    expect(developerSystemPrompt(false)).toContain('Do NOT commit');
    expect(developerSystemPrompt(false)).toContain('LINA checkpoints your changes automatically');
  });
});


describe('peer handoff protocol', () => {
  it('parses a no-edit handoff and keeps control JSON out of the visible reply', () => {
    expect(parseChatReply('Here is the plan.\n```lina-chat\n{"handoff":{"agent":"codex","message":" Review the plan "}}\n```')).toEqual({text:'Here is the plan.',handoff:{agent:'codex',message:'Review the plan'}});
  });
  it('ignores invalid targets or empty messages and does not interpret ordinary JSON as a handoff', () => {
    for (const handoff of [{agent:'unknown',message:'Review'}, {agent:'codex',message:' '}, {agent:'codex',message:42}]) {
      expect(parseChatReply('Plan.\n```lina-chat\n'+JSON.stringify({handoff})+'\n```')).toEqual({text:'Plan.'});
    }
    const text='Example:\n\n{"handoff":{"agent":"codex","message":"Review"}}';
    expect(parseChatReply(text)).toEqual({text});
  });
});
