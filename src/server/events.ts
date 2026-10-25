// EventStore: append-only per-session event log + live fan-out + LiveState.
import type {
  Actor, AgentId, AnyLinaEvent, EventDataMap, EventType, LinaEvent, LiveState, Session,
} from '../shared/types.js';
import type { Db } from './db.js';
import { redact, tail } from './agents/redact.js';
import { log } from './log.js';

export type EventListener = (e: AnyLinaEvent) => void;

const ACTIVITY_OUTPUT_MAX = 4096;

function emptyLive(): LiveState {
  const t = Date.now();
  return {
    agents: { codex: { status: 'idle', since: t }, claude: { status: 'idle', since: t } },
    streams: {},
    rateLimits: {},
  };
}

/** Deep-redacts every string in a JSON-like value. */
function redactDeep<T>(v: T): T {
  if (typeof v === 'string') return redact(v) as unknown as T;
  if (Array.isArray(v)) return v.map((x) => redactDeep(x)) as unknown as T;
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = redactDeep(x);
    return out as T;
  }
  return v;
}

export class EventStore {
  private subs = new Map<string, Set<EventListener>>();
  private globals = new Set<EventListener>();
  private lives = new Map<string, LiveState>();

  constructor(private db: Db) {}

  /** Persists an event (assigning the next seq), updates live state and broadcasts it. */
  append<T extends EventType>(sessionId: string, type: T, actor: Actor, data: EventDataMap[T]): LinaEvent<T> {
    let clean = data;
    if (type !== 'session.updated') clean = redactDeep(data);
    if (type === 'activity') {
      const a = clean as EventDataMap['activity'];
      if (a.output && a.output.length > ACTIVITY_OUTPUT_MAX) clean = { ...a, output: tail(a.output, ACTIVITY_OUTPUT_MAX) } as EventDataMap[T];
      if (a.detail && a.detail.length > ACTIVITY_OUTPUT_MAX) clean = { ...(clean as EventDataMap['activity']), detail: a.detail.slice(0, ACTIVITY_OUTPUT_MAX) + '…' } as EventDataMap[T];
    }
    const ts = Date.now();
    const fts = type === 'message' ? (clean as EventDataMap['message']).text : undefined;
    const seq = this.db.appendEvent(sessionId, ts, type, actor, clean, fts || undefined);
    const ev = { sessionId, seq, ts, type, actor, data: clean } as LinaEvent<T>;
    this.applyLive(ev as unknown as AnyLinaEvent);
    this.broadcast(ev as unknown as AnyLinaEvent);
    return ev;
  }

  /** Broadcast-only event (seq 0): stream deltas, stream ends, session.updated. */
  emitEphemeral<T extends EventType>(sessionId: string, type: T, actor: Actor, data: EventDataMap[T]): LinaEvent<T> {
    const ev = { sessionId, seq: 0, ts: Date.now(), type, actor, data } as LinaEvent<T>;
    this.applyLive(ev as unknown as AnyLinaEvent);
    this.broadcast(ev as unknown as AnyLinaEvent);
    return ev;
  }

  /** Session row changed: notify session subscribers and global watchers (not persisted). */
  sessionUpdated(session: Session): void {
    this.emitEphemeral(session.id, 'session.updated', 'lina', { session });
  }

  subscribe(sessionId: string, fn: EventListener): () => void {
    let set = this.subs.get(sessionId);
    if (!set) { set = new Set(); this.subs.set(sessionId, set); }
    set.add(fn);
    return () => { set!.delete(fn); if (!set!.size) this.subs.delete(sessionId); };
  }

  /** Global watcher: receives `session.updated` and `session.deleted` for every session. */
  watchAll(fn: EventListener): () => void {
    this.globals.add(fn);
    return () => { this.globals.delete(fn); };
  }

  live(sessionId: string): LiveState {
    let l = this.lives.get(sessionId);
    if (!l) { l = emptyLive(); this.lives.set(sessionId, l); }
    return l;
  }

  /** Deep copy of the live state for snapshots. */
  liveSnapshot(sessionId: string): LiveState {
    return JSON.parse(JSON.stringify(this.live(sessionId))) as LiveState;
  }

  dropSession(sessionId: string): void {
    this.lives.delete(sessionId);
    this.subs.delete(sessionId);
  }

  private broadcast(e: AnyLinaEvent): void {
    const set = this.subs.get(e.sessionId);
    if (set) for (const fn of [...set]) safeCall(fn, e);
    if (e.type === 'session.updated' || e.type === 'session.deleted') for (const fn of [...this.globals]) safeCall(fn, e);
  }

  private applyLive(e: AnyLinaEvent): void {
    const l = this.live(e.sessionId);
    switch (e.type) {
      case 'agent.status': {
        const a = l.agents[e.data.agent];
        l.agents[e.data.agent] = { ...a, status: e.data.status, detail: e.data.detail, role: e.data.role ?? a?.role, since: e.ts };
        break;
      }
      case 'turn': {
        const a = l.agents[e.data.agent];
        l.agents[e.data.agent] = { ...a, role: e.data.role, model: e.data.model || a?.model };
        break;
      }
      case 'stream': {
        const cur = l.streams[e.data.msgId];
        l.streams[e.data.msgId] = { agent: e.data.agent, text: (cur?.text ?? '') + e.data.delta };
        break;
      }
      case 'stream.end':
        delete l.streams[e.data.msgId];
        break;
      case 'message':
        delete l.streams[e.data.id];
        break;
      case 'usage':
        if (e.data.rateLimit) l.rateLimits[e.data.agent] = e.data.rateLimit;
        break;
      default:
        break;
    }
  }

  /** Current live status for an agent (used to dedupe status events). */
  agentStatus(sessionId: string, agent: AgentId): LiveState['agents'][AgentId] {
    return this.live(sessionId).agents[agent];
  }
}

function safeCall(fn: EventListener, e: AnyLinaEvent): void {
  try { fn(e); } catch (err) { log.warn('event listener failed', err); }
}
