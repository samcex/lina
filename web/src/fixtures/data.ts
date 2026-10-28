// Handcrafted, realistic LINA data for rendering the UI without a daemon (?fixture=1).
import type {
  Actor, AgentId, AgentModels, AnyLinaEvent, DiffFile, DoctorCheck, EventDataMap, EventType, Finding, Project, Session,
  SessionSnapshot, Settings, TreeEntry, UsageTotals,
} from '@shared/types';
import { DEFAULT_SETTINGS, byAgent, zeroUsage } from '@shared/types';

const MIN = 60_000;
export const T0 = Date.now() - 46 * MIN;

export function mkEvents(sessionId: string) {
  let seq = 0;
  const list: AnyLinaEvent[] = [];
  const ev = <T extends EventType>(type: T, actor: Actor, data: EventDataMap[T], atMin: number) => {
    const e = { sessionId, seq: ++seq, ts: T0 + atMin * MIN, type, actor, data } as unknown as AnyLinaEvent;
    list.push(e);
    return e;
  };
  return { list, ev };
}

export const usage = (i: number, o: number, c: number, cost: number, turns: number): UsageTotals => ({ inputTokens: i, outputTokens: o, cachedInputTokens: c, costUsd: cost, turns });

export const PROJECTS: Project[] = [
  { id: 'prj_atlas', name: 'atlas-api', path: '/home/sam/code/atlas-api', createdAt: T0 - 9 * 864e5, updatedAt: T0, settings: { network: false, maxRounds: 3, defaultMode: 'pair', testCommand: 'npm test' } },
  { id: 'prj_lumen', name: 'lumen-web', path: '/home/sam/code/lumen-web', createdAt: T0 - 30 * 864e5, updatedAt: T0 - 864e5, settings: { network: false, maxRounds: 3, defaultMode: 'architect' } },
  { id: 'prj_tide', name: 'tide-cli', path: '/home/sam/code/tide-cli', createdAt: T0 - 60 * 864e5, updatedAt: T0 - 5 * 864e5, settings: { network: true, maxRounds: 2, defaultMode: 'solo' } },
];

export function baseSession(id: string, projectId: string, title: string, over: Partial<Session> = {}): Session {
  return {
    id, projectId, title, status: 'idle', phase: 'idle', round: 0, createdAt: T0, updatedAt: T0 + 40 * MIN,
    config: { mode: 'pair', developer: 'codex', reviewer: 'claude', models: { codex: { model: 'gpt-6.1-sol', effort: 'medium' }, claude: { model: 'opus' }, freebuff: { model: 'auto' } }, maxRounds: 3, network: false },
    workspacePath: `/home/sam/.lina/workspaces/${id}`, branch: `lina/${id.slice(4, 10)}`, baseCommit: '9f3c2a1d7e', headCommit: undefined,
    usage: zeroUsage(), lastSeq: 0, pendingMessages: 0, ...over,
  };
}

export const F = (f: Partial<Finding> & Pick<Finding, 'id' | 'severity' | 'title' | 'status' | 'round'>): Finding => ({ detail: '', raisedBy: 'claude', history: [], ...f });

const RATE_LIMIT_TS = `import type { Request, Response, NextFunction } from 'express';

export interface RateLimitOptions {
  windowMs: number;
  max: number;
  /** Cap on tracked keys so a flood of unique IPs can't exhaust memory. */
  maxKeys?: number;
}

interface Bucket { count: number; resetAt: number }

export function rateLimit({ windowMs, max, maxKeys = 10_000 }: RateLimitOptions) {
  const buckets = new Map<string, Bucket>();

  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    const key = req.ip ?? 'unknown';
    let b = buckets.get(key);
    if (!b || b.resetAt <= now) {
      if (buckets.size >= maxKeys) evictExpired(buckets, now);
      b = { count: 0, resetAt: now + windowMs };
      buckets.set(key, b);
    }
    b.count++;
    if (b.count > max) {
      res.setHeader('Retry-After', Math.ceil((b.resetAt - now) / 1000));
      return res.status(429).json({ error: 'too_many_attempts' });
    }
    next();
  };
}

function evictExpired(buckets: Map<string, Bucket>, now: number) {
  for (const [k, v] of buckets) if (v.resetAt <= now) buckets.delete(k);
}
`;

