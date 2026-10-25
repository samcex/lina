// Contract between agent adapters (claude.ts, codex.ts, mock.ts) and the orchestrator.
import type {
  ActivityKind, AgentId, AgentModels, DoctorCheck, Effort, ErrorCode, ModelValidation, RateLimitInfo, UsageTotals,
} from '../../shared/types.js';

export interface TurnOptions {
  sessionId?: string;
  prompt: string;
  /** Working directory: the project or the session's isolated workspace. */
  cwd: string;
  model: string;
  effort?: Effort;
  /** write: may edit files under cwd and run commands. read: inspection only, no edits. */
  access: 'write' | 'read';
  /** Disable provider sandbox/permission prompts for developer turns. Reviewers remain read-only. */
  fullAccess?: boolean;
  /** Allow outbound network for commands the agent runs (where the CLI can enforce it). */
  network: boolean;
  /** Provider conversation id to continue (Claude session_id / Codex thread_id). */
  resumeId?: string;
  /** Role instructions appended to the provider's system prompt. */
  systemPrompt?: string;
  /** Extra directories the agent may read (e.g. attachments). */
  extraReadDirs?: string[];
  images?: string[];
  /** Use the provider's OS-level sandbox for shell commands, if supported. */
  osSandbox?: boolean;
  signal: AbortSignal;
  turnTimeoutMs: number;
  idleTimeoutMs: number;
}

export type AgentStreamEvent =
  /** Process started and the provider announced its session. */
  | { t: 'started'; providerSessionId?: string; model?: string }
  /** Incremental assistant text belonging to provider message `msgId`. */
  | { t: 'text_delta'; msgId: string; text: string }
  /** A complete assistant text block (may be narration between tool calls). */
  | { t: 'text'; msgId: string; text: string }
  /** Observed tool activity. Emit `running` at start and `ok`/`error` at completion with the same id. */
  | {
      t: 'tool'; id: string; kind: ActivityKind; title: string; detail?: string;
      state: 'running' | 'ok' | 'error'; exitCode?: number | null; output?: string; files?: string[];
    }
  | { t: 'usage'; usage: Partial<UsageTotals> }
  | { t: 'rate_limit'; info: RateLimitInfo }
  | { t: 'warning'; message: string };

export interface TurnError { code: ErrorCode; message: string; hint?: string; retryAt?: number }

export interface TurnResult {
  ok: boolean;
  /** Final assistant message of the turn (what the agent "says" in chat). */
  text: string;
  providerSessionId?: string;
  /** Concrete model reported by the provider, if any. */
  model?: string;
  usage: Partial<UsageTotals>;
  durationMs: number;
  error?: TurnError;
}

export interface AgentAdapter {
  readonly id: AgentId;
  /** Runs one turn. Never throws for agent-level failures: returns ok=false with a classified error. */
  runTurn(opts: TurnOptions, onEvent: (e: AgentStreamEvent) => void): Promise<TurnResult>;
}

/** Implemented in models.ts */
export type DiscoverModels = (agent: AgentId, opts?: { refresh?: boolean }) => Promise<AgentModels>;
/** Implemented in models.ts — runs a minimal real request. */
export type ValidateModel = (agent: AgentId, model: string) => Promise<ModelValidation>;
/** Implemented in doctor.ts */
export type RunDoctor = (opts?: { live?: boolean }) => Promise<DoctorCheck[]>;
