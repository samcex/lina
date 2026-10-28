// SQLite persistence (node:sqlite, synchronous). WAL mode, versioned migrations.
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { byAgent, emptyUsageTotals, type Actor, type AgentId, type AnyLinaEvent, type Attachment, type EventType, type Project, type SearchHit, type Session, type UsageTotals } from '../shared/types.js';

const MIGRATIONS: string[] = [
  // v1
  `
  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    path TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    settings TEXT NOT NULL
  );
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL,
    phase TEXT NOT NULL,
    round INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    config TEXT NOT NULL,
    usage TEXT NOT NULL,
    state TEXT,
    workspace_path TEXT NOT NULL,
    branch TEXT NOT NULL,
    base_commit TEXT NOT NULL,
    head_commit TEXT,
    last_seq INTEGER NOT NULL DEFAULT 0,
    pending_messages INTEGER NOT NULL DEFAULT 0,
    mock INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX sessions_project ON sessions(project_id, updated_at);
  CREATE TABLE events (
    session_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    ts INTEGER NOT NULL,
    type TEXT NOT NULL,
    actor TEXT NOT NULL,
    data TEXT NOT NULL,
    PRIMARY KEY (session_id, seq)
  ) WITHOUT ROWID;
  CREATE VIRTUAL TABLE messages_fts USING fts5(
    text, session_id UNINDEXED, seq UNINDEXED, tokenize = 'unicode61 remove_diacritics 2'
  );
  CREATE TABLE settings (k TEXT PRIMARY KEY, v TEXT NOT NULL);
  CREATE TABLE attachments (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    name TEXT NOT NULL,
    size INTEGER NOT NULL,
    mime TEXT NOT NULL,
    path TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX attachments_session ON attachments(session_id);
  `,
  // v2: parallel/compete worktrees
  `
  ALTER TABLE sessions ADD COLUMN variants TEXT;
  ALTER TABLE sessions ADD COLUMN chosen_variant TEXT;
  `,
  // v3: durable per-turn snapshots and independently managed previews.
  `
  CREATE TABLE turn_changes (session_id TEXT NOT NULL, turn_no INTEGER NOT NULL, record TEXT NOT NULL,
    PRIMARY KEY (session_id, turn_no));
  CREATE TABLE previews (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, record TEXT NOT NULL);
  CREATE INDEX previews_session ON previews(session_id);
  `,
];

type Row = Record<string, unknown>;

const emptyUsage = emptyUsageTotals;

export class Db {
  readonly sql: DatabaseSync;
  private stmts = new Map<string, StatementSync>();
  private txDepth = 0;

  constructor(file: string) {
    this.sql = new DatabaseSync(file);
    this.sql.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;');
    this.migrate();
  }

  close(): void {
    this.stmts.clear();
    try { this.sql.close(); } catch { /* already closed */ }
  }

  private q(sql: string): StatementSync {
    let s = this.stmts.get(sql);
    if (!s) { s = this.sql.prepare(sql); this.stmts.set(sql, s); }
    return s;
  }

  /** Runs fn in a transaction (re-entrant: nested calls join the outer transaction). */
  tx<T>(fn: () => T): T {
    if (this.txDepth > 0) { this.txDepth++; try { return fn(); } finally { this.txDepth--; } }
    this.sql.exec('BEGIN IMMEDIATE');
    this.txDepth = 1;
    try {
      const r = fn();
      this.sql.exec('COMMIT');
      return r;
    } catch (e) {
      try { this.sql.exec('ROLLBACK'); } catch { /* ignore */ }
      throw e;
    } finally {
      this.txDepth = 0;
    }
  }

