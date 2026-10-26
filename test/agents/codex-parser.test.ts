import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildCodexArgs, createCodexParser } from '../../src/server/agents/codex.js';
import type { AgentStreamEvent } from '../../src/server/agents/types.js';

const load = (f: string) => readFileSync(new URL(`../fixtures/${f}`, import.meta.url), 'utf8').split('\n');
type ToolEv = Extract<AgentStreamEvent, { t: 'tool' }>;

function run(lines: string[], cwd = '/work/probe') {
  const p = createCodexParser(cwd, 'gpt-6-luna');
  const events: AgentStreamEvent[] = [];
  for (const l of lines) events.push(...p.push(l));
  return { events, result: p.result() };
}

describe('createCodexParser (codex-exec.jsonl)', () => {
  const { events, result } = run(load('codex-exec.jsonl'));
  const tools = events.filter((e): e is ToolEv => e.t === 'tool');

  it('starts with the thread id', () => {
    expect(events[0]).toEqual({ t: 'started', providerSessionId: '01a16b18-333e-7933-ab13-08eb9391b72c', model: 'gpt-6-luna' });
  });

  it('pairs running→final per item id', () => {
    for (const id of ['item_1', 'item_2', 'item_3', 'item_4']) {
      expect(tools.filter((t) => t.id === id).map((t) => t.state)).toHaveLength(2);
      expect(tools.find((t) => t.id === id)!.state).toBe('running');
    }
  });

  it('marks the bwrap sandbox failure as a tool error with exit code', () => {
    const fail = tools.find((t) => t.id === 'item_1' && t.state !== 'running')!;
    expect(fail).toMatchObject({ kind: 'read', title: "sed -n '1,8p' README.md", state: 'error', exitCode: 1 });
    expect(fail.output).toContain('bwrap');
  });

  it('classifies the other commands', () => {
    expect(tools.find((t) => t.id === 'item_2' && t.state === 'ok')).toMatchObject({ kind: 'read', title: 'pwd', exitCode: 0, output: '/work/probe\n' });
    expect(tools.find((t) => t.id === 'item_3' && t.state === 'ok')).toMatchObject({ kind: 'read', title: 'cat README.md' });
  });

  it('file_change → edit with relative files', () => {
    expect(tools.find((t) => t.id === 'item_4' && t.state === 'ok')).toMatchObject({ kind: 'edit', title: 'Edited README.md', files: ['README.md'] });
  });

  it('agent messages → text events; last one is the final text', () => {
    const texts = events.filter((e) => e.t === 'text');
    expect(texts.map((t: any) => t.msgId)).toEqual(['item_0', 'item_5']);
    expect(result.text).toBe('Added `edited by codex` as the second line of README.md.');
  });

  it('usage from turn.completed', () => {
    expect(events[events.length - 1]).toEqual({ t: 'usage', usage: { inputTokens: 132039, cachedInputTokens: 112128, outputTokens: 230, turns: 1 } });
    expect(result.turnCompleted).toBe(true);
    expect(result.turnFailed).toBe(false);
  });
});

describe('createCodexParser (codex-exec-simple.jsonl)', () => {
  it('redirect-writing command is an edit; turn completes', () => {
    const { events, result } = run(load('codex-exec-simple.jsonl'));
    const t = events.filter((e): e is ToolEv => e.t === 'tool');
    expect(t.map((x) => x.state)).toEqual(['running', 'ok']);
    expect(t[1]).toMatchObject({ kind: 'edit', exitCode: 0, output: 'hi' });
    expect(result.text).toBe('Created `hello.txt`; `cat hello.txt` printed `hi`.');
    expect(result.threadId).toBe('01a16b17-e7c4-75a0-a7a0-9755aa460028');
  });
});

describe('createCodexParser (errors)', () => {
  const inner = JSON.stringify({ type: 'error', status: 400, error: { type: 'invalid_request_error', message: "The 'no-such-model-x' model is not supported when using Codex with a ChatGPT account." } });
  it('real invalid-model stream → model_unavailable, turn failed', () => {
    const { events, result } = run([
      JSON.stringify({ type: 'thread.started', thread_id: 't1' }),
      JSON.stringify({ type: 'turn.started' }),
      JSON.stringify({ type: 'error', message: inner }),
      JSON.stringify({ type: 'turn.failed', error: { message: inner } }),
    ]);
    expect(result.turnFailed).toBe(true);
    expect(result.turnCompleted).toBe(false);
    expect(result.error?.code).toBe('model_unavailable');
    expect(result.error?.message).toContain('not supported when using Codex with a ChatGPT account');
    expect(events.find((e) => e.t === 'warning')).toBeTruthy();
  });

  it('model metadata item errors are warnings; reasoning is dropped', () => {
    const { events } = run([
      JSON.stringify({ type: 'item.completed', item: { id: 'i0', type: 'error', message: 'Model metadata for `x` not found. Defaulting to fallback metadata.' } }),
      JSON.stringify({ type: 'item.completed', item: { id: 'i1', type: 'reasoning', text: 'hidden chain of thought' } }),
    ]);
    expect(events).toEqual([{ t: 'warning', message: 'Model metadata for `x` not found. Defaulting to fallback metadata.' }]);
  });

  it('mcp_tool_call / web_search → tools', () => {
    const { events } = run([
      JSON.stringify({ type: 'item.started', item: { id: 'm', type: 'mcp_tool_call', server: 'srv', tool: 'q', status: 'in_progress' } }),
      JSON.stringify({ type: 'item.completed', item: { id: 'm', type: 'mcp_tool_call', server: 'srv', tool: 'q', status: 'failed', error: { message: 'nope' } } }),
      JSON.stringify({ type: 'item.completed', item: { id: 'w', type: 'web_search', query: 'vitest docs' } }),
    ]);
    expect(events).toMatchObject([
      { t: 'tool', id: 'm', kind: 'tool', state: 'running' },
      { t: 'tool', id: 'm', kind: 'tool', state: 'error', output: 'nope' },
      { t: 'tool', id: 'w', kind: 'web', title: 'Search: vitest docs', state: 'ok' },
    ]);
  });
});

