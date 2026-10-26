// Deterministic scripted agent used by tests and LINA_MOCK=1 demo mode.
// It really edits files in the workspace so checkpoints, diffs and tests are meaningful.
// Behaviour is selected from the step marker LINA puts in prompts: <!-- lina:step=<step> round=<n> -->
//
// Scenarios (constructor option `scenario` or env LINA_MOCK_SCENARIO):
//   default   – review round 1 requests changes (1 major + 1 minor); developer fixes the major and
//               disputes the minor; review round 2 resolves the fix, withdraws the minor and approves.
//   stubborn  – the reviewer never approves and raises a new major finding every round (maxRounds stop).
//   insist    – the reviewer keeps the same major finding open every round (identical-set escalation).
//   garbage   – the reviewer never produces a parseable lina-review block.
//   fail      – every turn fails with an auth error.
//   nosplit   – parallel: the lead never produces a usable lina-split (the session falls back to pair).
//   conflict  – parallel: both parts also write `index.js`, so integration conflicts; the lead's integrate turn
//               resolves the markers by keeping both sides.
//   conflict-stuck – like conflict, but the integrate turn leaves the markers in place.
// Default parallel split: codex builds hello.js (+ test), claude builds farewell.js (+ test).
// compete: each agent writes its own version of hello.js in its own worktree; cross-reviews behave like `default`.
// Concurrent turns on one instance are safe: every turn keeps its state in locals.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AgentId, UsageTotals } from '../../shared/types.js';
import type { AgentAdapter, AgentStreamEvent, TurnOptions, TurnResult } from './types.js';

export interface MockOptions {
  /** Delay between streamed chunks/tool events (ms). Default: env LINA_MOCK_DELAY_MS or 15. */
  delayMs?: number;
  scenario?: string;
  /** Extra time to hold a turn open, per step (abortable) — for cancel/interrupt tests. */
  holdMs?: Partial<Record<string, number>>;
}

export interface MockCall { agent: AgentId; step: string; round: number; prompt: string; opts: Omit<TurnOptions, 'signal'> }

/** Every prompt any MockAdapter received (tests inspect this). */
export const mockCalls: MockCall[] = [];

const HELLO_V1 = `'use strict';

function hello(name) {
  return \`Hello, \${name}!\`;
}

module.exports = { hello };
`;

const HELLO_V2 = `'use strict';

function hello(name) {
  if (typeof name !== 'string' || !name.trim()) {
    throw new TypeError('name must be a non-empty string');
  }
  return \`Hello, \${name.trim()}!\`;
}

module.exports = { hello };
`;

const TEST_V1 = `'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { hello } = require('./hello.js');

test('greets by name', () => {
  assert.strictEqual(hello('Ada'), 'Hello, Ada!');
});
`;

const HELLO_ALT = `'use strict';

const hello = (name) => ['Hello, ', name, '!'].join('');

module.exports = { hello };
`;

const FAREWELL = `'use strict';

function farewell(name) {
  return \`Goodbye, \${name}!\`;
}

module.exports = { farewell };
`;

const FAREWELL_TEST = `'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { farewell } = require('./farewell.js');

test('says goodbye by name', () => {
  assert.strictEqual(farewell('Ada'), 'Goodbye, Ada!');
});
`;

export const MOCK_SPLIT = {
  parts: [
    { agent: 'codex', title: 'Greeting', scope: 'hello(name) with a node:test test', files: ['hello.js', 'hello.test.js'] },
    { agent: 'claude', title: 'Farewell', scope: 'farewell(name) with a node:test test', files: ['farewell.js', 'farewell.test.js'] },
  ],
};

const TEST_V2 = TEST_V1 + `
test('rejects empty names', () => {
  assert.throws(() => hello(''), TypeError);
  assert.throws(() => hello(undefined), TypeError);
});
`;

class Aborted extends Error {}

export class MockAdapter implements AgentAdapter {
  private seq = 0;
  constructor(readonly id: AgentId, private o: MockOptions = {}) {}

  private get delay(): number {
    if (this.o.delayMs !== undefined) return this.o.delayMs;
    const env = Number(process.env.LINA_MOCK_DELAY_MS);
    return Number.isFinite(env) && process.env.LINA_MOCK_DELAY_MS !== undefined ? env : 15;
  }
  private get scenario(): string { return this.o.scenario ?? process.env.LINA_MOCK_SCENARIO ?? 'default'; }

