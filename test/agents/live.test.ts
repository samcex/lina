// Live checks against the real CLIs. Skipped unless LINA_LIVE=1 (they cost quota).
//   LINA_LIVE=1 npx vitest run test/agents/live.test.ts
// Optional: LINA_LIVE_DOCTOR=1 also runs `runDoctor({ live: true })` (one haiku turn + codex sandbox probe).
// Raw CLI stdout is tee'd to $LINA_LIVE_DIR/raw-*.jsonl for inspection.
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { AgentStreamEvent, TurnOptions } from '../../src/server/agents/types.js';

const LIVE = process.env.LINA_LIVE === '1';
const d = LIVE ? describe : describe.skip;

const scratchRoot = process.env.LINA_LIVE_ROOT || '/tmp/claude-1000';
let root = '';
let repo = '';

function teeWrapper(name: string, realBin: string): string {
  const p = join(root, `${name}-tee.sh`);
  // `codex mcp list` (isolation discovery) is passed through untouched: only agent streams are captured.
  writeFileSync(p, `#!/bin/sh\nif [ "$1" = mcp ]; then exec "${realBin}" "$@"; fi\n"${realBin}" "$@" | tee -a "${join(root, `raw-${name}.jsonl`)}"\n`);
  chmodSync(p, 0o755);
  return p;
}

function turn(over: Partial<TurnOptions>): TurnOptions {
  return {
    prompt: '', cwd: repo, model: 'haiku', access: 'write', network: false,
    signal: new AbortController().signal, turnTimeoutMs: 240_000, idleTimeoutMs: 180_000, ...over,
  };
}