export const FILES: Record<string, string> = {
  'src/middleware/rateLimit.ts': RATE_LIMIT_TS,
  'src/routes/auth.ts': `import { Router } from 'express';
import { rateLimit } from '../middleware/rateLimit';
import { LOGIN_WINDOW_MS, LOGIN_MAX_ATTEMPTS } from '../config/limits';
import { loginHandler } from '../handlers/login';

export const auth = Router();

auth.post('/login', rateLimit({ windowMs: LOGIN_WINDOW_MS, max: LOGIN_MAX_ATTEMPTS }), loginHandler);
auth.post('/logout', (req, res) => { req.session?.destroy(() => res.status(204).end()); });
`,
  'src/config/limits.ts': `export const LOGIN_WINDOW_MS = 15 * 60 * 1000;\nexport const LOGIN_MAX_ATTEMPTS = 5;\n`,
  'test/rateLimit.test.ts': `import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { makeApp } from './helpers';

describe('POST /login rate limit', () => {
  it('allows 5 attempts then returns 429', async () => {
    const app = makeApp();
    for (let i = 0; i < 5; i++) await request(app).post('/login').send({}).expect(401);
    const res = await request(app).post('/login').send({});
    expect(res.status).toBe(429);
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('resets after the window', async () => {
    vi.useFakeTimers();
    const app = makeApp();
    for (let i = 0; i < 6; i++) await request(app).post('/login').send({});
    vi.advanceTimersByTime(15 * 60 * 1000 + 1);
    await request(app).post('/login').send({}).expect(401);
  });
});
`,
  'README.md': '# atlas-api\n\nAuth & billing API for Atlas.\n\n```bash\nnpm install\nnpm test\n```\n',
  'package.json': '{\n  "name": "atlas-api",\n  "version": "2.4.0",\n  "scripts": { "test": "vitest run", "dev": "tsx watch src/index.ts" }\n}\n',
};

export const TREE: TreeEntry[] = [
  ...['src', 'src/config', 'src/handlers', 'src/middleware', 'src/routes', 'test'].map((p) => ({ path: p, type: 'dir' as const })),
  { path: 'README.md', type: 'file', size: 214 }, { path: 'package.json', type: 'file', size: 812 }, { path: 'tsconfig.json', type: 'file', size: 340 },
  { path: 'src/index.ts', type: 'file', size: 1290 }, { path: 'src/app.ts', type: 'file', size: 2210 },
  { path: 'src/config/limits.ts', type: 'file', size: 96, changed: true },
  { path: 'src/handlers/login.ts', type: 'file', size: 1740 }, { path: 'src/handlers/billing.ts', type: 'file', size: 4120 },
  { path: 'src/middleware/rateLimit.ts', type: 'file', size: 1180, changed: true }, { path: 'src/middleware/session.ts', type: 'file', size: 980 },
  { path: 'src/routes/auth.ts', type: 'file', size: 420, changed: true }, { path: 'src/routes/billing.ts', type: 'file', size: 760 },
  { path: 'test/helpers.ts', type: 'file', size: 610 }, { path: 'test/login.test.ts', type: 'file', size: 2300 },
  { path: 'test/rateLimit.test.ts', type: 'file', size: 890, changed: true },
];

export const addPatch = (text: string) => `@@ -0,0 +1,${text.split('\n').length - 1} @@\n` + text.replace(/\n$/, '').split('\n').map((l) => '+' + l).join('\n');

export const DIFF: DiffFile[] = [
  { path: 'src/middleware/rateLimit.ts', status: 'added', additions: 35, deletions: 0, patch: addPatch(RATE_LIMIT_TS) },
  {
    path: 'src/routes/auth.ts', status: 'modified', additions: 4, deletions: 1, patch: `@@ -1,7 +1,10 @@
 import { Router } from 'express';
+import { rateLimit } from '../middleware/rateLimit';
+import { LOGIN_WINDOW_MS, LOGIN_MAX_ATTEMPTS } from '../config/limits';
 import { loginHandler } from '../handlers/login';

 export const auth = Router();

-auth.post('/login', loginHandler);
+auth.post('/login', rateLimit({ windowMs: LOGIN_WINDOW_MS, max: LOGIN_MAX_ATTEMPTS }), loginHandler);
+// TODO(lina): revisit trust proxy if deployed behind a load balancer
 auth.post('/logout', (req, res) => { req.session?.destroy(() => res.status(204).end()); });`,
  },
  { path: 'src/config/limits.ts', status: 'added', additions: 2, deletions: 0, patch: addPatch(FILES['src/config/limits.ts']) },
  { path: 'test/rateLimit.test.ts', status: 'added', additions: 24, deletions: 0, patch: addPatch(FILES['test/rateLimit.test.ts']) },
];