describe('buildCodexArgs', () => {
  const base = { cwd: '/ws', model: 'gpt-6-luna', access: 'write' as const, network: false };
  it('Full access uses --yolo for fresh/resumed developer and reviewer turns', () => {
    const fresh = buildCodexArgs({ ...base, fullAccess: true });
    expect(fresh).toContain('--yolo');
    expect(fresh).toContain('sandbox_mode="danger-full-access"');
    expect(fresh).not.toContain('-s');
    expect(fresh).toContain('approval_policy="never"');
    expect(fresh.some((a) => a.startsWith('sandbox_workspace_write.network_access'))).toBe(false);
    const resumed = buildCodexArgs({ ...base, fullAccess: true, resumeId: 'thread-full' });
    expect(resumed).toContain('sandbox_mode="danger-full-access"');
    expect(resumed.slice(-2)).toEqual(['thread-full', '-']);
    const reviewer = buildCodexArgs({ ...base, fullAccess: true, access: 'read' });
    expect(reviewer).toContain('--yolo');
    expect(reviewer).toContain('sandbox_mode="danger-full-access"');
    expect(buildCodexArgs({...base,access:'read',fullAccess:true,resumeId:'review-full'})).toContain('--yolo');
  });
  it('new thread: explicit sandbox, -C, stdin prompt', () => {
    const a = buildCodexArgs({ ...base, effort: 'low', systemPrompt: 'Be "careful"\nline2' }, ['--disable', 'plugins']);
    expect(a.slice(0, 2)).toEqual(['exec', '--json']);
    expect(a.join(' ')).toContain('-s workspace-write -C /ws');
    expect(a.join(' ')).toContain('-m gpt-6-luna');
    expect(a).toContain('model_reasoning_effort="low"');
    expect(a).toContain('sandbox_workspace_write.network_access=false');
    expect(a).toContain('developer_instructions="Be \\"careful\\"\\nline2"');
    expect(a).toContain('--skip-git-repo-check');
    expect(a[a.length - 1]).toBe('-');
    expect(a.join(' ')).not.toMatch(/dangerously|danger-full-access/);
  });
  it('resume: no -s/-C, sandbox via -c, thread id before "-"', () => {
    const a = buildCodexArgs({ ...base, access: 'read', resumeId: 'thr-1' });
    expect(a.slice(0, 3)).toEqual(['exec', 'resume', '--json']);
    expect(a).not.toContain('-s');
    expect(a).not.toContain('-C');
    expect(a).toContain('sandbox_mode="read-only"');
    expect(a.slice(-2)).toEqual(['thr-1', '-']);
  });
  it('network on + images', () => {
    const a = buildCodexArgs({ ...base, network: true, images: ['/x/a.png'] });
    expect(a).toContain('sandbox_workspace_write.network_access=true');
    expect(a).toContain('--image=/x/a.png');
  });
});

describe('codexIsolationArgs', () => {
  it('disables plugins and every enabled user MCP server by name only', async () => {
    const { mkdtempSync, writeFileSync, chmodSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { codexIsolationArgs } = await import('../../src/server/agents/codex.js');
    const dir = mkdtempSync(join(tmpdir(), 'lina-fake-codex-'));
    const bin = join(dir, 'codex');
    const list = [
      { name: 'rea', enabled: true, transport: { env: { SECRET: 'x' } } },
      { name: 'off', enabled: false },
      { name: 'code-review', enabled: true },
      { name: 'bad.name', enabled: true },
    ];
    writeFileSync(bin, `#!/bin/sh\n[ "$1 $2 $3" = "mcp list --json" ] || exit 9\ncat <<'JSON'\n${JSON.stringify(list)}\nJSON\n`);
    chmodSync(bin, 0o755);
    try {
      expect(await codexIsolationArgs(bin)).toEqual(['--disable', 'plugins', '-c', 'mcp_servers.rea.enabled=false', '-c', 'mcp_servers.code-review.enabled=false']);
      const broken = join(dir, 'broken');
      writeFileSync(broken, '#!/bin/sh\nexit 1\n');
      chmodSync(broken, 0o755);
      expect(await codexIsolationArgs(broken)).toEqual(['--disable', 'plugins']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
