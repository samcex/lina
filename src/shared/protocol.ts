// HTTP + WebSocket protocol between LINA clients (TUI, web) and the daemon.
//
// Transport: http://127.0.0.1:<port>. Every /api request must carry
//   Authorization: Bearer <token>
// The token lives in ~/.lina/daemon.json (mode 0600). The web UI receives it via
// the URL fragment (#token=...) opened by `lina ui`, then keeps it in sessionStorage.
// WebSocket: ws://127.0.0.1:<port>/ws?token=<token>
//
// The daemon rejects requests whose Host header is not 127.0.0.1/localhost:<port>
// (DNS-rebinding protection) and WebSocket upgrades with a foreign Origin.

import type {
  AgentId, AgentModelChoice, AgentModels, AnyLinaEvent, ApplyStrategy, Attachment, DiffFile,
  DoctorCheck, Mode, ModelValidation, Project, ProjectSettings, SearchHit, Session, SessionConfig,
  SessionSnapshot, Settings, TreeEntry,
} from './types.js';

export interface DaemonInfo { pid: number; port: number; token: string; version: string; startedAt: number }

/** Paired over an already authenticated connection. Never include this in settings or logs. */
export interface ConnectionBundle {
  version: 1;
  serverId: string;
  tailnetUrl?: string;
  home?: { url: string; certificateSha256: string };
  /** Persistent credential accepted only on this server's home TLS listener. */
  token: string;
}
export interface HomeConfig { enabled: boolean; host?: string; port?: number }
export interface HomeStatus extends HomeConfig {
  active: boolean;
  url?: string;
  certificateSha256?: string;
  error?: string;
  addresses: { interface: string; address: string }[];
}

// ── REST ──────────────────────────────────────────────────────────────────
// Errors: non-2xx with body ApiError.
export interface ApiError { error: string; code?: string; hint?: string }

export interface Api {
  'GET /api/health': { res: { ok: true; version: string; pid: number; uptimeMs: number; serverId: string } };
  'GET /api/connection': { res: ConnectionBundle };
  'GET /api/home': { res: HomeStatus };
  'PUT /api/home': { body: HomeConfig; res: HomeStatus };

  'GET /api/settings': { res: Settings };
  'PUT /api/settings': { body: Partial<Settings>; res: Settings };

  'GET /api/doctor': { res: { checks: DoctorCheck[] } };

  /** Model catalogs for both agents. ?refresh=1 re-runs discovery. */
  'GET /api/models': { res: Record<AgentId, AgentModels> };
  /** Live probe: runs a tiny request with that model. Costs a few tokens. */
  'POST /api/models/validate': { body: { agent: AgentId; model: string }; res: ModelValidation };

  'GET /api/projects': { res: Project[] };
  /**
   * Register a directory. If `create` is true the directory is created.
   * If the directory is not a git repo, the request fails with code "not_git"
   * unless `initGit` is true (explicit consent).
   */
  'POST /api/projects': { body: { path: string; name?: string; create?: boolean; initGit?: boolean }; res: Project };
  'PATCH /api/projects/:id': { body: { name?: string; settings?: Partial<ProjectSettings> }; res: Project };
  /** Removes the project from LINA only. Never touches files. */
  'DELETE /api/projects/:id': { res: { ok: true } };
  /** Files of the project's committed HEAD (git ls-files). */
  'GET /api/projects/:id/tree': { res: TreeEntry[] };

  /** ?projectId=…&q=… */
  'GET /api/sessions': { res: Session[] };
  'POST /api/sessions': {
    body: { projectId: string; title?: string; config?: Partial<SessionConfig>; prompt?: string };
    res: Session;
  };
  /** Optional ?since=<non-negative event seq> filters persisted events; session/live state stays complete. */
  'GET /api/sessions/:id': { res: SessionSnapshot };
  /** Chronological bounded page: ?since=N forwards (default limit 2000), or ?before=N backwards (default 500). Max limit 2000. X-Lina-Last-Seq captures the high-water mark. */
  'GET /api/sessions/:id/events': { res: AnyLinaEvent[] };
  /** Change title or config (models, roles, maxRounds) — applies from the next turn. */
  'PATCH /api/sessions/:id': { body: { title?: string; config?: Partial<SessionConfig> }; res: Session };
  /** Deletes the session record and its isolated workspace. Requires ?confirm=1. */
  'DELETE /api/sessions/:id': { res: { ok: true } };