const REVIEW_1 = `I read the new middleware and the route wiring. The approach is sound, but there are a few problems before this can ship.

The most serious one: the \`buckets\` map is never pruned, so a scan from many unique IPs grows memory without bound.

\`\`\`lina-review
{"verdict":"request_changes","findings":[{"id":"F1","severity":"blocker"}]}
\`\`\``;

export function mainFixture(): SessionSnapshot {
  const sid = 'ses_fixture';
  const { list, ev } = mkEvents(sid);

  ev('message', 'user', { id: 'm1', kind: 'chat', text: 'Add rate limiting to `POST /login`: at most **5 attempts per IP per 15 minutes**, respond `429` with a `Retry-After` header. Include tests.' }, 0);
  ev('phase', 'lina', { phase: 'planning', round: 0 }, 0.1);
  ev('turn', 'codex', { agent: 'codex', state: 'start', role: 'developer', phase: 'planning', model: 'gpt-6.1-sol' }, 0.1);
  ev('activity', 'codex', { agent: 'codex', id: 'a1', kind: 'read', title: 'src/routes/auth.ts', state: 'ok', source: 'observed' }, 0.3);
  ev('activity', 'codex', { agent: 'codex', id: 'a2', kind: 'command', title: 'rg -n "loginHandler" src', state: 'ok', exitCode: 0, output: 'src/routes/auth.ts:3:import { loginHandler } from \'../handlers/login\';\nsrc/routes/auth.ts:7:auth.post(\'/login\', loginHandler);', source: 'observed' }, 0.4);
  ev('activity', 'codex', { agent: 'codex', id: 'a3', kind: 'note', title: 'Checking how the auth router is wired before proposing a plan.', state: 'ok', source: 'narrated' }, 0.5);
  ev('message', 'codex', { id: 'm2', kind: 'plan', role: 'developer', model: 'gpt-6.1-sol', text: `Plan:\n\n1. Add a small in-memory \`rateLimit({ windowMs, max })\` middleware in \`src/middleware/rateLimit.ts\` — no new dependency.\n2. Mount it on \`POST /login\` only, with limits in \`src/config/limits.ts\`.\n3. On overflow return **429** + \`Retry-After\` (seconds).\n4. Tests with supertest: the 6th attempt is rejected; the window resets.` }, 1.2);
  ev('turn', 'codex', { agent: 'codex', state: 'end', role: 'developer', phase: 'planning', model: 'gpt-6.1-sol', ok: true, durationMs: 68_000 }, 1.2);

  ev('phase', 'lina', { phase: 'implementing', round: 1 }, 1.4);
  ev('activity', 'codex', { agent: 'codex', id: 'a4', kind: 'command', title: 'npm ls express-rate-limit', state: 'error', exitCode: 1, output: 'atlas-api@2.4.0 /work\n└── (empty)', source: 'observed' }, 1.8);
  ev('activity', 'codex', { agent: 'codex', id: 'a5', kind: 'note', title: 'No limiter installed — writing a minimal one instead of adding a dependency.', state: 'ok', source: 'narrated' }, 1.9);
  ev('activity', 'codex', { agent: 'codex', id: 'a6', kind: 'write', title: 'src/middleware/rateLimit.ts', state: 'ok', files: ['src/middleware/rateLimit.ts'], source: 'observed' }, 3.1);
  ev('activity', 'codex', { agent: 'codex', id: 'a7', kind: 'edit', title: 'src/routes/auth.ts', state: 'ok', files: ['src/routes/auth.ts'], source: 'observed' }, 3.4);
  ev('activity', 'codex', { agent: 'codex', id: 'a8', kind: 'write', title: 'test/rateLimit.test.ts', state: 'ok', files: ['test/rateLimit.test.ts'], source: 'observed' }, 4.2);
  ev('message', 'codex', { id: 'm3', kind: 'chat', role: 'developer', model: 'gpt-6.1-sol', text: "Implemented. The middleware keeps one bucket per IP:\n\n```ts\nexport function rateLimit({ windowMs, max }: RateLimitOptions) {\n  const buckets = new Map<string, Bucket>();\n  return (req: Request, res: Response, next: NextFunction) => {\n    const now = Date.now();\n    let b = buckets.get(req.ip);\n    if (!b || b.resetAt <= now) buckets.set(req.ip, (b = { count: 0, resetAt: now + windowMs }));\n    if (++b.count > max) {\n      res.setHeader('Retry-After', (b.resetAt - now) / 1000);\n      return res.status(429).json({ error: 'too_many_attempts' });\n    }\n    next();\n  };\n}\n```\n\nWired on `POST /login` in `src/routes/auth.ts:7`." }, 4.6);
  ev('checkpoint', 'lina', { commit: 'a41c9e07b2', message: 'Round 1: rate limiter + tests', files: [{ path: 'src/middleware/rateLimit.ts', additions: 28, deletions: 0, status: 'A' }, { path: 'src/routes/auth.ts', additions: 2, deletions: 1, status: 'M' }, { path: 'test/rateLimit.test.ts', additions: 24, deletions: 0, status: 'A' }] }, 4.7);
  ev('phase', 'lina', { phase: 'testing', round: 1 }, 4.8);
  ev('tests', 'lina', { command: 'npm test', exitCode: 1, ok: false, durationMs: 8_420, passed: 23, failed: 1, sandboxed: true, output: ' ✓ test/login.test.ts (12)\n ✓ test/billing.test.ts (11)\n ✗ test/rateLimit.test.ts > POST /login rate limit > allows 5 attempts then returns 429\n   AssertionError: expected 1.0 to be an integer (Retry-After)\n\n Test Files  1 failed | 2 passed (3)\n      Tests  1 failed | 23 passed (24)' }, 5.0);

  ev('phase', 'lina', { phase: 'reviewing', round: 1 }, 5.1);
  ev('error', 'lina', { agent: 'claude', code: 'timeout', message: 'Review turn produced no output for 10 minutes.', hint: 'LINA killed the process group and retried once automatically.' }, 5.3);
  ev('message', 'lina', { id: 'n1', kind: 'notice', text: 'Retrying the review turn (attempt 2 of 2).' }, 5.4);
  ev('activity', 'claude', { agent: 'claude', id: 'b1', kind: 'command', title: 'git diff 9f3c2a1..HEAD --stat', state: 'ok', exitCode: 0, output: ' src/middleware/rateLimit.ts | 28 ++++\n src/routes/auth.ts          |  3 +-\n test/rateLimit.test.ts      | 24 +++\n 3 files changed, 54 insertions(+), 1 deletion(-)', source: 'observed' }, 5.6);
  ev('activity', 'claude', { agent: 'claude', id: 'b2', kind: 'read', title: 'src/middleware/rateLimit.ts', state: 'ok', source: 'observed' }, 5.8);
  ev('activity', 'claude', { agent: 'claude', id: 'b3', kind: 'note', title: 'The limiter keys on req.ip — checking whether trust proxy is configured.', state: 'ok', source: 'narrated' }, 6.0);
  ev('activity', 'claude', { agent: 'claude', id: 'b4', kind: 'command', title: "grep -n 'trust proxy' src/app.ts", state: 'error', exitCode: 1, output: '', source: 'observed' }, 6.1);
  ev('message', 'claude', { id: 'm4', kind: 'review', role: 'reviewer', model: 'claude-opus-5-5', text: REVIEW_1 }, 7.0);

  const f1 = F({ id: 'F1', severity: 'blocker', title: 'Unbounded bucket map grows with every unique IP', detail: 'buckets is never pruned. A scan from many source IPs grows memory without bound and can take the process down.', file: 'src/middleware/rateLimit.ts', line: 12, suggestion: 'Evict expired buckets, and cap the number of tracked keys.', status: 'open', round: 1 });
  const f2 = F({ id: 'F2', severity: 'major', title: 'req.ip is the proxy address behind a load balancer', detail: "Without app.set('trust proxy', …) every client behind the LB shares one bucket, so one attacker locks everyone out.", file: 'src/app.ts', line: 14, suggestion: "Configure trust proxy for the known LB hop count.", status: 'open', round: 1 });
  const f3 = F({ id: 'F3', severity: 'minor', title: 'Retry-After must be an integer number of seconds', detail: 'RFC 9110 requires delay-seconds as a non-negative integer; the failing test catches this.', file: 'src/middleware/rateLimit.ts', line: 21, status: 'open', round: 1 });
  const f4 = F({ id: 'F4', severity: 'nit', title: 'Magic numbers in the route', detail: 'Move 5 / 15 min into config so they are discoverable.', file: 'src/routes/auth.ts', line: 7, status: 'open', round: 1 });
  ev('review', 'claude', { round: 1, reviewer: 'claude', verdict: 'request_changes', summary: 'Sound approach; one blocker (memory growth), a proxy-related correctness issue, and the Retry-After format.', findings: [f1, f2, f3, f4] }, 7.0);

  ev('phase', 'lina', { phase: 'revising', round: 1 }, 7.2);
  ev('response', 'codex', { round: 1, developer: 'codex', items: [
    { id: 'F1', action: 'fixed', note: 'Expired buckets are evicted and tracked keys are capped (maxKeys, default 10k).' },
    { id: 'F2', action: 'disputed', note: "atlas-api is deployed without a proxy (see DEPLOY.md). Enabling trust proxy would let clients spoof X-Forwarded-For and bypass the limit entirely." },
    { id: 'F3', action: 'fixed', note: 'Math.ceil(...) seconds.' },
    { id: 'F4', action: 'fixed', note: 'Moved to src/config/limits.ts.' },
  ] }, 9.5);
  ev('activity', 'codex', { agent: 'codex', id: 'a9', kind: 'edit', title: 'src/middleware/rateLimit.ts', state: 'ok', files: ['src/middleware/rateLimit.ts'], source: 'observed' }, 9.0);
  ev('activity', 'codex', { agent: 'codex', id: 'a10', kind: 'write', title: 'src/config/limits.ts', state: 'ok', files: ['src/config/limits.ts'], source: 'observed' }, 9.2);
  ev('checkpoint', 'lina', { commit: 'c7d02b5e19', message: 'Round 1 revisions: eviction, integer Retry-After, config', files: [{ path: 'src/middleware/rateLimit.ts', additions: 9, deletions: 2, status: 'M' }, { path: 'src/config/limits.ts', additions: 2, deletions: 0, status: 'A' }, { path: 'src/routes/auth.ts', additions: 2, deletions: 1, status: 'M' }] }, 9.6);
  ev('tests', 'lina', { command: 'npm test', exitCode: 0, ok: true, durationMs: 7_960, passed: 25, failed: 0, sandboxed: true, output: ' ✓ test/login.test.ts (12)\n ✓ test/billing.test.ts (11)\n ✓ test/rateLimit.test.ts (2)\n\n Test Files  3 passed (3)\n      Tests  25 passed (25)' }, 9.8);

  ev('phase', 'lina', { phase: 'reviewing', round: 2 }, 10);
  const f5 = F({ id: 'F5', severity: 'minor', title: 'No test covers the window reset', detail: 'Only the 429 path is tested.', file: 'test/rateLimit.test.ts', status: 'open', round: 2 });
  ev('review', 'claude', { round: 2, reviewer: 'claude', verdict: 'request_changes', summary: 'F1, F3, F4 confirmed. I still think F2 matters: DEPLOY.md mentions a Fly.io proxy in front of the app.', findings: [{ ...f1, status: 'resolved' }, { ...f2, status: 'open' }, { ...f3, status: 'resolved' }, { ...f4, status: 'resolved' }, f5] }, 12);
  ev('phase', 'lina', { phase: 'revising', round: 2 }, 12.2);
  ev('response', 'codex', { round: 2, developer: 'codex', items: [
    { id: 'F2', action: 'disputed', note: "Fly's proxy is a single known hop — but trusting it is an infra decision. I'd rather not guess the hop count in app code." },
    { id: 'F5', action: 'disputed', note: "Already covered: 'resets after the window' in test/rateLimit.test.ts:16 uses fake timers." },
  ] }, 13.5);

  ev('phase', 'lina', { phase: 'reviewing', round: 3 }, 14);
  const hist = (id: string) => ({
    F1: [{ round: 1, actor: 'claude' as const, action: 'raised', note: 'Map never pruned.', ts: T0 + 7 * MIN }, { round: 1, actor: 'codex' as const, action: 'fixed', note: 'Eviction + maxKeys cap.', ts: T0 + 9.5 * MIN }, { round: 2, actor: 'claude' as const, action: 'resolved', ts: T0 + 12 * MIN }],
    F2: [
      { round: 1, actor: 'claude' as const, action: 'raised', note: 'req.ip is the LB address.', ts: T0 + 7 * MIN },
      { round: 1, actor: 'codex' as const, action: 'disputed', note: 'No proxy in prod; trust proxy enables XFF spoofing.', ts: T0 + 9.5 * MIN },
      { round: 2, actor: 'claude' as const, action: 'maintained', note: 'DEPLOY.md mentions a Fly.io proxy.', ts: T0 + 12 * MIN },
      { round: 2, actor: 'codex' as const, action: 'disputed', note: 'Hop count is an infra decision.', ts: T0 + 13.5 * MIN },
      { round: 3, actor: 'lina' as const, action: 'escalated', note: 'Disputed twice and maintained — the owner decides.', ts: T0 + 15 * MIN },
    ],
    F3: [{ round: 1, actor: 'claude' as const, action: 'raised', ts: T0 + 7 * MIN }, { round: 1, actor: 'codex' as const, action: 'fixed', note: 'Math.ceil seconds.', ts: T0 + 9.5 * MIN }, { round: 2, actor: 'claude' as const, action: 'resolved', ts: T0 + 12 * MIN }],
    F4: [{ round: 1, actor: 'claude' as const, action: 'raised', ts: T0 + 7 * MIN }, { round: 1, actor: 'codex' as const, action: 'fixed', ts: T0 + 9.5 * MIN }, { round: 2, actor: 'claude' as const, action: 'resolved', ts: T0 + 12 * MIN }],
    F5: [{ round: 2, actor: 'claude' as const, action: 'raised', ts: T0 + 12 * MIN }, { round: 2, actor: 'codex' as const, action: 'disputed', note: 'Covered by test/rateLimit.test.ts:16.', ts: T0 + 13.5 * MIN }, { round: 3, actor: 'claude' as const, action: 'withdrawn', note: 'Correct — the fake-timer test covers it.', ts: T0 + 15 * MIN }],
  } as Record<string, Finding['history']>)[id];
  const final: Finding[] = [
    { ...f1, status: 'resolved', history: hist('F1') }, { ...f2, status: 'escalated', history: hist('F2') },
    { ...f3, status: 'resolved', history: hist('F3') }, { ...f4, status: 'resolved', history: hist('F4') }, { ...f5, status: 'withdrawn', history: hist('F5') },
  ];
  ev('message', 'claude', { id: 'm5', kind: 'review', role: 'reviewer', model: 'claude-opus-5-5', text: "You're right about **F5** — `resets after the window` covers it, withdrawn.\n\nI'm keeping **F2**: if the Fly proxy is in front, every user shares one bucket. This needs a human call." }, 15);
  ev('review', 'claude', { round: 3, reviewer: 'claude', verdict: 'approve', summary: 'Approve with F2 escalated to the owner.', findings: final }, 15);
  ev('findings', 'lina', { findings: final }, 15.1);

  ev('phase', 'lina', { phase: 'verifying', round: 3 }, 15.2);
  ev('tests', 'lina', { command: 'npm test', exitCode: 0, ok: true, durationMs: 8_110, passed: 26, failed: 0, sandboxed: true, output: ' ✓ test/login.test.ts (12)\n ✓ test/billing.test.ts (11)\n ✓ test/rateLimit.test.ts (3)\n\n Test Files  3 passed (3)\n      Tests  26 passed (26)' }, 15.5);
  const summary = `**Rate limiting for \`POST /login\`** — 5 attempts / IP / 15 min, 429 + integer \`Retry-After\`.\n\n- 4 files changed, **+67 −2** across 2 checkpoints\n- Tests: **26 passed** (verified by LINA, sandboxed)\n- Findings: 3 resolved, 1 withdrawn, **1 escalated** (F2 — trust proxy)\n- No new dependencies`;
  ev('message', 'lina', { id: 'm6', kind: 'summary', text: summary }, 15.6);
  ev('phase', 'lina', { phase: 'awaiting_approval', round: 3 }, 15.7);
  ev('approval', 'lina', { state: 'requested', summary, unresolved: [final[1]] }, 15.7);
  ev('usage', 'claude', { agent: 'claude', rateLimit: { windows: { five_hour: { utilization: 0.21, resetsAt: Math.round((Date.now() + 3.2 * 3600e3) / 1000) }, seven_day: { utilization: 0.16 } }, observedAt: Date.now() - 4 * MIN } }, 15.8);
  ev('message', 'user', { id: 'm7', kind: 'chat', mention: 'claude', text: '@claude is the proxy concern real for our Fly.io deploy? Give me the one-line config if so.' }, 44);

  const session = baseSession(sid, 'prj_atlas', 'Rate-limit the login endpoint', {
    status: 'awaiting_approval', phase: 'awaiting_approval', round: 3, lastSeq: list.length, headCommit: 'c7d02b5e19', branch: 'lina/x7k2q9',
    usage: { codex: usage(412_800, 21_340, 301_000, 2.84, 4), claude: usage(286_100, 9_870, 190_400, 1.96, 4), freebuff: usage(0, 0, 0, 0, 0) }, updatedAt: Date.now() - 1 * MIN,
  });
  return {
    session, project: PROJECTS[0], events: list, findings: final,
    live: {
      agents: {
        codex: { status: 'idle', role: 'developer', since: Date.now() - 30 * MIN, model: 'gpt-6.1-sol' },
        claude: { status: 'thinking', role: 'reviewer', since: Date.now() - 18_000, model: 'claude-opus-5-5' },
        freebuff: { status: 'idle', since: Date.now() - 30 * MIN },
      },
      streams: { s_claude_1: { agent: 'claude', text: "Short answer: **yes**, if Fly's edge proxy sits in front of the app, `req.ip` is the proxy address. Fly appends the client IP as the last hop, so trusting exactly one hop is safe:\n\n```ts\n// src/app.ts\napp.set('trust proxy', 1);\n```\n\nWith that, " } },
      rateLimits: {},
    },
  };
}

