// Pure reducer that folds LINA events into a view model. Used by both the TUI
// and the web UI so they always show the same state for the same event log.
import type {
  AgentId, AgentStatus, AnyLinaEvent, Finding, LinaEvent, LiveState, Mode, Phase, Project, RateLimitInfo, Role,
  Session, SessionConfig, SessionSnapshot, TestRun,
} from './types.js';
import { AGENT_IDS, byAgent, teamOf } from './types.js';

export interface ActivityItem {
  key: string; // agent:id
  agent: AgentId | 'lina';
  id: string;
  kind: LinaEvent<'activity'>['data']['kind'];
  title: string;
  detail?: string;
  state: 'running' | 'ok' | 'error';
  exitCode?: number | null;
  output?: string;
  files?: string[];
  source: 'observed' | 'narrated';
  ts: number;
}

export interface AgentView {
  status: AgentStatus;
  detail?: string;
  role?: Role;
  since: number;
  model?: string;
  activity: ActivityItem[]; // newest last, capped
}

export interface SessionView {
  session: Session;
  project: Project;
  /** Persisted events in seq order (messages, phases, reviews, tests…). */
  timeline: AnyLinaEvent[];
  lastSeq: number;
  agents: Record<AgentId, AgentView>;
  streams: Record<string, { agent: AgentId; text: string }>;
  findings: Finding[];
  tests: TestRun[];
  rateLimits: Partial<Record<AgentId, RateLimitInfo>>;
  phase: Phase;
  round: number;
}

const ACTIVITY_CAP = 300;

const emptyAgent = (): AgentView => ({ status: 'idle', since: Date.now(), activity: [] });

export function viewFromSnapshot(snap: SessionSnapshot): SessionView {
  let v: SessionView = {
    session: snap.session,
    project: snap.project,
    timeline: [],
    lastSeq: 0,
    agents: byAgent(() => emptyAgent()),
    streams: { ...snap.live.streams },
    findings: snap.findings,
    tests: [],
    rateLimits: { ...snap.live.rateLimits },
    phase: snap.session.phase,
    round: snap.session.round,
  };
  for (const e of snap.events) v = applyEvent(v, e);
  v = applyLive(v, snap.live);
  v.session = snap.session;
  v.phase = snap.session.phase;
  v.round = snap.session.round;
  return v;
}

function applyLive(v: SessionView, live: LiveState): SessionView {
  const agents = { ...v.agents };
  for (const id of Object.keys(live.agents) as AgentId[]) {
    const a = live.agents[id];
    agents[id] = { ...agents[id], status: a.status, detail: a.detail, role: a.role, since: a.since, model: a.model ?? agents[id].model };
  }
  return { ...v, agents };
}

/** Returns a new view (immutable update) with the event applied. Idempotent for persisted events. */
export function applyEvent(v: SessionView, e: AnyLinaEvent): SessionView {
  if (e.seq > 0) {
    if (e.seq <= v.lastSeq) return v; // duplicate / replay
    v = { ...v, lastSeq: e.seq, timeline: [...v.timeline, e] };
  }
  switch (e.type) {
    case 'session.updated':
      return { ...v, session: e.data.session, phase: e.data.session.phase, round: e.data.session.round };
    case 'phase':
      return { ...v, phase: e.data.phase, round: e.data.round };
    case 'agent.status': {
      const a = v.agents[e.data.agent] ?? emptyAgent();
      return { ...v, agents: { ...v.agents, [e.data.agent]: { ...a, status: e.data.status, detail: e.data.detail, role: e.data.role ?? a.role, since: e.ts } } };
    }
    case 'turn': {
      const a = v.agents[e.data.agent] ?? emptyAgent();
      return { ...v, agents: { ...v.agents, [e.data.agent]: { ...a, model: e.data.model || a.model, role: e.data.role } } };
    }
    case 'activity': {
      const d = e.data;
      const owner: AgentId = d.agent === 'lina' ? (AGENT_IDS.includes(e.actor as AgentId) ? (e.actor as AgentId) : AGENT_IDS[0]) : d.agent;
      if (d.agent === 'lina') return v; // LINA's own activity shows in the timeline (tests/git), not agent panels
      const a = v.agents[owner] ?? emptyAgent();
      const key = `${d.agent}:${d.id}`;
      const item: ActivityItem = { key, agent: d.agent, id: d.id, kind: d.kind, title: d.title, detail: d.detail, state: d.state, exitCode: d.exitCode, output: d.output, files: d.files, source: d.source, ts: e.ts };
      const idx = a.activity.findIndex((x) => x.key === key);
      const list = idx >= 0 ? a.activity.map((x, i) => (i === idx ? { ...x, ...item, ts: x.ts } : x)) : [...a.activity, item].slice(-ACTIVITY_CAP);
      return { ...v, agents: { ...v.agents, [owner]: { ...a, activity: list } } };
    }
    case 'stream': {
      const cur = v.streams[e.data.msgId];
      return { ...v, streams: { ...v.streams, [e.data.msgId]: { agent: e.data.agent, text: (cur?.text ?? '') + e.data.delta } } };
    }
    case 'stream.end':
    case 'message': {
      const id = e.type === 'message' ? e.data.id : e.data.msgId;
      if (!(id in v.streams)) return v;
      const streams = { ...v.streams };
      delete streams[id];
      return { ...v, streams };
    }
    case 'review':
    case 'findings':
      return { ...v, findings: e.data.findings };
    case 'tests':
      return { ...v, tests: [...v.tests, e.data] };
    case 'usage':
      return e.data.rateLimit ? { ...v, rateLimits: { ...v.rateLimits, [e.data.agent]: e.data.rateLimit } } : v;
    default:
      return v;
  }
}

