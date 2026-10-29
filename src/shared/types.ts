// LINA shared domain model. This file is the contract between the daemon,
// the terminal UI and the web UI. Keep it dependency-free (runs in Node and browser).

export const LINA_VERSION = '0.1.16';

export type AgentId = 'codex' | 'claude' | 'freebuff';
export const AGENT_IDS: AgentId[] = ['codex', 'claude', 'freebuff'];
/** Display names, shared by the daemon, the terminal UI and the web UI. */
export const AGENT_LABEL: Record<AgentId, string> = { codex: 'Codex', claude: 'Claude', freebuff: 'Freebuff' };
/**
 * The agent that acts as `a`'s counterpart in two-agent playbooks (pair, architect, parallel,
 * compete, cross-review): the first agent in the canonical order that is not `a`. With Codex and
 * Claude this is exactly the historical pairing; Freebuff pairs with Codex unless Codex is `a`.
 */
export function peerOf(a: AgentId, among: AgentId[] = AGENT_IDS): AgentId {
  const pool = among.length > 1 ? among : AGENT_IDS;
  return pool.find((x) => x !== a) ?? pool[0];
}

/** Usage counters that start at zero (per agent or for a whole session). */
export function emptyUsageTotals(): UsageTotals {
  return { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: 0, turns: 0 };
}

export function zeroUsage(): Record<AgentId, UsageTotals> {
  return Object.fromEntries(AGENT_IDS.map((a) => [a, emptyUsageTotals()])) as Record<AgentId, UsageTotals>;
}

/** Builds a per-agent record from a factory (agents, models, usage, …). */
export function byAgent<T>(make: (a: AgentId) => T): Record<AgentId, T> {
  return Object.fromEntries(AGENT_IDS.map((a) => [a, make(a)])) as Record<AgentId, T>;
}
export type Actor = 'user' | 'lina' | AgentId;
export type Role = 'developer' | 'reviewer';

/**
 * Collaboration playbooks (see docs/ARCHITECTURE.md § Modes).
 *  pair      – developer implements, reviewer reviews, loop until approved
 *  architect – pair, plus the reviewer critiques the plan before any code is written
 *  solo      – developer only, no review
 *  parallel  – the lead splits the task; both agents build their part at the same time in separate
 *              worktrees; LINA integrates the branches; each agent then reviews the other's part
 *  compete   – both agents build the whole task independently; each reviews the other's version;
 *              you pick the winner
 *  custom    – you choose who plans, who critiques the plan, who implements and who reviews (TeamConfig)
 */
export type Mode = 'pair' | 'architect' | 'solo' | 'parallel' | 'compete' | 'custom';
export const IMPLEMENTED_MODES: Mode[] = ['pair', 'architect', 'solo', 'parallel', 'compete', 'custom'];

/** Who does what in a `custom` session. pair/architect/solo are fixed presets of the same pipeline (teamOf). */
export interface TeamConfig {
  /** Drafts the plan before any code is written; null = no planning step. */
  planner: AgentId | null;
  /** Critiques the plan before coding; null = no plan review. */
  planCritic: AgentId | null;
  /** Writes the code and answers review findings. */
  developer: AgentId;
  /**
   * Independent code reviewers per round, 0–2 distinct agents (they review concurrently, read-only).
   * May include the developer: it then reviews in a separate read-only provider session.
   */
  reviewers: AgentId[];
}

/** Freebuff implements the reviewed plan; both supervisors review its actual diff. */
export const DELEGATION_TEAM: TeamConfig = { planner: 'codex', planCritic: 'claude', developer: 'freebuff', reviewers: ['codex', 'claude'] };

/** The concrete pipeline a session follows. parallel/compete are not team-based and return their lead's pair team. */
export function teamOf(cfg: Pick<SessionConfig, 'mode' | 'developer' | 'reviewer' | 'team'>): TeamConfig {
  const dev = cfg.developer;
  const rev = cfg.reviewer;
  switch (cfg.mode) {
    case 'solo': return { planner: null, planCritic: null, developer: dev, reviewers: [] };
    case 'architect': return { planner: dev, planCritic: rev, developer: dev, reviewers: [rev] };
    case 'custom': return cfg.team ?? { planner: dev, planCritic: rev, developer: dev, reviewers: [rev] };
    default: return { planner: dev, planCritic: null, developer: dev, reviewers: [rev] };
  }
}