export function runningFixture(): SessionSnapshot {
  const sid = 'ses_running';
  const { list, ev } = mkEvents(sid);
  ev('message', 'user', { id: 'r1', kind: 'chat', text: 'Migrate the billing webhooks to the new Stripe event schema and keep backwards compatibility for one release.' }, 30);
  ev('phase', 'lina', { phase: 'planning', round: 0 }, 30.1);
  ev('message', 'claude', { id: 'r2', kind: 'plan', role: 'developer', model: 'claude-opus-5-5', text: '1. Introduce a versioned parser in `src/handlers/billing.ts`.\n2. Map legacy events through an adapter.\n3. Contract tests for both schemas.' }, 31);
  ev('phase', 'lina', { phase: 'implementing', round: 1 }, 31.5);
  ev('activity', 'claude', { agent: 'claude', id: 'c1', kind: 'read', title: 'src/handlers/billing.ts', state: 'ok', source: 'observed' }, 32);
  ev('activity', 'claude', { agent: 'claude', id: 'c2', kind: 'edit', title: 'src/handlers/billing.ts', state: 'ok', files: ['src/handlers/billing.ts'], source: 'observed' }, 34);
  ev('activity', 'claude', { agent: 'claude', id: 'c3', kind: 'command', title: 'npx tsc --noEmit', state: 'running', source: 'observed' }, 45.5);
  const session = baseSession(sid, 'prj_atlas', 'Stripe webhook schema migration', {
    status: 'running', phase: 'implementing', round: 1, lastSeq: list.length, updatedAt: Date.now() - 20_000, mock: true,
    config: { mode: 'architect', developer: 'claude', reviewer: 'codex', models: { codex: { model: 'gpt-6-astra', effort: 'high' }, claude: { model: 'opus' }, freebuff: { model: 'auto' } }, maxRounds: 3, network: false, mock: true },
    usage: { codex: usage(0, 0, 0, 0, 0), claude: usage(98_200, 4_100, 61_000, 0.71, 2), freebuff: usage(0, 0, 0, 0, 0) }, pendingMessages: 1,
  });
  return {
    session, project: PROJECTS[0], events: list, findings: [],
    live: {
      agents: {
        claude: { status: 'running', detail: 'npx tsc --noEmit', role: 'developer', since: Date.now() - 12_000, model: 'claude-opus-5-5' },
        codex: { status: 'waiting', role: 'reviewer', since: Date.now() - 14 * MIN, model: 'gpt-6-astra' },
        freebuff: { status: 'idle', since: Date.now() - 14 * MIN },
      },
      streams: {}, rateLimits: {},
    },
  };
}

