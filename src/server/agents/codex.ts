// Codex adapter: drives `codex exec --json` / `codex exec resume <id> --json`.
import type { UsageTotals } from '../../shared/types.js';
import type { AgentAdapter, AgentStreamEvent, TurnError, TurnOptions, TurnResult } from './types.js';
import { agentEnv, execText, runProcess } from './proc.js';
import { classifyCommand, displayPath, oneLine } from './classify.js';
import { classifyError, unwrapJsonError } from './errors.js';
import { configuredRea, reaCodexArgs } from './rea.js';
import { redact, redactTail } from './redact.js';

export interface CodexArgOptions extends Pick<TurnOptions, 'cwd' | 'model' | 'effort' | 'resumeId' | 'systemPrompt' | 'access' | 'fullAccess' | 'network' | 'images'> {}

/**
 * Builds argv (without the binary). Prompt is read from stdin ("-").
 * Access is explicit on both new and resumed turns, independent of user config.
 * `exec resume` has no -s/-C, so the sandbox goes through `-c sandbox_mode=…`
 * and the working directory is the spawned process' cwd.
 */
export function buildCodexArgs(opts: CodexArgOptions, isolation: string[] = []): string[] {
  const full = opts.access === 'write' && opts.fullAccess === true;
  const sandbox = opts.access === 'write' ? full ? 'danger-full-access' : 'workspace-write' : 'read-only';
  const args = opts.resumeId ? ['exec', 'resume', '--json'] : ['exec', '--json'];
  if (opts.resumeId) args.push('-c', `sandbox_mode="${sandbox}"`);
  else args.push('-s', sandbox, '-C', opts.cwd);
  args.push('--skip-git-repo-check', '-m', opts.model);
  if (opts.effort) args.push('-c', `model_reasoning_effort="${opts.effort}"`);
  args.push('-c', 'approval_policy="never"');
  if (opts.access === 'write' && !full) args.push('-c', `sandbox_workspace_write.network_access=${opts.network ? 'true' : 'false'}`);
  // developer_instructions is a documented config key; verified with `codex debug prompt-input`
  // that it lands in the developer message. JSON string syntax is valid TOML basic-string syntax.
  if (opts.systemPrompt) args.push('-c', `developer_instructions=${JSON.stringify(opts.systemPrompt)}`);
  args.push(...isolation);
  for (const img of opts.images ?? []) args.push(`--image=${img}`);
  if (opts.resumeId) args.push(opts.resumeId);
  args.push('-');
  return args;
}

let isolationCache: { at: number; bin: string; args: string[] } | null = null;

/**
 * Arguments that keep the user's personal Codex extensions out of LINA runs:
 * `--disable plugins` drops plugin-provided MCP servers/skills, and each MCP server
 * from the user's config.toml is turned off with `-c mcp_servers.<name>.enabled=false`
 * (verified with `codex mcp list --json`). `-c mcp_servers={}` does NOT work (it merges).
 * Only server names are read from the listing; env/args are ignored.
 */
export async function codexIsolationArgs(bin = 'codex'): Promise<string[]> {
  if (isolationCache && isolationCache.bin === bin && Date.now() - isolationCache.at < 10 * 60_000) return isolationCache.args;
  const args = ['--disable', 'plugins'];
  try {
    const r = await execText(bin, ['mcp', 'list', '--json', '--disable', 'plugins'], { timeoutMs: 15_000, cwd: process.env.HOME || '/' });
    if (r.code === 0) {
      const list = JSON.parse(r.stdout);
      if (Array.isArray(list)) {
        for (const s of list) {
          const name = s?.name;
          if (typeof name === 'string' && /^[A-Za-z0-9_-]+$/.test(name) && s.enabled !== false) {
            args.push('-c', `mcp_servers.${name}.enabled=false`);
          }
        }
      }
    }
  } catch { /* listing failed: plugins are still disabled */ }
  isolationCache = { at: Date.now(), bin, args };
  return args;
}

export interface CodexParseResult {
  threadId?: string;
  turnCompleted: boolean;
  turnFailed: boolean;
  text: string;
  usage: Partial<UsageTotals>;
  error?: TurnError;
  /** Last top-level `error` event message (may be transient, e.g. reconnects). */
  lastErrorMessage?: string;
  nonJson: string[];
}

export interface CodexParser {
  push(line: string): AgentStreamEvent[];
  result(): CodexParseResult;
}

const FILE_VERB: Record<string, string> = { add: 'Created', delete: 'Deleted', update: 'Edited', modify: 'Edited', rename: 'Renamed' };