/** parallel: the slice of the task one agent owns. */
export interface WorkPart {
  agent: AgentId;
  title: string;
  /** What this agent builds, in the lead's words. */
  scope: string;
  /** Files/directories this agent owns (advisory; used to avoid overlapping edits). */
  files?: string[];
}

/**
 * parallel/compete: one agent's own line of work — a git worktree of the session clone on its own branch.
 * Path: ~/.lina/workspaces/<sessionId>--<agent>, branch lina/<short>-<agent>.
 */
export interface Variant {
  agent: AgentId;
  branch: string;
  workspacePath: string;
  baseCommit: string;
  headCommit?: string;
  /** parallel only. */
  part?: WorkPart;
}

/** compete: one candidate as shown when you pick the winner. All numbers are measured by LINA. */
export interface Candidate {
  agent: AgentId;
  headCommit: string;
  files: number;
  additions: number;
  deletions: number;
  tests?: TestRun;
  /** Open findings on this candidate (raised by the other agent), and how many of those block. */
  openFindings: number;
  blockingFindings: number;
  /** The opponent's last verdict on this candidate. */
  verdict?: 'approve' | 'request_changes' | 'unparsed';
  usage: UsageTotals;
}

export type AgentStatus =
  | 'idle' | 'thinking' | 'reading' | 'writing' | 'running' | 'testing'
  | 'reviewing' | 'waiting' | 'done' | 'error';

/** Workflow step a session is in. */
export type Phase =
  | 'idle'              // created, no task yet
  | 'planning'          // developer drafts a plan (read-only)
  | 'plan_review'       // reviewer critiques the plan (architect mode)
  | 'implementing'      // developer writes code
  | 'testing'           // LINA runs the project's test command
  | 'reviewing'         // reviewer inspects the changes (read-only)
  | 'revising'          // developer addresses findings
  | 'integrating'       // parallel: LINA merges the agents' branches (the lead resolves conflicts)
  | 'verifying'         // final tests + summary
  | 'awaiting_approval' // human decides
  | 'consulting'        // a direct @agent question outside the loop
  | 'completed' | 'approved' | 'rejected' | 'cancelled' | 'failed' | 'interrupted';

export type SessionStatus =
  | 'idle' | 'running' | 'paused' | 'awaiting_approval'
  | 'completed' | 'approved' | 'rejected' | 'cancelled' | 'failed' | 'interrupted';

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';

export interface AgentModelChoice {
  /** Provider model id or alias, e.g. "gpt-6.1-sol", "opus", "claude-sonnet-5-5". */
  model: string;
  /** Reasoning effort, if the provider supports it. Undefined = provider default. */
  effort?: Effort;
}

export interface ProjectSettings {
  /** Explicit test command. Undefined = auto-detect. Empty string = never run tests. */
  testCommand?: string;
  /** Allow agents network access (Codex workspace-write network flag). */
  network: boolean;
  /** Max reviewer rounds per task before escalating to the human. */
  maxRounds: number;
  defaultMode: Mode;
}

export interface Project {
  id: string;
  name: string;
  /** Absolute path of the user's directory (a git repo). */
  path: string;
  createdAt: number;
  updatedAt: number;
  settings: ProjectSettings;
}

export interface SessionConfig {
  /** Explicit objective of a structured goal session. */
  goal?: string;
  mode: Mode;
  /** New sessions edit the project directly. Missing on legacy sessions means isolated. */
  workspaceMode?: 'direct' | 'isolated';
  /** Direct sessions chat naturally by default; workflow retains the explicit playbook. */
  interactionMode?: 'chat' | 'workflow';
  /** Which agent implements; the other reviews (pair/architect). */
  developer: AgentId;
  reviewer: AgentId;
  models: Record<AgentId, AgentModelChoice>;
  maxRounds: number;
  network: boolean;
  testCommand?: string;
  /** Pause automatically before each review round (manual stepping). */
  stepMode?: boolean;
  /** Use scripted mock agents instead of real CLIs (tests / demo). Visibly badged. */
  mock?: boolean;
  /** custom mode only (required there; validated: reviewers ≤ 2 distinct agents). */
  team?: TeamConfig;
  /**
   * parallel only: the agents that split the work, developer first (2–3 distinct agents).
   * Absent = developer + reviewer, the classic two-way split.
   */
  participants?: AgentId[];
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  /** API-equivalent cost reported by the CLI (subscription users are not billed this). */
  costUsd: number;
  turns: number;
}