/** Human labels for statuses (shared wording across UIs). */
export const STATUS_LABEL: Record<AgentStatus, string> = {
  idle: 'Idle', thinking: 'Thinking', reading: 'Reading files', writing: 'Writing code', running: 'Running command',
  testing: 'Running tests', reviewing: 'Reviewing', waiting: 'Waiting', done: 'Completed', error: 'Error',
};

export const PHASE_LABEL: Record<Phase, string> = {
  idle: 'Ready', planning: 'Planning', plan_review: 'Plan review', implementing: 'Implementing', testing: 'Testing',
  reviewing: 'Reviewing', revising: 'Revising', integrating: 'Integrating', verifying: 'Verifying', awaiting_approval: 'Awaiting your approval',
  consulting: 'Chatting', completed: 'Completed', approved: 'Approved', rejected: 'Rejected', cancelled: 'Cancelled', failed: 'Failed',
  interrupted: 'Interrupted',
};

/** Ordered pipeline used by progress rails in both UIs (pair mode). Prefer pipelineFor(config). */
export const PIPELINE: Phase[] = ['planning', 'implementing', 'testing', 'reviewing', 'revising', 'verifying', 'awaiting_approval'];

/** The phases a session of this configuration goes through, in order. */
export function pipelineFor(cfg: Pick<SessionConfig, 'mode' | 'developer' | 'reviewer' | 'team' | 'workspaceMode' | 'interactionMode'>): Phase[] {
  if (cfg.workspaceMode === 'direct' && cfg.interactionMode !== 'workflow') return ['consulting'];
  if (cfg.mode === 'parallel') return ['planning', 'implementing', 'integrating', 'testing', 'reviewing', 'revising', 'verifying', 'awaiting_approval'];
  if (cfg.mode === 'compete') return ['implementing', 'testing', 'reviewing', 'revising', 'verifying', 'awaiting_approval'];
  const t = teamOf(cfg);
  const p: Phase[] = [];
  if (t.planner) p.push('planning');
  if (t.planCritic) p.push('plan_review');
  p.push('implementing', 'testing');
  if (t.reviewers.length) p.push('reviewing', 'revising');
  p.push('verifying');
  if (cfg.workspaceMode !== 'direct') p.push('awaiting_approval');
  return p;
}

export const MODE_LABEL: Record<Mode, string> = {
  pair: 'Developer + Reviewer', architect: 'Architect', solo: 'Solo', parallel: 'Parallel', compete: 'Competition', custom: 'Custom team',
};
export const MODE_DESCRIPTION: Record<Mode, string> = {
  pair: 'One agent implements, the other reviews; they iterate until the reviewer approves.',
  architect: 'Like Developer + Reviewer, but the reviewer critiques the plan before any code is written.',
  solo: 'One agent implements and LINA verifies the tests. No review.',
  parallel: 'The lead splits the task; every agent builds a part at the same time; LINA merges; each cross-reviews another part.',
  compete: 'Both agents build the whole task independently, then review each other\'s version. You pick the winner.',
  custom: 'You choose who plans, who critiques the plan, who implements and who reviews.',
};