  async runTurn(opts: TurnOptions, onEvent: (e: AgentStreamEvent) => void): Promise<TurnResult> {
    const start = Date.now();
    const m = /<!-- lina:step=(\w+) round=(\d+) -->/.exec(opts.prompt);
    const step = m?.[1] ?? 'consult';
    const round = Number(m?.[2] ?? 0);
    const { signal: _s, ...rest } = opts;
    mockCalls.push({ agent: this.id, step, round, prompt: opts.prompt, opts: rest });
    const providerSessionId = opts.resumeId ?? `mock-${this.id}-${Math.random().toString(36).slice(2, 10)}`;
    const usage: Partial<UsageTotals> = { inputTokens: 400 + Math.ceil(opts.prompt.length / 4), outputTokens: 0, cachedInputTokens: opts.resumeId ? 300 : 0, costUsd: 0.0012 };
    const fail = (code: 'cancelled' | 'auth', message: string, hint?: string): TurnResult => ({
      ok: false, text: '', providerSessionId, model: opts.model, usage, durationMs: Date.now() - start, error: { code, message, hint },
    });
    try {
      onEvent({ t: 'started', providerSessionId, model: opts.model });
      await this.wait(opts.signal);
      if (this.scenario === 'fail') return fail('auth', `${this.id} is not logged in (mock)`, `Run \`${this.id === 'claude' ? 'claude' : 'codex'} login\``);
      const text = await this.script(step, round, opts, onEvent);
      const hold = this.o.holdMs?.[step];
      if (hold) await this.wait(opts.signal, hold);
      await this.stream(text, opts.signal, onEvent);
      usage.outputTokens = Math.ceil(text.length / 4);
      onEvent({ t: 'usage', usage });
      if (this.id === 'claude') onEvent({ t: 'rate_limit', info: { windows: { five_hour: { utilization: 0.12, status: 'allowed' } }, observedAt: Date.now() } });
      return { ok: true, text, providerSessionId, model: opts.model, usage, durationMs: Date.now() - start };
    } catch (e) {
      if (e instanceof Aborted || opts.signal.aborted) return fail('cancelled', 'Turn cancelled');
      throw e;
    }
  }

  private async wait(signal: AbortSignal, ms = this.delay): Promise<void> {
    if (signal.aborted) throw new Aborted();
    if (ms <= 0) { await Promise.resolve(); if (signal.aborted) throw new Aborted(); return; }
    await new Promise<void>((res, rej) => {
      const t = setTimeout(() => { signal.removeEventListener('abort', on); res(); }, ms);
      const on = () => { clearTimeout(t); rej(new Aborted()); };
      signal.addEventListener('abort', on, { once: true });
    });
  }

  private async stream(text: string, signal: AbortSignal, onEvent: (e: AgentStreamEvent) => void): Promise<string> {
    const msgId = `mock-msg-${++this.seq}`;
    for (let i = 0; i < text.length; i += 48) {
      onEvent({ t: 'text_delta', msgId, text: text.slice(i, i + 48) });
      await this.wait(signal, Math.min(this.delay, 5));
    }
    onEvent({ t: 'text', msgId, text });
    return msgId;
  }

  private async tool(signal: AbortSignal, onEvent: (e: AgentStreamEvent) => void, kind: 'read' | 'edit' | 'command' | 'test' | 'git' | 'search', title: string, extra: { files?: string[]; output?: string } = {}, act?: () => void): Promise<void> {
    const id = `t${++this.seq}`;
    onEvent({ t: 'tool', id, kind, title, state: 'running', files: extra.files });
    await this.wait(signal);
    act?.();
    const done: AgentStreamEvent = { t: 'tool', id, kind, title, state: 'ok', files: extra.files, output: extra.output };
    if (kind === 'command' || kind === 'test' || kind === 'git') (done as { exitCode?: number }).exitCode = 0;
    onEvent(done);
  }