export interface RateLimitInfo {
  /** e.g. "five_hour", "seven_day" → utilization 0..1 */
  windows: Record<string, { utilization: number; resetsAt?: number; status?: string }>;
  observedAt: number;
}

export interface GoalRequirement { key: string; requirement: string; status: 'verified' | 'remaining' | 'blocked'; evidence: string; next?: string; kind?: 'owner' | 'evidence' }

export interface GoalDeferredIssue { key: string; reason: string; retryAt: number; attempts: number; kind?: 'evidence' | 'owner'; active?: boolean }

export interface Session {
  goalTask?: string;
  goalRequirements?: GoalRequirement[];
  goalDeferred?: GoalDeferredIssue[];
  /** Owner requested continuation while another goal owns this project. */
  goalResumeQueued?: boolean;
  goalStatus?: 'working' | 'complete' | 'blocked' | 'waiting-review';
  id: string;
  projectId: string;
  title: string;
  status: SessionStatus;
  phase: Phase;
  round: number;
  createdAt: number;
  updatedAt: number;
  config: SessionConfig;
  /** Project directory in direct mode; isolated clone otherwise. */
  workspacePath: string;
  branch: string;
  baseCommit: string;
  headCommit?: string;
  usage: Record<AgentId, UsageTotals>;
  /** Last seq persisted for this session. */
  lastSeq: number;
  /** Count of user messages waiting to be delivered to agents. */
  pendingMessages: number;
  /** Next automatic quota retry or deferred independent review; null when none. */
  retryAt?: number | null;
  retryReason?: 'capacity' | 'usage' | 'recovery' | 'configuration';
  mock?: boolean;
  /** parallel/compete: each agent's worktree. Absent for other modes (and before the split in parallel). */
  variants?: Partial<Record<AgentId, Variant>>;
  /** compete: the candidate you picked. Its commits now form the session branch. */
  chosenVariant?: AgentId;
}

export type Severity = 'blocker' | 'major' | 'minor' | 'nit';
export type FindingStatus =
  | 'open'       // reviewer raised / maintains it
  | 'fixed'      // developer says fixed; awaiting reviewer confirmation
  | 'disputed'   // developer disagrees (with rationale)
  | 'resolved'   // reviewer confirmed fixed
  | 'withdrawn'  // reviewer accepted developer's dispute
  | 'escalated'  // disagreement persisted; human must decide
  | 'waived';    // human decided not to fix

export interface FindingNote { round: number; actor: Actor; action: string; note?: string; ts: number }

export interface Finding {
  id: string;          // "F1", "F2"… stable within a session
  severity: Severity;
  title: string;
  detail: string;
  file?: string;
  line?: number;
  suggestion?: string;
  status: FindingStatus;
  raisedBy: AgentId;
  /** Logical reviewer slot retained when another provider takes over. */
  reviewerSlot?: AgentId;
  round: number;       // round it was raised
  history: FindingNote[];
  /** Agent expected to fix it. Default: the session developer. parallel: the owner of the affected part. */
  owner?: AgentId;
  /** compete: the candidate this finding is about. */
  variant?: AgentId;
}
export const BLOCKING_SEVERITIES: Severity[] = ['blocker', 'major'];

export interface TestRun {
  command: string;
  exitCode: number | null;
  ok: boolean;
  durationMs: number;
  passed?: number;
  failed?: number;
  /** Tail of combined output, redacted. */
  output: string;
  sandboxed: boolean;
  skippedReason?: string;
  /** compete/parallel (before integration): the worktree that was tested. Absent = the session workspace. */
  variant?: AgentId;
}

export type ActivityKind = 'command' | 'read' | 'search' | 'edit' | 'write' | 'web' | 'tool' | 'test' | 'git' | 'note';

// ───────────────────────────── Events ─────────────────────────────
// Every state change is an event. Persisted events have a per-session
// monotonic `seq`. Ephemeral events (stream deltas, live status) have seq 0
// and are only broadcast.