export function sidebarSessions(): Session[] {
  const day = 864e5;
  return [
    baseSession('ses_fixture', 'prj_atlas', 'Rate-limit the login endpoint', { status: 'awaiting_approval', phase: 'awaiting_approval', updatedAt: Date.now() - 60_000 }),
    baseSession('ses_running', 'prj_atlas', 'Stripe webhook schema migration', { status: 'running', phase: 'implementing', updatedAt: Date.now() - 20_000, mock: true }),
    baseSession('ses_a3', 'prj_atlas', 'Fix flaky session cookie test', { status: 'approved', phase: 'approved', updatedAt: Date.now() - 2 * day }),
    baseSession('ses_l1', 'prj_lumen', 'Dark mode for the dashboard', { status: 'paused', phase: 'reviewing', updatedAt: Date.now() - 3 * 3600e3 }),
    baseSession('ses_l2', 'prj_lumen', 'Upgrade to React 19 compiler', { status: 'failed', phase: 'failed', updatedAt: Date.now() - 26 * 3600e3 }),
    baseSession('ses_t1', 'prj_tide', 'Add --json output to `tide status`', { status: 'idle', phase: 'idle', updatedAt: Date.now() - 5 * day }),
  ];
}

export function emptySnapshot(s: Session): SessionSnapshot {
  return { session: s, project: PROJECTS.find((p) => p.id === s.projectId)!, events: [], findings: [], live: { agents: byAgent(() => ({ status: 'idle' as const, since: Date.now() })), streams: {}, rateLimits: {} } };
}