  /**
   * Send a user message. Routing:
   *  - session idle/finished/awaiting_approval → starts a new task (or a revision of the current one)
   *  - session running → queued and delivered at the next turn boundary;
   *    with `interrupt: true` the current turn is cancelled and re-run with the message
   *  - exact @agent take over transfers the existing task at a safe turn boundary and enables continuation
   *  - text beginning with "@codex " / "@claude " / "@freebuff " → directed to that agent
   */
  'POST /api/sessions/:id/messages': {
    body: { text: string; attachments?: string[]; interrupt?: boolean };
    res: { ok: true; queued: boolean; takeover?: AgentId };
  };
  /** Upload raw bytes; headers: x-filename, content-type. Returns attachment to reference by id. */
  'POST /api/sessions/:id/attachments': { res: Attachment };

  /**
   * pause   – stop at the next turn boundary
   * resume  – continue a paused/interrupted/cancelled/failed session from its last step
   * cancel  – kill the running turn now and stop
   * review  – run an extra review round on the current state
   * retry   – re-run the last failed step
   */
  'POST /api/sessions/:id/control': { body: { action: 'pause' | 'resume' | 'cancel' | 'review' | 'retry' }; res: Session };

  /**
   * approve: apply the workspace branch to the project repo.
   *   squash (default) – one commit on the user's current branch
   *   merge            – merge commit preserving LINA checkpoints
   *   branch           – only create branch lina/<id> in the project repo
   * Refuses with code "dirty_worktree" if the project has uncommitted changes (squash/merge).
   * reject: marks rejected; workspace is kept until the session is deleted.
   * waive: human resolves an escalated finding without a fix ({findingId}).
   * choose (compete): adopt candidate `variant` — its commits become the session branch, the other candidate's
   *   findings are dropped, and the session continues as a pair session with that agent as developer
   *   (still awaiting approval). approve with `variant` = choose + approve in one step; in a compete session
   *   approve without a chosen candidate fails with code "choose_variant".
   */
  'POST /api/sessions/:id/approval': {
    body: { decision: 'approve' | 'reject' | 'waive' | 'choose'; strategy?: ApplyStrategy; note?: string; findingId?: string; variant?: AgentId };
    res: Session;
  };

  /**
   * ?from=<commit>&to=<commit|"worktree"> default base..HEAD.
   * ?variant=codex|claude → that agent's worktree (compete/parallel) instead of the session workspace.
   */
  'GET /api/sessions/:id/diff': { res: { base: string; head: string; files: DiffFile[] } };
  /** ?variant= as for diff. */
  'GET /api/sessions/:id/tree': { res: TreeEntry[] };
  /** ?path=relative/path → file content from the workspace (text, max 1 MB). ?variant= as for diff. */
  'GET /api/sessions/:id/file': { res: { path: string; content: string; truncated: boolean; binary: boolean } };

  /** Full-text search across all messages. ?q=… */
  'GET /api/search': { res: SearchHit[] };
}

// ── WebSocket ─────────────────────────────────────────────────────────────
export type ClientMessage =
  /** Subscribe to one session. Server replies with `snapshot` (events after `since`), then live events. */
  | { op: 'subscribe'; sessionId: string; since?: number }
  | { op: 'unsubscribe'; sessionId: string }
  /** Receive session.updated events for all sessions (sidebar lists). */
  | { op: 'watchAll' }
  | { op: 'ping' };

export type ServerMessage =
  | { kind: 'hello'; version: string; serverTime: number }
  | { kind: 'snapshot'; sessionId: string; snapshot: SessionSnapshot }
  | { kind: 'event'; event: AnyLinaEvent }
  | { kind: 'projects'; projects: Project[] }
  | { kind: 'error'; message: string }
  | { kind: 'pong' };

export type { AgentModelChoice, Mode };