export interface EventDataMap {
  'session.updated': { session: Session };
  'message': {
    id: string;
    text: string;
    /** chat = conversational; plan/review/response/summary are structured turns; notice = LINA system note */
    kind: 'chat' | 'plan' | 'review' | 'response' | 'summary' | 'notice' | 'question';
    role?: Role;
    model?: string;
    attachments?: Attachment[];
    /** For user messages: which agent was @mentioned, if any. */
    mention?: AgentId;
    /** User message was queued while agents were busy. */
    queued?: boolean;
    /** compete/parallel: the line of work this message is about (e.g. Codex's review *of Claude's version*). */
    variant?: AgentId;
  };
  'phase': { phase: Phase; round: number; note?: string };
  'agent.status': { agent: AgentId; status: AgentStatus; detail?: string; role?: Role };
  'activity': {
    agent: AgentId | 'lina';
    id: string;
    kind: ActivityKind;
    title: string;
    detail?: string;
    state: 'running' | 'ok' | 'error';
    exitCode?: number | null;
    output?: string;
    files?: string[];
    /** observed = real tool/process event; narrated = text the agent wrote about what it is doing. */
    source: 'observed' | 'narrated';
  };
  'turn': {
    agent: AgentId;
    state: 'start' | 'end';
    role: Role;
    phase: Phase;
    model: string;
    providerSessionId?: string;
    /** Worktree the turn ran in (compete/parallel). Absent = the session workspace. */
    variant?: AgentId;
    ok?: boolean;
    durationMs?: number;
    usage?: Partial<UsageTotals>;
    error?: string;
  };
  /** findings = the whole ledger after this review. variant: compete — the candidate that was reviewed. */
  'review': { round: number; reviewer: AgentId; verdict: 'approve' | 'request_changes' | 'unparsed'; summary: string; findings: Finding[]; variant?: AgentId };
  'response': { round: number; developer: AgentId; items: { id: string; action: 'fixed' | 'disputed' | 'deferred'; note?: string }[] };
  'findings': { findings: Finding[] };
  'tests': TestRun;
  'checkpoint': { commit: string; message: string; files: { path: string; additions: number; deletions: number; status: string }[]; variant?: AgentId };
  /** parallel: the lead's split of the task. */
  'split': { lead: AgentId; parts: WorkPart[] };
  /** parallel: LINA merged the part branches into the session branch. conflicts = files the lead had to resolve. */
  'integration': { state: 'merged' | 'conflict' | 'resolved' | 'failed'; commit?: string; conflicts?: string[]; note?: string };
  'approval': {
    state: 'requested' | 'approved' | 'rejected' | 'failed';
    strategy?: ApplyStrategy;
    note?: string;
    summary?: string;
    unresolved?: Finding[];
    result?: string;
    /** compete, state=requested: the candidates to choose from. */
    candidates?: Candidate[];
    /** compete: the candidate that was chosen/applied. */
    variant?: AgentId;
  };
  'usage': { agent: AgentId; rateLimit?: RateLimitInfo; totals?: UsageTotals };
  'error': { agent?: AgentId; code: ErrorCode; message: string; hint?: string };
  // ephemeral
  'stream': { msgId: string; agent: AgentId; delta: string };
  'stream.end': { msgId: string; agent: AgentId };
  /** The session and its workspace were deleted. Sent to session subscribers and global watchers. */
  'session.deleted': { sessionId: string };
}
export type EventType = keyof EventDataMap;

export interface LinaEvent<T extends EventType = EventType> {
  sessionId: string;
  /** >0 for persisted events, 0 for ephemeral ones */
  seq: number;
  ts: number;
  type: T;
  actor: Actor;
  data: EventDataMap[T];
}
export type AnyLinaEvent = { [K in EventType]: LinaEvent<K> }[EventType];
export const EPHEMERAL_EVENT_TYPES: EventType[] = ['stream', 'stream.end', 'session.deleted'];

export type ErrorCode =
  | 'auth'              // CLI not logged in / token expired
  | 'model_unavailable' // model not found / not allowed on this account
  | 'rate_limited'
  | 'capacity'          // temporary provider/model capacity, not account quota
  | 'transient'         // temporary network/service failure
  | 'timeout'
  | 'cli_missing'
  | 'sandbox'           // OS sandbox failed (bwrap/seccomp)
  | 'crashed'           // process exited unexpectedly
  | 'parse'             // could not parse structured output
  | 'git'
  | 'cancelled'
  | 'internal';

export type ApplyStrategy = 'squash' | 'merge' | 'branch';

export interface TurnChange {
  turn: number;
  agent: AgentId;
  phase: Phase;
  createdAt: number;
  status: 'recording' | 'ready' | 'undone';
  before: string;
  after?: string;
  files: { path: string; status: string; additions: number; deletions: number }[];
  undoneAt?: number;
}