  private migrate(): void {
    this.sql.exec('CREATE TABLE IF NOT EXISTS migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)');
    const row = this.sql.prepare('SELECT MAX(version) AS v FROM migrations').get() as Row | undefined;
    const current = Number(row?.v ?? 0);
    for (let i = current; i < MIGRATIONS.length; i++) {
      this.tx(() => {
        this.sql.exec(MIGRATIONS[i]);
        this.sql.prepare('INSERT INTO migrations (version, applied_at) VALUES (?, ?)').run(i + 1, Date.now());
      });
    }
  }

  // ── projects ────────────────────────────────────────────────────────────
  private toProject(r: Row): Project {
    return {
      id: String(r.id), name: String(r.name), path: String(r.path),
      createdAt: Number(r.created_at), updatedAt: Number(r.updated_at),
      settings: JSON.parse(String(r.settings)),
    };
  }
  listProjects(): Project[] {
    return (this.q('SELECT * FROM projects ORDER BY updated_at DESC').all() as Row[]).map((r) => this.toProject(r));
  }
  getProject(id: string): Project | undefined {
    const r = this.q('SELECT * FROM projects WHERE id = ?').get(id) as Row | undefined;
    return r ? this.toProject(r) : undefined;
  }
  getProjectByPath(path: string): Project | undefined {
    const r = this.q('SELECT * FROM projects WHERE path = ?').get(path) as Row | undefined;
    return r ? this.toProject(r) : undefined;
  }
  upsertProject(p: Project): void {
    this.q(`INSERT INTO projects (id, name, path, created_at, updated_at, settings) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, path = excluded.path, updated_at = excluded.updated_at, settings = excluded.settings`)
      .run(p.id, p.name, p.path, p.createdAt, p.updatedAt, JSON.stringify(p.settings));
  }
  deleteProject(id: string): void {
    this.q('DELETE FROM projects WHERE id = ?').run(id);
  }

  // ── sessions ────────────────────────────────────────────────────────────
  private toSession(r: Row): Session {
    const usage = JSON.parse(String(r.usage)) as Partial<Record<AgentId, UsageTotals>>;
    const s: Session = {
      id: String(r.id), projectId: String(r.project_id), title: String(r.title),
      status: String(r.status) as Session['status'], phase: String(r.phase) as Session['phase'],
      round: Number(r.round), createdAt: Number(r.created_at), updatedAt: Number(r.updated_at),
      config: JSON.parse(String(r.config)),
      workspacePath: String(r.workspace_path), branch: String(r.branch), baseCommit: String(r.base_commit),
      usage: byAgent((a) => ({ ...emptyUsage(), ...usage[a] })),
      lastSeq: Number(r.last_seq), pendingMessages: Number(r.pending_messages),
    };
    if (r.head_commit) s.headCommit = String(r.head_commit);
    if (r.variants) s.variants = JSON.parse(String(r.variants));
    if (r.chosen_variant) s.chosenVariant = String(r.chosen_variant) as AgentId;
    if (Number(r.mock)) s.mock = true;
    return s;
  }
  listSessions(f: { projectId?: string; q?: string } = {}): Session[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (f.projectId) { where.push('project_id = ?'); args.push(f.projectId); }
    if (f.q) { where.push("title LIKE ? ESCAPE '\\'"); args.push('%' + f.q.replace(/[\\%_]/g, (m) => '\\' + m) + '%'); }
    const sql = `SELECT * FROM sessions ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY updated_at DESC`;
    return (this.sql.prepare(sql).all(...args) as Row[]).map((r) => this.toSession(r));
  }
  getSession(id: string): Session | undefined {
    const r = this.q('SELECT * FROM sessions WHERE id = ?').get(id) as Row | undefined;
    return r ? this.toSession(r) : undefined;
  }
  getSessionState<T>(id: string): T | undefined {
    const r = this.q('SELECT state FROM sessions WHERE id = ?').get(id) as Row | undefined;
    return r?.state ? (JSON.parse(String(r.state)) as T) : undefined;
  }
  insertSession(s: Session, state: unknown): void {
    this.q(`INSERT INTO sessions (id, project_id, title, status, phase, round, created_at, updated_at, config, usage, state,
      workspace_path, branch, base_commit, head_commit, last_seq, pending_messages, mock)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`)
      .run(s.id, s.projectId, s.title, s.status, s.phase, s.round, s.createdAt, s.updatedAt,
        JSON.stringify(s.config), JSON.stringify(s.usage), JSON.stringify(state ?? null),
        s.workspacePath, s.branch, s.baseCommit, s.headCommit ?? null, s.pendingMessages, s.mock ? 1 : 0);
  }
  /** Writes every mutable column except last_seq (owned by the event store). */
  updateSession(s: Session, state?: unknown): void {
    const base = `UPDATE sessions SET title = ?, status = ?, phase = ?, round = ?, updated_at = ?, config = ?, usage = ?,
      head_commit = ?, pending_messages = ?, variants = ?, chosen_variant = ?`;
    const args = [s.title, s.status, s.phase, s.round, s.updatedAt, JSON.stringify(s.config), JSON.stringify(s.usage),
      s.headCommit ?? null, s.pendingMessages, s.variants ? JSON.stringify(s.variants) : null, s.chosenVariant ?? null] as (string | number | null)[];
    if (state !== undefined) this.q(base + ', state = ? WHERE id = ?').run(...args, JSON.stringify(state), s.id);
    else this.q(base + ' WHERE id = ?').run(...args, s.id);
  }
  lastSeq(sessionId: string): number {
    const r = this.q('SELECT last_seq FROM sessions WHERE id = ?').get(sessionId) as Row | undefined;
    return Number(r?.last_seq ?? 0);
  }
  deleteSession(id: string): void {
    this.tx(() => {
      this.q('DELETE FROM events WHERE session_id = ?').run(id);
      this.q('DELETE FROM messages_fts WHERE session_id = ?').run(id);
      this.q('DELETE FROM attachments WHERE session_id = ?').run(id);
      this.q('DELETE FROM sessions WHERE id = ?').run(id);
    });
  }