/** Pure parser for `codex exec --json` JSONL. */
export function createCodexParser(cwd: string, model?: string): CodexParser {
  const st: CodexParseResult = { turnCompleted: false, turnFailed: false, text: '', usage: {}, nonJson: [] };
  let started = false;
  const finished = new Set<string>();
  let lastStatus: number | undefined;

  const toolEvent = (item: any, phase: 'started' | 'completed'): AgentStreamEvent[] => {
    const id = String(item.id ?? '');
    if (!id) return [];
    if (item.type === 'todo_list') {
      // Plan updates are notes (same id, upserted on every update), not long-running tools.
      const items: any[] = Array.isArray(item.items) ? item.items : [];
      const doneN = items.filter((x) => x?.completed).length;
      return [{ t: 'tool', id, kind: 'note', title: `Updated plan (${doneN}/${items.length} done)`, state: 'ok' }];
    }
    if (finished.has(id)) return [];
    const done = phase === 'completed';
    if (done) finished.add(id);
    switch (item.type) {
      case 'command_execution': {
        const c = classifyCommand(String(item.command ?? ''));
        const exit = typeof item.exit_code === 'number' ? item.exit_code : null;
        const failed = done && ((exit !== null && exit !== 0) || item.status === 'failed' || item.status === 'declined');
        return [{
          t: 'tool', id, kind: c.kind, title: c.title,
          state: !done ? 'running' : failed ? 'error' : 'ok',
          ...(done ? { exitCode: exit } : {}),
          ...(done ? { output: redactTail(String(item.aggregated_output ?? ''), 4000) } : {}),
        }];
      }
      case 'file_change': {
        const changes: any[] = Array.isArray(item.changes) ? item.changes : [];
        const files = changes.map((ch) => displayPath(String(ch?.path ?? ''), cwd)).filter(Boolean);
        const kinds = new Set(changes.map((ch) => String(ch?.kind ?? 'update')));
        const verb = kinds.size === 1 ? FILE_VERB[[...kinds][0]] ?? 'Changed' : 'Changed';
        const title = files.length === 1 ? `${verb} ${files[0]}` : `${verb} ${files.length} files`;
        const failed = done && item.status === 'failed';
        return [{ t: 'tool', id, kind: 'edit', title: oneLine(title), files, state: !done ? 'running' : failed ? 'error' : 'ok' }];
      }
      case 'mcp_tool_call': {
        const title = oneLine(`${item.server ?? 'mcp'}: ${item.tool ?? 'tool'}`);
        const failed = done && (item.status === 'failed' || !!item.error);
        const output = item.error?.message ?? (item.result ? JSON.stringify(item.result) : '');
        return [{ t: 'tool', id, kind: 'tool', title, state: !done ? 'running' : failed ? 'error' : 'ok', ...(done && output ? { output: redactTail(String(output), 4000) } : {}) }];
      }
      case 'web_search': {
        const q = item.query ?? item.action?.query ?? '';
        return [{ t: 'tool', id, kind: 'web', title: oneLine(`Search: ${q}`), state: done ? 'ok' : 'running' }];
      }
      default:
        return [];
    }
  };

  return {
    push(line: string): AgentStreamEvent[] {
      const s = line.trim();
      if (!s) return [];
      let d: any;
      if (s.startsWith('{')) { try { d = JSON.parse(s); } catch { d = undefined; } }
      if (!d || typeof d !== 'object') {
        if (st.nonJson.length < 50) st.nonJson.push(redact(s).slice(0, 2000));
        return [];
      }
      switch (d.type) {
        case 'thread.started': {
          if (typeof d.thread_id === 'string') st.threadId = d.thread_id;
          if (started) return [];
          started = true;
          return [{ t: 'started', ...(st.threadId ? { providerSessionId: st.threadId } : {}), ...(model ? { model } : {}) }];
        }
        case 'item.started':
        case 'item.updated':
        case 'item.completed': {
          const item = d.item ?? {};
          const completed = d.type === 'item.completed';
          if (item.type === 'agent_message') {
            if (!completed || typeof item.text !== 'string') return [];
            st.text = item.text;
            return item.text ? [{ t: 'text', msgId: String(item.id ?? 'msg'), text: item.text }] : [];
          }
          if (item.type === 'reasoning') return [];
          if (item.type === 'error') {
            if (!completed) return [];
            const msg = unwrapJsonError(String(item.message ?? '')).message;
            return msg ? [{ t: 'warning', message: redact(msg).slice(0, 1000) }] : [];
          }
          if (d.type === 'item.updated' && item.type !== 'todo_list') return [];
          return toolEvent(item, completed ? 'completed' : 'started');
        }
        case 'error': {
          const { message, status } = unwrapJsonError(String(d.message ?? ''));
          st.lastErrorMessage = message;
          if (status !== undefined) lastStatus = status;
          // May be transient (stream reconnects); a fatal one is followed by turn.failed.
          return message ? [{ t: 'warning', message: redact(message).slice(0, 1000) }] : [];
        }
        case 'turn.failed': {
          st.turnFailed = true;
          const raw = d.error?.message ?? st.lastErrorMessage ?? 'Codex turn failed';
          const { message, status } = unwrapJsonError(String(raw));
          st.error = classifyError('codex', message, { apiStatus: status ?? lastStatus });
          return [];
        }
        case 'turn.completed': {
          st.turnCompleted = true;
          const u = d.usage ?? {};
          const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
          st.usage = { inputTokens: num(u.input_tokens), cachedInputTokens: num(u.cached_input_tokens), outputTokens: num(u.output_tokens), turns: 1 };
          return [{ t: 'usage', usage: st.usage }];
        }
        default:
          return [];
      }
    },
    result(): CodexParseResult {
      return { ...st, usage: { ...st.usage }, nonJson: [...st.nonJson] };
    },
  };
}