d('live CLIs', () => {
  beforeAll(() => {
    mkdirSync(scratchRoot, { recursive: true });
    root = mkdtempSync(join(scratchRoot, 'lina-live-'));
    process.env.LINA_HOME = join(root, 'home');
    process.env.LINA_LIVE_DIR = root;
    repo = join(root, 'repo');
    mkdirSync(repo);
    execFileSync('git', ['init', '-q'], { cwd: repo });
    writeFileSync(join(repo, 'README.md'), '# probe\n');
    execFileSync('git', ['-c', 'user.name=LINA', '-c', 'user.email=lina@localhost', 'add', '.'], { cwd: repo });
    execFileSync('git', ['-c', 'user.name=LINA', '-c', 'user.email=lina@localhost', 'commit', '-qm', 'init'], { cwd: repo });
    console.log('[live] scratch dir:', root);
  });

  describe('claude', () => {
    let sessionId = '';

    it('write turn (+ system prompt via --append-system-prompt=)', async () => {
      const { ClaudeAdapter } = await import('../../src/server/agents/claude.js');
      const a = new ClaudeAdapter({ bin: teeWrapper('claude', 'claude') });
      const events: AgentStreamEvent[] = [];
      const r = await a.runTurn(turn({
        prompt: 'Create a file named hello.txt containing exactly the text "hi from claude" (no trailing newline needed). Then run `cat hello.txt` with the Bash tool. Reply in one short sentence.',
        systemPrompt: 'You are the developer in LINA. Always end your final reply with the token LINA-SP-OK.',
      }), (e) => events.push(e));
      console.log('[live] claude write:', JSON.stringify({ ok: r.ok, text: r.text, model: r.model, sid: r.providerSessionId, usage: r.usage, error: r.error }));
      console.log('[live] claude events:', events.filter((e) => e.t !== 'text_delta').map((e) => JSON.stringify(e).slice(0, 200)).join('\n'));
      expect(r.ok).toBe(true);
      expect(r.providerSessionId).toBeTruthy();
      expect(events[0].t).toBe('started');
      expect(readFileSync(join(repo, 'hello.txt'), 'utf8')).toContain('hi from claude');
      expect(events.some((e) => e.t === 'tool' && e.state === 'ok' && (e.kind === 'write' || e.kind === 'edit'))).toBe(true);
      expect(events.some((e) => e.t === 'text_delta')).toBe(true);
      expect(r.text).toContain('LINA-SP-OK');
      sessionId = r.providerSessionId!;
    }, 300_000);

    it('resume turn keeps the session', async () => {
      const { ClaudeAdapter } = await import('../../src/server/agents/claude.js');
      const a = new ClaudeAdapter();
      const r = await a.runTurn(turn({ prompt: 'Which file did you create in the previous turn? Answer with just the file name.', resumeId: sessionId }), () => {});
      console.log('[live] claude resume:', JSON.stringify({ ok: r.ok, text: r.text, sid: r.providerSessionId, error: r.error }));
      expect(r.ok).toBe(true);
      expect(r.providerSessionId).toBe(sessionId);
      expect(r.text).toContain('hello.txt');
    }, 300_000);

    it('reviewer (read access) cannot edit', async () => {
      const { ClaudeAdapter } = await import('../../src/server/agents/claude.js');
      const a = new ClaudeAdapter({ bin: teeWrapper('claude-review', 'claude') });
      const events: AgentStreamEvent[] = [];
      const r = await a.runTurn(turn({
        access: 'read',
        prompt: 'Change the content of hello.txt to "hacked" using any tool you have (Edit, Write, or Bash such as `echo hacked > hello.txt`). If every attempt is refused, reply with the word DENIED.',
      }), (e) => events.push(e));
      console.log('[live] claude review:', JSON.stringify({ ok: r.ok, text: r.text, error: r.error }));
      console.log('[live] review tools:', events.filter((e) => e.t === 'tool').map((e) => JSON.stringify(e).slice(0, 300)).join('\n'));
      expect(readFileSync(join(repo, 'hello.txt'), 'utf8')).toContain('hi from claude');
      expect(readFileSync(join(repo, 'hello.txt'), 'utf8')).not.toContain('hacked');
    }, 300_000);
  });

  describe('codex', () => {
    let threadId = '';

    it('write turn', async () => {
      const { CodexAdapter } = await import('../../src/server/agents/codex.js');
      const a = new CodexAdapter({ bin: teeWrapper('codex', 'codex') });
      const events: AgentStreamEvent[] = [];
      const r = await a.runTurn(turn({
        model: 'gpt-6-luna', effort: 'low',
        prompt: 'Create a file named codex.txt containing exactly the text "hi from codex". Then run `cat codex.txt`. Reply in one short sentence.',
        systemPrompt: 'You are the developer in LINA. Always end your final reply with the token LINA-SP-OK.',
      }), (e) => events.push(e));
      console.log('[live] codex write:', JSON.stringify({ ok: r.ok, text: r.text, sid: r.providerSessionId, usage: r.usage, error: r.error }));
      console.log('[live] codex events:', events.map((e) => JSON.stringify(e).slice(0, 300)).join('\n'));
      expect(r.ok).toBe(true);
      expect(r.providerSessionId).toBeTruthy();
      expect(existsSync(join(repo, 'codex.txt'))).toBe(true);
      expect(r.text).toContain('LINA-SP-OK');
      threadId = r.providerSessionId!;
    }, 300_000);

    it('resume turn keeps the thread', async () => {
      const { CodexAdapter } = await import('../../src/server/agents/codex.js');
      const a = new CodexAdapter({ bin: teeWrapper('codex-resume', 'codex') });
      const r = await a.runTurn(turn({ model: 'gpt-6-luna', effort: 'low', access: 'read', resumeId: threadId, prompt: 'Which file did you create in the previous turn? Answer with just the file name.' }), () => {});
      console.log('[live] codex resume:', JSON.stringify({ ok: r.ok, text: r.text, sid: r.providerSessionId, error: r.error }));
      expect(r.ok).toBe(true);
      expect(r.providerSessionId).toBe(threadId);
      expect(r.text).toContain('codex.txt');
    }, 300_000);
  });

  describe('validateModel', () => {
    it('claude good + bad', async () => {
      const { validateModel } = await import('../../src/server/agents/models.js');
      const good = await validateModel('claude', 'haiku');
      const bad = await validateModel('claude', 'no-such-model-x');
      console.log('[live] claude validate:', JSON.stringify({ good, bad }));
      expect(good.ok).toBe(true);
      expect(good.resolvedModel).toMatch(/^claude-haiku/);
      expect(bad.ok).toBe(false);
      expect(bad.code).toBe('model_unavailable');
    }, 240_000);

    it('codex good + bad', async () => {
      const { validateModel, discoverModels } = await import('../../src/server/agents/models.js');
      const good = await validateModel('codex', 'gpt-6-luna');
      const bad = await validateModel('codex', 'no-such-model-x');
      console.log('[live] codex validate:', JSON.stringify({ good, bad }));
      expect(good.ok).toBe(true);
      expect(bad.ok).toBe(false);
      expect(bad.code).toBe('model_unavailable');
      const m = await discoverModels('codex');
      expect(m.models.find((x) => x.id === 'gpt-6-luna')?.validation?.ok).toBe(true);
    }, 240_000);
  });

  (process.env.LINA_LIVE_DOCTOR === '1' ? it : it.skip)('doctor --live', async () => {
    const { runDoctor, getSandboxStatus } = await import('../../src/server/agents/doctor.js');
    const checks = await runDoctor({ live: true });
    console.log('[live] doctor:', JSON.stringify(checks, null, 1));
    console.log('[live] sandbox status:', JSON.stringify(getSandboxStatus()));
    expect(checks.find((c) => c.id === 'codex-sandbox')).toBeTruthy();
    expect(checks.find((c) => c.id === 'claude-sandbox')).toBeTruthy();
  }, 300_000);
});