  // ── events ──────────────────────────────────────────────────────────────
  /** Assigns the next seq for the session and persists the event atomically. */
  appendEvent(sessionId: string, ts: number, type: EventType, actor: Actor, data: unknown, ftsText?: string): number {
    return this.tx(() => {
      const seq = this.lastSeq(sessionId) + 1;
      this.q('INSERT INTO events (session_id, seq, ts, type, actor, data) VALUES (?, ?, ?, ?, ?, ?)')
        .run(sessionId, seq, ts, type, actor, JSON.stringify(data));
      this.q('UPDATE sessions SET last_seq = ? WHERE id = ?').run(seq, sessionId);
      if (ftsText) this.q('INSERT INTO messages_fts (text, session_id, seq) VALUES (?, ?, ?)').run(ftsText, sessionId, seq);
      return seq;
    });
  }
  /** Persisted events with seq > since, oldest first. `limit` keeps the newest N. */
  events(sessionId: string, since = 0, limit?: number): AnyLinaEvent[] {
    const rows = (limit
      ? (this.q('SELECT * FROM (SELECT * FROM events WHERE session_id = ? AND seq > ? ORDER BY seq DESC LIMIT ?) ORDER BY seq ASC')
        .all(sessionId, since, limit) as Row[])
      : (this.q('SELECT * FROM events WHERE session_id = ? AND seq > ? ORDER BY seq ASC').all(sessionId, since) as Row[]));
    return rows.map((r) => ({
      sessionId: String(r.session_id), seq: Number(r.seq), ts: Number(r.ts), type: String(r.type),
      actor: String(r.actor), data: JSON.parse(String(r.data)),
    }) as AnyLinaEvent);
  }

