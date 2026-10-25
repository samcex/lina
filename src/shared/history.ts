import { viewFromSnapshot, type SessionView } from './reducer.js';
import type { AgentId, AnyLinaEvent } from './types.js';

/** Prepend persisted history without replaying old status over current live state. */
export function prependHistory(view: SessionView, events: AnyLinaEvent[]): SessionView {
  const first = view.timeline.find((e) => e.seq > 0)?.seq ?? view.lastSeq + 1;
  const older = events.filter((e) => e.sessionId === view.session.id && e.seq > 0 && e.seq < first);
  if (!older.length) return view;
  const bySeq = new Map(older.map((e) => [e.seq, e]));
  for (const e of view.timeline) bySeq.set(e.seq, e);
  const timeline = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  const rebuilt = viewFromSnapshot({
    session: view.session, project: view.project, events: timeline,
    findings: view.findings, live: { agents: { codex: view.agents.codex, claude: view.agents.claude }, streams: {}, rateLimits: {} },
  });
  const agents = { ...view.agents };
  for (const id of ['codex', 'claude'] as AgentId[]) {
    const activity = new Map(rebuilt.agents[id].activity.map((a) => [a.key, a]));
    // Ephemeral activity may be newer than its last persisted update.
    for (const a of view.agents[id].activity) activity.set(a.key, a);
    agents[id] = { ...view.agents[id], activity: [...activity.values()].sort((a, b) => a.ts - b.ts).slice(-300) };
  }
  return { ...view, timeline, tests: rebuilt.tests, agents };
}