  private async script(step: string, round: number, opts: TurnOptions, onEvent: (e: AgentStreamEvent) => void): Promise<string> {
    const s = opts.signal;
    const cwd = opts.cwd;
    const write = (rel: string, content: string) => {
      if (opts.access !== 'write') throw new Error(`mock ${this.id}: write attempted with read access`);
      const p = join(cwd, rel);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, content);
    };
    switch (step) {
      case 'goal_check':
        if (this.scenario === 'goal-blocked') return 'LINA_GOAL_BLOCKED: Choose the deployment target.';
        if (['goal-malformed','goal-malformed-once'].includes(this.scenario)) return 'Looks good to me.';
        if (this.scenario === 'goal-continue' && round === 0) return 'LINA_GOAL_CONTINUE: Finish the requested input validation.';
        return 'The implementation and tests satisfy the goal.\nLINA_GOAL_COMPLETE';
      case 'goal_check_repair': return this.scenario === 'goal-malformed' ? 'Looks good.' : 'LINA_GOAL_COMPLETE';
      case 'goal_blocker_check': case 'goal_blocker_repair': return 'LINA_GOAL_INPUT: Choose the deployment target.';
      case 'chat': {
        const request = /Request from the project owner:\n([\s\S]*?)(?:\n\n|$)/.exec(opts.prompt)?.[1] ?? opts.prompt;
        if (/^(what|why|how|can you explain|explain|hello\b|hi\b)/i.test(request)) return 'This project exposes a hello(name) function. I can explain it without changing any files.';
        if (/documentation only/i.test(request)) {
          await this.tool(s, onEvent, 'edit', 'Edit NOTES.md', { files: ['NOTES.md'] }, () => write('NOTES.md', '# Documentation update\n'));
          return 'Updated the documentation.\n```lina-chat\n{"test":false,"review":false}\n```';
        }
        await this.tool(s, onEvent, 'edit', 'Write hello.js', { files: ['hello.js'] }, () => write('hello.js', HELLO_V1));
        await this.tool(s, onEvent, 'edit', 'Write hello.test.js', { files: ['hello.test.js'] }, () => write('hello.test.js', TEST_V1));
        return 'Implemented hello(name) with a test.\n```lina-chat\n{"test":true,"review":true}\n```';
      }
      case 'plan': {
        await this.stream('Let me look at the existing code first.', s, onEvent);
        await this.tool(s, onEvent, 'search', 'List project files');
        return [
          'Plan:',
          '- Add `hello(name)` in `hello.js` returning a greeting',
          '- Cover it with a `node:test` test in `hello.test.js`',
          '- Run the test suite to verify',
        ].join('\n');
      }
      case 'plan_review':
        await this.tool(s, onEvent, 'read', 'Read hello.js');
        return '- The plan is reasonable.\n- Consider input validation for empty names.';
      case 'implement': {
        await this.stream('Implementing the change now.', s, onEvent);
        await this.tool(s, onEvent, 'read', 'Read package.json');
        const revision = /requests changes:/.test(opts.prompt);
        if (revision || existsSync(join(cwd, 'hello.js'))) {
          const req = /requests changes:\n([^\n]*)/.exec(opts.prompt)?.[1] ?? 'follow-up';
          await this.tool(s, onEvent, 'edit', 'Edit NOTES.md', { files: ['NOTES.md'] }, () => appendFileSync(join(cwd, 'NOTES.md'), `- revision: ${req}\n`));
        } else {
          await this.tool(s, onEvent, 'edit', 'Write hello.js', { files: ['hello.js'] }, () => write('hello.js', HELLO_V1));
          await this.tool(s, onEvent, 'edit', 'Write hello.test.js', { files: ['hello.test.js'] }, () => write('hello.test.js', TEST_V1));
        }
        await this.tool(s, onEvent, 'test', 'node --test', { output: '# pass 1\n# fail 0' });
        return 'Implemented `hello(name)` in `hello.js` with a test in `hello.test.js`. Verified with `node --test` (1 passing).';
      }
      case 'review':
      case 'cross_review':
        return this.review(round, opts, onEvent);
      case 'split': {
        await this.tool(s, onEvent, 'search', 'List project files');
        const plan = 'Plan:\n- codex: `hello(name)` in `hello.js` with a test\n- claude: `farewell(name)` in `farewell.js` with a test\n- No shared files; each part runs its own tests';
        if (this.scenario === 'nosplit') return plan;
        return `${plan}\n\n\`\`\`lina-split\n${JSON.stringify(MOCK_SPLIT)}\n\`\`\``;
      }
      case 'split_repair':
        if (this.scenario === 'nosplit') return 'Sorry, I cannot split this task.';
        return `\`\`\`lina-split\n${JSON.stringify(MOCK_SPLIT)}\n\`\`\``;
      case 'part': {
        const mine = this.id === 'codex' ? [['hello.js', HELLO_V1], ['hello.test.js', TEST_V1]] : [['farewell.js', FAREWELL], ['farewell.test.js', FAREWELL_TEST]];
        if (this.scenario.startsWith('conflict')) mine.push(['index.js', `module.exports = { ...require('./${this.id === 'codex' ? 'hello' : 'farewell'}.js') };\n`]);
        for (const [rel, content] of mine) await this.tool(s, onEvent, 'edit', `Write ${rel}`, { files: [rel] }, () => write(rel, content));
        await this.tool(s, onEvent, 'test', 'node --test', { output: '# pass 1\n# fail 0' });
        return `Implemented my part: ${mine.map(([r]) => `\`${r}\``).join(', ')}. Verified with \`node --test\`.`;
      }
      case 'integrate': {
        const files = [...opts.prompt.matchAll(/^- `([^`]+)`$/gm)].map((x) => x[1]);
        for (const rel of files) {
          await this.tool(s, onEvent, 'read', `Read ${rel}`, { files: [rel] });
          if (this.scenario === 'conflict-stuck') continue;
          const p = join(cwd, rel);
          if (!existsSync(p)) continue;
          const kept = readFileSync(p, 'utf8').split('\n').filter((l) => !/^(<{7}|={7}|>{7})( |$)/.test(l));
          await this.tool(s, onEvent, 'edit', `Resolve ${rel}`, { files: [rel] }, () => write(rel, kept.join('\n')));
        }
        return this.scenario === 'conflict-stuck' ? 'I looked at the conflicts but left them as they are.' : `Resolved conflicts in ${files.join(', ')} by keeping both sides.`;
      }
      case 'compete': {
        await this.tool(s, onEvent, 'read', 'Read package.json');
        if (/requests changes:/.test(opts.prompt)) {
          const req = /requests changes:\n([^\n]*)/.exec(opts.prompt)?.[1] ?? 'follow-up';
          await this.tool(s, onEvent, 'edit', 'Edit NOTES.md', { files: ['NOTES.md'] }, () => appendFileSync(join(cwd, 'NOTES.md'), `- ${this.id} revision: ${req}\n`));
          return `Applied the requested change to my version (${this.id}).`;
        }
        await this.tool(s, onEvent, 'edit', 'Write hello.js', { files: ['hello.js'] }, () => write('hello.js', this.id === 'codex' ? HELLO_V1 : HELLO_ALT));
        await this.tool(s, onEvent, 'edit', 'Write hello.test.js', { files: ['hello.test.js'] }, () => write('hello.test.js', TEST_V1));
        await this.tool(s, onEvent, 'test', 'node --test', { output: '# pass 1\n# fail 0' });
        return `My version (${this.id}): \`hello(name)\` in \`hello.js\` with a test. Verified with \`node --test\`.`;
      }
      case 'repair':
        if (this.scenario === 'garbage') return 'Sorry, I cannot produce that.';
        return '```lina-review\n{"verdict":"approve","summary":"Looks good.","findings":[],"resolved":[],"withdrawn":[]}\n```';
      case 'revise': {
        const open = [...opts.prompt.matchAll(/^- (F\d+) \[(\w+)\]/gm)].map((x) => ({ id: x[1], severity: x[2] }));
        await this.tool(s, onEvent, 'edit', 'Edit hello.js', { files: ['hello.js'] }, () => write('hello.js', HELLO_V2));
        await this.tool(s, onEvent, 'edit', 'Edit hello.test.js', { files: ['hello.test.js'] }, () => write('hello.test.js', TEST_V2));
        await this.tool(s, onEvent, 'test', 'node --test', { output: '# pass 2\n# fail 0' });
        const items = open.map((f) => {
          if (f.severity === 'minor') return { id: f.id, action: 'disputed', note: 'The fixed "Hello, <name>!" format is exactly what the request specifies; making it configurable is scope creep.' };
          if (f.severity === 'nit') return { id: f.id, action: 'deferred', note: 'Cosmetic; out of scope for this change.' };
          return { id: f.id, action: 'fixed', note: 'Added input validation and a test for empty/non-string names.' };
        });
        return `Addressed the review: validation added in \`hello.js\` with a new test.\n\n\`\`\`lina-response\n${JSON.stringify({ items })}\n\`\`\``;
      }
      case 'feedback':
        return 'I have read the reviewer feedback. No further changes are needed; the stated limitations remain.\n```lina-response\n{"items":[]}\n```';
      case 'deliver':
      case 'consult': {
        const q = /addresses you directly:\n([^\n]*)/.exec(opts.prompt)?.[1] ?? /Message from the project owner:\n([^\n]*)/.exec(opts.prompt)?.[1] ?? '';
        if (opts.access === 'write' && /\b(change|add|edit|write|fix|update)\b/i.test(q)) {
          await this.tool(s, onEvent, 'edit', 'Edit NOTES.md', { files: ['NOTES.md'] }, () => appendFileSync(join(cwd, 'NOTES.md'), `- ${step}: ${q}\n`));
        } else {
          await this.tool(s, onEvent, 'read', 'Read hello.js');
        }
        return `Mock ${this.id} here. You asked: "${q}". ${existsSync(join(cwd, 'hello.js')) ? 'hello.js looks fine to me.' : 'There is no code yet.'}`;
      }
      default:
        return `Mock ${this.id}: nothing to do for step ${step}.`;
    }
  }

  private async review(round: number, opts: TurnOptions, onEvent: (e: AgentStreamEvent) => void): Promise<string> {
    const s = opts.signal;
    const base = /git diff ([0-9a-f]+)/.exec(opts.prompt)?.[1] ?? 'HEAD~1';
    await this.tool(s, onEvent, 'git', `git diff ${base}`, { output: existsSync(join(opts.cwd, 'hello.js')) ? readFileSync(join(opts.cwd, 'hello.js'), 'utf8').slice(0, 300) : '' });
    await this.tool(s, onEvent, 'read', 'Read hello.js');
    if (this.scenario === 'garbage') return 'I looked at it and have thoughts, but no structured block.';
    const prior = [...opts.prompt.matchAll(/^- (F\d+) \[(\w+)\/(\w+)\]/gm)].map((x) => ({ id: x[1], severity: x[2], status: x[3] }));
    const block = (o: unknown) => '```lina-review\n' + JSON.stringify(o, null, 1) + '\n```';
    if (this.scenario === 'stubborn') {
      return `Still not convinced.\n\n${block({
        verdict: 'request_changes', summary: `Round ${round}: new concerns.`,
        findings: [{ severity: 'major', title: `Concern #${round}`, detail: `Another issue found in round ${round}.`, file: 'hello.js', line: 1 }],
        resolved: prior.filter((p) => p.status === 'fixed').map((p) => p.id), withdrawn: [],
      })}`;
    }
    if (!prior.length || (this.scenario === 'insist' && round === 1)) {
      return `Solid start, and the test is a good touch. Two issues:\n\n1. \`hello()\` accepts empty or non-string names.\n2. The greeting format is hard-coded.\n\n${block({
        verdict: 'request_changes', summary: 'Needs input validation.',
        findings: [
          { severity: 'major', title: 'hello() accepts empty or non-string names', detail: 'hello("") returns "Hello, !" and hello(undefined) returns "Hello, undefined!".', file: 'hello.js', line: 3, suggestion: 'Throw a TypeError for empty/non-string input and test it.' },
          { severity: 'minor', title: 'Greeting format is hard-coded', detail: 'Consider making the greeting configurable.', file: 'hello.js', line: 4 },
        ],
        resolved: [], withdrawn: [],
      })}`;
    }
    if (this.scenario === 'insist') {
      const keep = prior.filter((p) => ['open', 'fixed', 'disputed'].includes(p.status) && (p.severity === 'major' || p.severity === 'blocker'));
      return `I still see the same problem.\n\n${block({
        verdict: 'request_changes', summary: 'Same issue remains.',
        findings: keep.map((p) => ({ id: p.id, severity: p.severity, title: 'hello() accepts empty or non-string names', detail: 'Still not handled to my satisfaction.' })),
        resolved: [], withdrawn: prior.filter((p) => p.status === 'disputed' && p.severity === 'minor').map((p) => ({ id: p.id, reason: 'Fair enough.' })),
      })}`;
    }
    const fixed = prior.filter((p) => p.status === 'fixed').map((p) => p.id);
    const disputed = prior.filter((p) => p.status === 'disputed').map((p) => ({ id: p.id, reason: 'Fair point — the request specifies the exact format.' }));
    return `The validation fix is correct and tested. I accept the developer's argument on the greeting format. Approving.\n\n${block({
      verdict: 'approve', summary: 'Ready to merge.', findings: [], resolved: fixed, withdrawn: disputed,
    })}`;
  }
}
