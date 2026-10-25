import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildClaudeArgs, claudePrompt, createClaudeParser, mapClaudeRateLimit } from '../../src/server/agents/claude.js';
import type { AgentStreamEvent } from '../../src/server/agents/types.js';

const fixture = readFileSync(new URL('../fixtures/claude-stream.jsonl', import.meta.url), 'utf8');

function run(lines: string[], cwd = '/work/probe') {
  const p = createClaudeParser(cwd);
  const events: AgentStreamEvent[] = [];
  for (const l of lines) events.push(...p.push(l));
  return { events, result: p.result() };
}

describe('createClaudeParser (fixture)', () => {
  const { events, result } = run(fixture.split('\n'));

  it('starts with session id and model', () => {
    expect(events[0]).toEqual({ t: 'started', providerSessionId: '90d8ff17-739b-4d26-9dc9-f4fd4e8f8ec0', model: 'claude-haiku-5-5' });
    expect(events.filter((e) => e.t === 'started')).toHaveLength(1);
  });

  it('emits tool running→ok pairs with matching ids', () => {
    const tools = events.filter((e): e is Extract<AgentStreamEvent, { t: 'tool' }> => e.t === 'tool');
    const ids = [...new Set(tools.map((t) => t.id))];
    expect(ids).toEqual(['toolu_01B7daP5je45LLCHx21DJZUo', 'toolu_019TcUFk6P79LQiHTAJxSPZ7', 'toolu_01YUe5ct7kmyaBHLUqJMXyD2']);
    for (const id of ids) {
      const seq = tools.filter((t) => t.id === id).map((t) => t.state);
      expect(seq).toEqual(['running', 'ok']);
    }
    const [read, write, bash] = ids.map((id) => tools.find((t) => t.id === id && t.state === 'ok')!);
    expect(read).toMatchObject({ kind: 'read', title: 'README.md', files: ['README.md'] });
    expect(read.output).toContain('edited by codex');
    expect(write).toMatchObject({ kind: 'write', files: ['bye.txt'] });
    expect(bash).toMatchObject({ kind: 'read', title: 'cat bye.txt', detail: 'Print contents of bye.txt', exitCode: 0, output: 'bye' });
  });

  it('streams text deltas that add up to the complete text block, same msgId', () => {
    const deltas = events.filter((e): e is Extract<AgentStreamEvent, { t: 'text_delta' }> => e.t === 'text_delta');
    const texts = events.filter((e): e is Extract<AgentStreamEvent, { t: 'text' }> => e.t === 'text');
    expect(texts).toHaveLength(1);
    expect(deltas.map((d) => d.text).join('')).toBe(texts[0].text);
    expect(new Set(deltas.map((d) => d.msgId))).toEqual(new Set([texts[0].msgId]));
  });

  it('never emits thinking content', () => {
    const json = JSON.stringify(events);
    expect(json).not.toContain('signature');
    expect(json).not.toContain('thinking');
    expect(json).not.toContain('CAQS5QgK');
  });

  it('maps the rate limit event (epoch seconds → ms)', () => {
    const rl = events.find((e) => e.t === 'rate_limit');
    expect(rl).toBeTruthy();
    if (rl?.t !== 'rate_limit') throw new Error('no rate limit');
    expect(rl.info.windows.five_hour).toEqual({ utilization: 0.21, resetsAt: 1792815600_000, status: 'allowed' });
    expect(rl.info.windows.seven_day.utilization).toBe(0.16);
  });

  it('reports usage and final text', () => {
    const usage = events.find((e) => e.t === 'usage');
    expect(usage).toEqual({ t: 'usage', usage: { inputTokens: 6 + 20532 + 62577, cachedInputTokens: 62577, outputTokens: 620, costUsd: 0.005042769999999999, turns: 1 } });
    expect(result.sawResult).toBe(true);
    expect(result.isError).toBe(false);
    expect(result.text).toBe('I read README.md, created bye.txt containing "bye", and `cat bye.txt` printed `bye`.');
    expect(result.model).toBe('claude-haiku-5-5');
    expect(result.providerSessionId).toBe('90d8ff17-739b-4d26-9dc9-f4fd4e8f8ec0');
  });

  it('has a sensible order: started first, usage last', () => {
    expect(events[0].t).toBe('started');
    expect(events[events.length - 1].t).toBe('usage');
  });
});

