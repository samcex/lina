import type { AnyLinaEvent, Finding, Project, Session, SessionSnapshot } from '../../src/shared/types.js';

const T0 = Date.UTC(2026, 0, 2, 10, 0, 0);

export const project: Project = {
  id: 'p1', name: 'acme-web', path: '/tmp/acme-web', createdAt: T0, updatedAt: T0,
  settings: { network: false, maxRounds: 3, defaultMode: 'pair' },
};

const usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: 0, turns: 0 };

export const session: Session = {
  id: 'sess_0123456789', projectId: 'p1', title: 'Build a modern dashboard', status: 'running', phase: 'reviewing', round: 2,
  createdAt: T0, updatedAt: T0 + 60_000,
  config: { mode: 'pair', developer: 'codex', reviewer: 'claude', models: { codex: { model: 'gpt-6.1-sol', effort: 'medium' }, claude: { model: 'opus' }, freebuff: { model: 'auto' } }, maxRounds: 3, network: false, mock: true },
  workspacePath: '/tmp/ws', branch: 'lina/sess_012', baseCommit: 'aaaaaaa', usage: { codex: usage, claude: usage, freebuff: usage }, lastSeq: 9, pendingMessages: 1, mock: true,
};

export const findings: Finding[] = [
  { id: 'F1', severity: 'blocker', title: 'SQL injection in search', detail: 'User input is concatenated into the query.', file: 'src/db.ts', line: 42, status: 'open', raisedBy: 'claude', round: 2, history: [] },
  { id: 'F2', severity: 'minor', title: 'Missing aria-label', detail: 'Buttons need labels.', status: 'escalated', raisedBy: 'claude', round: 1, history: [{ round: 1, actor: 'codex', action: 'disputed', note: 'decorative', ts: T0 }] },
  { id: 'F3', severity: 'nit', title: 'Naming', detail: 'Rename x.', status: 'resolved', raisedBy: 'claude', round: 1, history: [] },
];

let seq = 0;
const ev = (type: AnyLinaEvent['type'], actor: AnyLinaEvent['actor'], data: unknown, dt = 0): AnyLinaEvent =>
  ({ sessionId: session.id, seq: ++seq, ts: T0 + dt, type, actor, data } as AnyLinaEvent);

export function snapshot(): SessionSnapshot {
  seq = 0;
  const events: AnyLinaEvent[] = [
    ev('message', 'user', { id: 'm1', text: 'Build a modern dashboard', kind: 'chat' }),
    ev('phase', 'lina', { phase: 'implementing', round: 1 }, 1000),
    ev('message', 'codex', { id: 'm2', text: '## Plan\n\n- Add **charts** with `recharts`\n- Wire the API\n\n```ts\nconst total = items.reduce((a, b) => a + b, 0);\n```', kind: 'plan', role: 'developer', model: 'gpt-6.1-sol' }, 2000),
    ev('activity', 'codex', { agent: 'codex', id: 'a1', kind: 'command', title: 'npm test', state: 'error', exitCode: 1, source: 'observed' }, 3000),
    ev('checkpoint', 'lina', { commit: 'abcdef1234', message: 'Implement dashboard', files: [{ path: 'src/Dashboard.tsx', additions: 120, deletions: 3, status: 'added' }] }, 4000),
    ev('tests', 'lina', { command: 'npm test', exitCode: 0, ok: true, durationMs: 4200, passed: 12, failed: 0, output: 'ok', sandboxed: true }, 5000),
    ev('review', 'claude', { round: 2, reviewer: 'claude', verdict: 'request_changes', summary: 'Two issues remain.', findings }, 6000),
    ev('error', 'lina', { agent: 'claude', code: 'rate_limited', message: 'Rate limit reached', hint: 'Wait a few minutes' }, 7000),
    ev('approval', 'lina', { state: 'requested', summary: 'Dashboard implemented; **12 tests** pass.', unresolved: [findings[1]] }, 8000),
  ];
  return {
    session, project, events, findings,
    live: {
      agents: {
        codex: { status: 'writing', detail: 'src/App.tsx', role: 'developer', since: T0, model: 'gpt-6.1-sol' },
        claude: { status: 'reviewing', role: 'reviewer', since: T0, model: 'opus' },
        freebuff: { status: 'idle', since: T0 },
      },
      streams: { s1: { agent: 'claude', text: 'Looking at the **diff** now' } },
      rateLimits: { claude: { windows: { five_hour: { utilization: 0.42 } }, observedAt: T0 } },
    },
  };
}

export function narratedActivity(): AnyLinaEvent {
  return { sessionId: session.id, seq: 100, ts: T0 + 9000, type: 'activity', actor: 'claude', data: { agent: 'claude', id: 'n1', kind: 'note', title: 'I will check the query builder', state: 'ok', source: 'narrated' } } as AnyLinaEvent;
}