export interface Preview {
  id: string;
  sessionId: string;
  command: string;
  cwd: string;
  port: number;
  url: string;
  pid?: number;
  identity?: string;
  status: 'starting' | 'running' | 'stopped' | 'failed';
  createdAt: number;
  stoppedAt?: number;
  exitCode?: number | null;
  error?: string;
}

export interface Attachment {
  id: string;
  name: string;
  size: number;
  mime: string;
  /** Absolute path on the daemon host (inside ~/.lina/attachments). */
  path: string;
}

// ───────────────────────────── Models ─────────────────────────────

export interface ModelInfo {
  id: string;
  label: string;
  description?: string;
  efforts?: Effort[];
  defaultEffort?: Effort;
  /** catalog = listed by the provider CLI; alias = provider-documented alias; custom = user-entered; observed = seen in a real run */
  source: 'catalog' | 'alias' | 'custom' | 'observed';
  validation?: ModelValidation;
}

export interface ModelValidation {
  ok: boolean;
  checkedAt: number;
  /** Concrete model the provider resolved to (e.g. alias "opus" → "claude-opus-5-5"). */
  resolvedModel?: string;
  error?: string;
  code?: ErrorCode;
}

export interface AgentModels {
  agent: AgentId;
  installed: boolean;
  version?: string;
  models: ModelInfo[];
  /** Model LINA will use when none chosen. */
  defaultModel: string;
  discoveredVia: string;
  error?: string;
}

export interface DoctorCheck {
  id: string;
  label: string;
  ok: boolean;
  warn?: boolean;
  detail: string;
  hint?: string;
}

export interface Settings {
  reaEnabled?: boolean;
  /** Full agent filesystem/network access, or the provider's restricted sandbox. */
  accessMode: 'full' | 'restricted';
  models: Record<AgentId, AgentModelChoice>;
  developer: AgentId;
  defaultMode: Mode;
  maxRounds: number;
  turnTimeoutMs: number;
  idleTimeoutMs: number;
  /** Default team for new custom-mode sessions. */
  team?: TeamConfig;
  /** Use OS sandbox for Claude's Bash tool when the doctor confirmed it works. */
  claudeSandbox: 'auto' | 'on' | 'off';
  /** Run LINA's own test commands in a bubblewrap sandbox (auto = when it works here, else unsandboxed and labelled). */
  testSandbox: 'auto' | 'on' | 'off';
  theme: 'dark' | 'light';
  /** HTTPS origins that reach the 127.0.0.1 daemon through a trusted proxy (`lina tailscale on`). */
  remoteOrigins?: string[];
  /** Tailscale logins (emails) signed in without the token, only for requests from tailscale serve's socket. */
  tailnetUsers?: string[];
}

export const DEFAULT_SETTINGS: Settings = {
  accessMode: 'full',
  models: { codex: { model: 'gpt-6.1-sol', effort: 'medium' }, claude: { model: 'opus' }, freebuff: { model: 'auto' } },
  developer: 'codex',
  defaultMode: 'pair',
  maxRounds: 3,
  turnTimeoutMs: 30 * 60_000,
  idleTimeoutMs: 10 * 60_000,
  claudeSandbox: 'auto',
  testSandbox: 'auto',
  theme: 'dark',
};

export interface SearchHit {
  sessionId: string;
  projectId: string;
  sessionTitle: string;
  seq: number;
  actor: Actor;
  ts: number;
  snippet: string;
}

export interface DiffFile {
  path: string;
  oldPath?: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
  binary?: boolean;
  /** Unified diff text for this file (may be truncated). */
  patch: string;
}

export interface TreeEntry { path: string; type: 'file' | 'dir'; size?: number; changed?: boolean }

/** Live, non-persisted view of what's happening right now (sent with snapshots). */
export interface LiveState {
  agents: Record<AgentId, { status: AgentStatus; detail?: string; role?: Role; since: number; model?: string }>;
  /** In-flight streamed assistant text by msgId. */
  streams: Record<string, { agent: AgentId; text: string }>;
  rateLimits: Partial<Record<AgentId, RateLimitInfo>>;
}

export interface SessionSnapshot {
  session: Session;
  project: Project;
  events: AnyLinaEvent[];
  live: LiveState;
  findings: Finding[];
  /** Event-window cursors are distinct from the current session's high-water seq. */
  history?: { firstSeq: number; cursor: number; hasEarlier: boolean; hasLater: boolean };
}