export class CodexAdapter implements AgentAdapter {
  readonly id = 'codex' as const;
  readonly bin: string;
  private isolate: boolean;

  /** isolate (default true): disable the user's Codex plugins and MCP servers for LINA runs. */
  constructor(opts?: { bin?: string; isolate?: boolean }) {
    this.bin = opts?.bin || process.env.LINA_CODEX_BIN || 'codex';
    this.isolate = opts?.isolate ?? true;
  }

  async runTurn(opts: TurnOptions, onEvent: (e: AgentStreamEvent) => void): Promise<TurnResult> {
    const startedAt = Date.now();
    const parser = createCodexParser(opts.cwd, opts.model);
    const emit = (evs: AgentStreamEvent[]) => {
      for (const e of evs) { try { onEvent(e); } catch { /* ignore consumer errors */ } }
    };
    let isolation = this.isolate ? await codexIsolationArgs(this.bin) : [];
    if (opts.reaEnabled) {
      const rea = await configuredRea('codex', this.bin);
      isolation = isolation.filter((value, index, all) => value !== 'mcp_servers.rea.enabled=false' && !(value === '-c' && all[index + 1] === 'mcp_servers.rea.enabled=false'));
      isolation.push(...reaCodexArgs(rea, opts.access === 'read' || opts.fullAccess !== true));
    }
    const proc = await runProcess({
      cmd: this.bin,
      args: buildCodexArgs(opts, isolation),
      cwd: opts.cwd,
      env: agentEnv(opts.sessionId ? { LINA_SESSION_ID: opts.sessionId } : undefined),
      stdin: opts.prompt,
      signal: opts.signal,
      turnTimeoutMs: opts.turnTimeoutMs,
      idleTimeoutMs: opts.idleTimeoutMs,
      onLine: (line) => emit(parser.push(line)),
    });
    const r = parser.result();
    const base = {
      text: r.text,
      ...(r.threadId || opts.resumeId ? { providerSessionId: r.threadId ?? opts.resumeId } : {}),
      model: opts.model,
      usage: r.usage,
      durationMs: Date.now() - startedAt,
    };
    let error: TurnError | undefined;
    if (proc.aborted || proc.timedOut || proc.spawnError) {
      error = classifyError('codex', proc.spawnError ?? '', { aborted: proc.aborted, timedOut: proc.timedOut, spawnError: proc.spawnError, exitCode: proc.exitCode });
    } else if (r.turnCompleted && !r.turnFailed) {
      // Exit code is not trusted (Codex exits 0 on turn.failed); turn.completed is.
      return { ok: true, ...base };
    } else if (r.error) {
      error = r.error;
    } else {
      const stderr = [proc.stderrTail, ...r.nonJson].filter(Boolean).join('\n');
      const msg = r.lastErrorMessage || lastErrorLine(stderr) || 'Codex exited without completing the turn';
      error = classifyError('codex', msg, { exitCode: proc.exitCode, stderr });
    }
    return { ok: false, ...base, error };
  }
}

/** Picks the most informative line of Codex stderr (skips MCP/log noise). */
function lastErrorLine(stderr: string): string {
  const lines = stderr.split('\n').map((l) => l.trim()).filter(Boolean);
  const errLine = [...lines].reverse().find((l) => /error|fail|denied|not logged|unauthori|invalid/i.test(l) && !/mcp/i.test(l));
  return errLine ?? lines[lines.length - 1] ?? '';
}
