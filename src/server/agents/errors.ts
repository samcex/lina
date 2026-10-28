// Maps raw CLI failures to LINA's ErrorCode with a friendly message and an actionable hint.
import type { AgentId, ErrorCode } from '../../shared/types.js';
import type { TurnError } from './types.js';
import { redact } from './redact.js';
import { usageResetHint } from './limit-reset.js';

export interface ErrorExtra {
  exitCode?: number | null;
  /** HTTP status reported by the provider (Claude api_error_status, Codex error.status). */
  apiStatus?: number | null;
  stderr?: string;
  /** Spawn error code (ENOENT…). */
  spawnError?: string;
  timedOut?: 'turn' | 'idle' | null;
  aborted?: boolean;
}

const CLI: Record<AgentId, { name: string; bin: string; login: string; install: string }> = {
  codex: { name: 'Codex', bin: 'codex', login: 'codex login', install: 'npm install -g @openai/codex' },
  claude: { name: 'Claude Code', bin: 'claude', login: 'claude auth login', install: 'npm install -g @anthropic-ai/claude-code (or the native installer)' },
  freebuff: { name: 'Freebuff', bin: 'freebuff', login: 'freebuff login', install: 'npm install -g freebuff' },
};

const SANDBOX_RE = /\bbwrap:|apply-seccomp|nested userns|user namespaces?|landlock|seccomp|sandbox (?:failed|error|denied|is not available)|Sandbox(?:ing)? (?:failed|unavailable)|unshare failed|Operation not permitted.*namespace/i;
const AUTH_RE = /not logged in|log ?in required|please (?:run )?\/login|run `?\/login|codex login|claude auth login|invalid (?:api key|x-api-key|token|bearer token|authentication)|authentication[_ ](?:error|failed)|unauthori[sz]ed|oauth token (?:has )?expired|token (?:has )?expired|refresh token (?:is |has )?(?:expired|invalid|revoked)|credentials? (?:are |is )?(?:missing|invalid|expired)|(?:status|http|code)[\s:=\"]*401\b|\b401 unauthori/i;
const MODEL_RE = /not supported when using codex with a chatgpt account|issue with the selected model|unrecognized_model|unknown model|model[^\n]{0,80}\b(?:not found|does not exist|is not available|not available|not supported|unavailable)|does not have access to (?:the )?model|model_not_found|invalid model|no such model/i;
const RATE_RE = /usage limit|session limit|weekly limit|rate[ _-]?limit(?:ed|_error| exceeded| reached)?\b|too many requests|(?:status|http|code)[\s:=\"]*(?:429|529)\b|overloaded|quota (?:exceeded|exhausted)/i;
const CAPACITY_RE = /\b(?:selected )?model (?:is )?(?:(?:currently|temporarily) )?at capacity\b|\boverloaded\b/i;
export function isCapacityMessage(message: string): boolean { return CAPACITY_RE.test(message); }
const TRANSIENT_RE = /ECONNRESET|ECONNREFUSED|EAI_AGAIN|ETIMEDOUT|socket hang up|connection (?:closed|reset|refused)|network (?:error|unreachable)|failed to (?:fetch|connect)|stream (?:disconnected|closed|error)|service unavailable|bad gateway|gateway timeout|(?:status|http|code)[\s:=\"]*(?:408|500|502|503|504)\b/i;
const TIMEOUT_RE = /timed? ?out|timeout/i;
const MISSING_RE = /\bENOENT\b|command not found|not found in PATH|No such file or directory.*(?:codex|claude)/i;

function firstMeaningfulLine(s: string): string {
  const lines = s.split('\n').map((l) => l.trim()).filter(Boolean);
  return lines[0] ?? '';
}

function short(s: string, max = 400): string {
  const one = redact(s).replace(/\s+/g, ' ').trim();
  return one.length > max ? one.slice(0, max - 1) + '…' : one;
}

/** Extracts `{status, error:{message}}` from a Codex/OpenAI JSON error string, if it is one. */
export function unwrapJsonError(message: string): { message: string; status?: number } {
  const trimmed = (message ?? '').trim();
  if (!trimmed.startsWith('{')) return { message: trimmed };
  try {
    const obj = JSON.parse(trimmed);
    const inner = obj?.error?.message ?? obj?.message ?? obj?.detail;
    const status = typeof obj?.status === 'number' ? obj.status : typeof obj?.error?.status === 'number' ? obj.error.status : undefined;
    if (typeof inner === 'string' && inner) return { message: inner, status };
    return { message: trimmed, status };
  } catch {
    return { message: trimmed };
  }
}

export function classifyError(agent: AgentId, message: string, extra: ErrorExtra = {}): TurnError {
  const cli = CLI[agent];
  const raw = message || '';
  const hay = `${raw}\n${extra.stderr ?? ''}`;
  const status = extra.apiStatus ?? undefined;
  const detail = short(raw || firstMeaningfulLine(extra.stderr ?? '') || '');
  const withDetail = (friendly: string) => (detail && !friendly.includes(detail) ? `${friendly}: ${detail}` : friendly);
  const mk = (code: ErrorCode, friendly: string, hint?: string): TurnError => ({ code, message: withDetail(friendly), ...(hint ? { hint } : {}) });

  if (extra.aborted) return { code: 'cancelled', message: 'The turn was cancelled.' };
  if (extra.spawnError === 'ENOENT' || (extra.spawnError && MISSING_RE.test(extra.spawnError))) {
    return { code: 'cli_missing', message: `${cli.name} CLI (\`${cli.bin}\`) was not found on PATH.`, hint: `Install it (${cli.install}) and make sure \`${cli.bin}\` is on the daemon's PATH, then run \`lina doctor\`.` };
  }
  if (extra.timedOut) {
    return extra.timedOut === 'idle'
      ? { code: 'timeout', message: `${cli.name} produced no output for too long and was stopped.`, hint: 'The agent may be stuck (e.g. waiting on a hung command). Retry, or raise the idle timeout in settings.' }
      : { code: 'timeout', message: `${cli.name} exceeded the per-turn time limit and was stopped.`, hint: 'Split the task into smaller steps or raise the turn timeout in settings.' };
  }
  if (SANDBOX_RE.test(hay)) {
    return mk('sandbox', `${cli.name}'s OS sandbox (bubblewrap/seccomp) failed`,
      'Run `lina doctor --live` to test the sandbox. Common causes: nested user namespaces are blocked (running inside another sandbox/container), or an automount point under /mnt (e.g. an idle autofs NAS mount) breaks bwrap\'s bind mounts — mount it (ls the path) or remove the automount.');
  }
  if (status === 401 || status === 403 || AUTH_RE.test(hay)) {
    return mk('auth', `${cli.name} is not logged in or its credentials expired`, `Run \`${cli.login}\` in a terminal on this machine, then retry.`);
  }
  if (status === 529 || isCapacityMessage(hay)) {
    return mk('capacity', `${cli.name}'s selected model is temporarily at capacity`, 'LINA automatically tries the other provider and schedules another attempt when capacity is available.');
  }
  if (status === 404 || MODEL_RE.test(hay)) {
    return mk('model_unavailable', `The selected model is not available to your ${cli.name} account`, 'Pick another model in the model picker (or run model validation to see which models work for your account).');
  }
  if (status === 429 || status === 529 || RATE_RE.test(hay)) {
    const retryAt = usageResetHint(hay);
    return { ...mk('rate_limited', `${cli.name} hit a rate or usage limit`, 'LINA automatically switches providers and retries pending work after usage resets.'), ...(retryAt ? { retryAt } : {}) };
  }
  if ([408,500,502,503,504].includes(status ?? 0) || TRANSIENT_RE.test(hay)) {
    return mk('transient', `${cli.name} temporarily lost its connection to the provider`, 'LINA preserves progress and retries automatically.');
  }
  if (TIMEOUT_RE.test(raw) && !raw.includes('{')) {
    return mk('timeout', `${cli.name} timed out`, 'Retry the turn; if it keeps happening check your network connection.');
  }
  if (MISSING_RE.test(extra.spawnError ?? '')) {
    return { code: 'cli_missing', message: `${cli.name} CLI could not be started.`, hint: `Install it (${cli.install}).` };
  }
  const code = extra.exitCode;
  const friendly = code !== undefined && code !== null && code !== 0
    ? `${cli.name} exited unexpectedly (exit code ${code})`
    : `${cli.name} failed`;
  return mk('crashed', friendly, 'Retry the turn. If it keeps failing, run `lina doctor` and check the daemon log.');
}