  /** Bounded context that retains both agents even when one has been quiet. */
  recentConversation(sessionId: string, recipient: AgentId): { agent: string; text: string; variant?: string }[] {
    const rows = this.q(`SELECT actor, data FROM (
      SELECT * FROM (SELECT actor, data, seq FROM events WHERE session_id = ? AND type = 'message' AND actor = 'user' AND (json_extract(data, '$.mention') IS NULL OR json_extract(data, '$.mention') = ?) ORDER BY seq DESC LIMIT 4)
      UNION ALL
      SELECT * FROM (SELECT actor, data, seq FROM events WHERE session_id = ? AND type = 'message' AND actor = 'codex' ORDER BY seq DESC LIMIT 2)
      UNION ALL
      SELECT * FROM (SELECT actor, data, seq FROM events WHERE session_id = ? AND type = 'message' AND actor = 'claude' ORDER BY seq DESC LIMIT 2)
    ) ORDER BY seq ASC`).all(sessionId, recipient, sessionId, sessionId) as Row[];
    return rows.map((r) => {
      const data = JSON.parse(String(r.data));
      const text = String(data.text ?? '');
      return { agent: String(r.actor), text: text.length <= 10000 ? text : `${text.slice(0, 6000)}\n… [middle omitted] …\n${text.slice(-4000)}`, variant: data.variant };
    });
  }

  /** Bounded chronological page, either forward after `since` or backward before `before`. */
  eventPage(sessionId: string, since = 0, limit = 2000, before?: number): AnyLinaEvent[] {
    const rows = before === undefined
      ? this.q('SELECT * FROM events WHERE session_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?').all(sessionId, since, limit) as Row[]
      : (this.q('SELECT * FROM events WHERE session_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?').all(sessionId, before, limit) as Row[]).reverse();
    return rows.map((r) => ({ sessionId: String(r.session_id), seq: Number(r.seq), ts: Number(r.ts), type: String(r.type), actor: String(r.actor), data: JSON.parse(String(r.data)) }) as AnyLinaEvent);
  }

  search(q: string, limit = 50): SearchHit[] {
    const tokens = q.match(/[\p{L}\p{N}_]+/gu);
    if (!tokens?.length) return [];
    const match = tokens.slice(0, 12).map((t) => `"${t}"*`).join(' ');
    const rows = this.q(`SELECT f.session_id AS sid, f.seq AS seq, snippet(messages_fts, 0, '', '', '…', 16) AS snip,
        s.project_id AS pid, s.title AS title, e.actor AS actor, e.ts AS ts
      FROM messages_fts f
      JOIN sessions s ON s.id = f.session_id
      JOIN events e ON e.session_id = f.session_id AND e.seq = f.seq
      WHERE messages_fts MATCH ?
      ORDER BY rank LIMIT ?`).all(match, limit) as Row[];
    return rows.map((r) => ({
      sessionId: String(r.sid), projectId: String(r.pid), sessionTitle: String(r.title), seq: Number(r.seq),
      actor: String(r.actor) as Actor, ts: Number(r.ts), snippet: String(r.snip),
    }));
  }

  // ── settings ────────────────────────────────────────────────────────────
  getSetting<T>(k: string): T | undefined {
    const r = this.q('SELECT v FROM settings WHERE k = ?').get(k) as Row | undefined;
    return r ? (JSON.parse(String(r.v)) as T) : undefined;
  }
  setSetting(k: string, v: unknown): void {
    this.q('INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, JSON.stringify(v));
  }

  // ── attachments ─────────────────────────────────────────────────────────
  insertAttachment(sessionId: string, a: Attachment): void {
    this.q('INSERT INTO attachments (id, session_id, name, size, mime, path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(a.id, sessionId, a.name, a.size, a.mime, a.path, Date.now());
  }
  getAttachment(sessionId: string, id: string): Attachment | undefined {
    const r = this.q('SELECT * FROM attachments WHERE id = ? AND session_id = ?').get(id, sessionId) as Row | undefined;
    return r ? { id: String(r.id), name: String(r.name), size: Number(r.size), mime: String(r.mime), path: String(r.path) } : undefined;
  }
}