export const MODELS: Record<AgentId, AgentModels> = {
  codex: {
    agent: 'codex', installed: true, version: '0.142.0', defaultModel: 'gpt-6.1-sol', discoveredVia: 'codex debug models',
    models: [
      { id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol', description: 'Latest workhorse model for coding and everyday work.', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultEffort: 'low', source: 'catalog', validation: { ok: true, checkedAt: Date.now() - 3 * 3600e3, resolvedModel: 'gpt-6.1-sol' } },
      { id: 'gpt-6-astra', label: 'GPT-6-Astra', description: 'Frontier intelligence for the most demanding work.', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'low', source: 'catalog' },
      { id: 'gpt-6.1-sol-mini', label: 'GPT-6.1-Sol Mini', description: 'Fast and cheap for small edits.', efforts: ['low', 'medium', 'high'], defaultEffort: 'low', source: 'catalog' },
      { id: 'gpt-5.5-codex', label: 'gpt-5.5-codex', source: 'observed' },
    ],
  },
  claude: {
    agent: 'claude', installed: true, version: '3.4.1 (Claude Code)', defaultModel: 'opus', discoveredVia: 'documented aliases',
    models: [
      { id: 'opus', label: 'Opus (alias)', description: 'Most capable — resolves to the latest Opus.', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], source: 'alias', validation: { ok: true, checkedAt: Date.now() - 86e5, resolvedModel: 'claude-opus-5-5' } },
      { id: 'sonnet', label: 'Sonnet (alias)', description: 'Fast, strong all-rounder.', efforts: ['low', 'medium', 'high'], source: 'alias' },
      { id: 'haiku', label: 'Haiku (alias)', description: 'Lightweight and quick.', source: 'alias', validation: { ok: false, checkedAt: Date.now() - 86e5, error: 'model not available on this plan', code: 'model_unavailable' } },
      { id: 'claude-opus-5-5', label: 'claude-opus-5-5', source: 'observed' },
    ],
  },
  freebuff: {
    agent: 'freebuff', installed: true, version: '0.2.34', defaultModel: 'glm-5.3-flash', discoveredVia: 'freebuff settings.json',
    models: [
      { id: 'glm-5.3-flash', label: 'glm-5.3-flash', description: 'Model selected in the Freebuff CLI (/model). LINA cannot override it per turn.', source: 'catalog' },
      { id: 'auto', label: 'auto', description: 'Use whatever model the Freebuff CLI has selected.', source: 'alias' },
    ],
  },
};

export const SETTINGS: Settings = { ...DEFAULT_SETTINGS };

export const DOCTOR: DoctorCheck[] = [
  { id: 'node', label: 'Node.js ≥ 22.5', ok: true, detail: 'v22.22.2' },
  { id: 'git', label: 'git', ok: true, detail: 'git version 2.53.0' },
  { id: 'codex', label: 'Codex CLI', ok: true, detail: 'codex-cli 0.142.0 · logged in (ChatGPT Pro)' },
  { id: 'claude', label: 'Claude Code CLI', ok: true, detail: '3.4.1 · logged in (Max subscription)' },
  { id: 'freebuff', label: 'Freebuff CLI', ok: true, detail: '0.2.34 · logged in · interactive TUI (no headless mode)', warn: true },
  { id: 'bwrap', label: 'Claude OS sandbox (bubblewrap)', ok: true, warn: true, detail: 'bwrap found but unprivileged user namespaces are restricted by AppArmor.', hint: 'sudo sysctl kernel.apparmor_restrict_unprivileged_userns=0 — or keep claudeSandbox on "auto" (disabled).' },
  { id: 'sqlite', label: 'SQLite FTS5', ok: true, detail: 'node:sqlite with FTS5' },
];