describe('createClaudeParser (errors)', () => {
  it('classifies the real invalid-model result as model_unavailable', () => {
    const { result } = run([
      '[claude-code:unrecognized_model] no-such-model-x',
      JSON.stringify({ type: 'result', subtype: 'success', is_error: true, api_error_status: 404, session_id: 's1',
        result: "There's an issue with the selected model (no-such-model-x). It may not exist or you may not have access to it. Run --model to pick a different model.", usage: {} }),
    ]);
    expect(result.isError).toBe(true);
    expect(result.error?.code).toBe('model_unavailable');
    expect(result.nonJson[0]).toContain('unrecognized_model');
  });

  it('marks failed tool results as errors with exit codes', () => {
    const { events } = run([
      JSON.stringify({ type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }] } }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'Exit code 2\nFAIL src/a.test.ts' }] } }),
      JSON.stringify({ type: 'assistant', message: { id: 'm2', content: [{ type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: '/work/probe/a.ts' } }] } }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', is_error: true, content: [{ type: 'text', text: "Claude requested permissions to use Edit, but you haven't granted it yet." }] }] } }),
    ]);
    const done = events.filter((e) => e.t === 'tool' && e.state !== 'running');
    expect(done[0]).toMatchObject({ id: 't1', kind: 'test', state: 'error', exitCode: 2 });
    expect(done[1]).toMatchObject({ id: 't2', kind: 'edit', state: 'error' });
    expect((done[1] as any).output).toContain('permissions');
  });

  it('redacts secrets from tool output', () => {
    const { events } = run([
      JSON.stringify({ type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'cat .env' } }] } }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz123456' }] } }),
    ]);
    expect(JSON.stringify(events)).not.toContain('abcdefghijklmnopqrstuvwxyz123456');
  });

  it('ignores subagent text and skips empty blocks', () => {
    const { events } = run([
      JSON.stringify({ type: 'assistant', parent_tool_use_id: 'x', message: { id: 'm1', content: [{ type: 'text', text: 'inner' }] } }),
      JSON.stringify({ type: 'assistant', message: { id: 'm2', content: [{ type: 'text', text: '   ' }, { type: 'thinking', thinking: 'secret thoughts' }] } }),
    ]);
    expect(events).toEqual([]);
  });

  it('mapClaudeRateLimit falls back to rateLimitType', () => {
    expect(mapClaudeRateLimit({ status: 'rejected', resetsAt: 100, rateLimitType: 'five_hour' }, 5)).toEqual({ windows: { five_hour: { utilization: 1, resetsAt: 100_000, status: 'rejected' } }, observedAt: 5 });
    expect(mapClaudeRateLimit({ status: 'allowed' })).toBeNull();
  });
});

describe('buildClaudeArgs', () => {
  const base = { model: 'opus', access: 'write' as const, network: false };
  it('full-access developers skip permissions and OS sandbox, including on resume; reviewers stay restricted', () => {
    for (const resumeId of [undefined, 'session-full']) {
      const a = buildClaudeArgs({ ...base, fullAccess: true, osSandbox: true, resumeId });
      expect(a).toContain('--dangerously-skip-permissions');
      expect(JSON.parse(a[a.indexOf('--settings') + 1])).toEqual({ sandbox: { enabled: false } });
      expect(a[a.indexOf('--tools') + 1]).toContain('WebFetch,WebSearch');
      expect(a).not.toContain('--allowedTools');
      expect(a).not.toContain('--disallowedTools');
    }
    const review = buildClaudeArgs({ ...base, fullAccess: true, access: 'read' });
    expect(review).not.toContain('--dangerously-skip-permissions');
    expect(review.join(' ')).toContain('--permission-mode dontAsk');
    expect(review).toContain('--disallowedTools');
  });
  it('developer: acceptEdits, allow-list, deny-list incl. curl when offline', () => {
    const a = buildClaudeArgs({ ...base, effort: 'high', systemPrompt: '-starts with dash', resumeId: 'abc' });
    expect(a.slice(0, 7)).toEqual(['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--model', 'opus']);
    expect(a).toContain('--strict-mcp-config');
    expect(a.join(' ')).toContain('--setting-sources project,local');
    expect(a).toContain('--disable-slash-commands');
    expect(a.join(' ')).toContain('--permission-prompts none');
    expect(a.join(' ')).toContain('--effort high');
    expect(a.join(' ')).toContain('--resume abc');
    expect(a).toContain('--append-system-prompt=-starts with dash');
    expect(a.join(' ')).toContain('--permission-mode acceptEdits');
    expect(a).toContain('Bash(git push:*)');
    expect(a).toContain('Bash(curl:*)');
    expect(a).not.toContain('WebFetch');
    expect(a).not.toContain('--bare');
  });
  it('developer with network gets web tools and no curl deny', () => {
    const a = buildClaudeArgs({ ...base, network: true });
    expect(a).toContain('WebFetch');
    expect(a).not.toContain('Bash(curl:*)');
  });
  it('reviewer: read-only tools, Bash patterns only, edits denied', () => {
    const a = buildClaudeArgs({ ...base, access: 'read', extraReadDirs: ['/att'] });
    expect(a.join(' ')).toContain('--tools Read,Grep,Glob,Bash');
    expect(a).toContain('Bash(git diff:*)');
    expect(a).not.toContain('Bash');
    expect(a.join(' ')).toContain('--disallowedTools Edit Write MultiEdit NotebookEdit');
    expect(a.join(' ')).toContain('--permission-mode dontAsk');
    expect(a.slice(-2)).toEqual(['--add-dir', '/att']);
  });
  it('osSandbox adds settings; ultra effort maps to max', () => {
    const a = buildClaudeArgs({ ...base, osSandbox: true, effort: 'ultra' });
    const i = a.indexOf('--settings');
    expect(JSON.parse(a[i + 1])).toEqual({ sandbox: { enabled: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false } });
    expect(a.join(' ')).toContain('--effort max');
  });
  it('images are mentioned in the prompt and their dirs added', () => {
    expect(claudePrompt('hi', ['/a/b.png'])).toContain('/a/b.png');
    expect(buildClaudeArgs({ ...base, images: ['/a/b.png'] }).slice(-2)).toEqual(['--add-dir', '/a']);
  });
});
