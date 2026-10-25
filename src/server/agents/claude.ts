// Claude Code adapter: drives `claude -p --output-format stream-json`.
import { configuredRea, REA_READ_TOOLS, type ReaServer } from './rea.js';
import { dirname } from 'node:path';
import type { Effort, RateLimitInfo, UsageTotals } from '../../shared/types.js';
import type { AgentAdapter, AgentStreamEvent, TurnError, TurnOptions, TurnResult } from './types.js';
import { agentEnv, runProcess } from './proc.js';
import { classifyClaudeTool, type ToolClassification } from './classify.js';
import { classifyError } from './errors.js';
import { redact, redactTail } from './redact.js';
import { recordObservedModel } from './models.js';

/** Settings that turn on Claude Code's OS sandbox for the Bash tool. */
export const CLAUDE_SANDBOX_SETTINGS = { sandbox: { enabled: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false } };

/**
 * Flags that keep the project's CLAUDE.md / .claude settings but drop the user's
 * personal customizations (user settings incl. permission allow-lists and plugin
 * enablement, MCP servers, skills/slash commands). `--bare` is NOT used: it disables
 * subscription OAuth. `--safe-mode` is NOT used: it also drops project CLAUDE.md.
 */
export const CLAUDE_ISOLATION_ARGS = ['--setting-sources', 'project,local', '--strict-mcp-config', '--disable-slash-commands'];

const DEV_TOOLS = ['Bash', 'Read', 'Edit', 'MultiEdit', 'Write', 'Glob', 'Grep', 'TodoWrite'];
const NET_TOOLS = ['WebFetch', 'WebSearch'];
const DEV_DENY = [
  'Bash(git push:*)', 'Bash(git remote:*)', 'Bash(git config:*)', 'Bash(sudo:*)', 'Bash(su:*)',
  'Bash(ssh:*)', 'Bash(scp:*)', 'Bash(rm -rf /*)',
];
const NET_DENY = ['Bash(curl:*)', 'Bash(wget:*)'];
const REVIEW_TOOLS = ['Read', 'Grep', 'Glob', 'Bash'];
const REVIEW_ALLOW = [
  'Read', 'Grep', 'Glob',
  'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(git status:*)', 'Bash(ls:*)', 'Bash(cat:*)',
];
// git diff/log/show accept --output=<file>, which writes anywhere. Verified: the mid-pattern wildcard rules block it.
const REVIEW_DENY = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash(git * --output*)', 'Bash(git *--output=*)'];

/** Claude's --effort accepts low|medium|high|xhigh|max. */
export function claudeEffort(e?: Effort): string | undefined {
  if (!e) return undefined;
  return e === 'ultra' ? 'max' : e;
}

/** Builds the argv (without the binary). The prompt goes to stdin. */
export function buildClaudeArgs(opts: Pick<TurnOptions, 'model' | 'effort' | 'resumeId' | 'systemPrompt' | 'access' | 'fullAccess' | 'network' | 'extraReadDirs' | 'images' | 'osSandbox'>, rea?: ReaServer): string[] {
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--model', opts.model];
  const effort = claudeEffort(opts.effort);
  if (effort) args.push('--effort', effort);
  if (opts.resumeId) args.push('--resume', opts.resumeId);
  args.push('--permission-prompts', 'none', ...CLAUDE_ISOLATION_ARGS);
  // `=` form: the value can't be mistaken for an option even if it starts with "-".
  if (opts.systemPrompt) args.push(`--append-system-prompt=${opts.systemPrompt}`);
  const full = opts.access === 'write' && opts.fullAccess === true;
  if (full) {
    args.push('--dangerously-skip-permissions', '--settings', JSON.stringify({ sandbox: { enabled: false } }));
    args.push('--tools', [...DEV_TOOLS, ...NET_TOOLS].join(','));
  } else if (opts.access === 'write') {
    if (opts.osSandbox) args.push('--settings', JSON.stringify(CLAUDE_SANDBOX_SETTINGS));
    const tools = [...DEV_TOOLS, ...(opts.network ? NET_TOOLS : [])];
    args.push('--permission-mode', 'acceptEdits');
    args.push('--tools', tools.join(','));
    args.push('--allowedTools', ...tools);
    args.push('--disallowedTools', ...DEV_DENY, ...(opts.network ? [] : NET_DENY));
  } else {
    if (opts.osSandbox) args.push('--settings', JSON.stringify(CLAUDE_SANDBOX_SETTINGS));
    // dontAsk: anything not pre-approved by the allow-list is denied (no prompts).
    args.push('--permission-mode', 'dontAsk');
    args.push('--tools', REVIEW_TOOLS.join(','));
    args.push('--allowedTools', ...REVIEW_ALLOW);
    args.push('--disallowedTools', ...REVIEW_DENY);
  }
  if (rea) {
    args.push('--mcp-config', JSON.stringify({ mcpServers: { rea } }));
    const tools = !full ? REA_READ_TOOLS.map((name) => `mcp__rea__${name}`) : ['mcp__rea__*'];
    const allow = args.indexOf('--allowedTools');
    if (allow >= 0) args.splice(allow + 1, 0, ...tools);
    else args.push('--allowedTools', ...tools);
  }
  const dirs = new Set<string>(opts.extraReadDirs ?? []);
  for (const img of opts.images ?? []) dirs.add(dirname(img));
  if (dirs.size) args.push('--add-dir', ...dirs);
  return args;
}

/** Claude has no image flag in -p text mode: point the agent at the files (their dirs are --add-dir'ed). */
export function claudePrompt(prompt: string, images?: string[]): string {
  if (!images?.length) return prompt;
  return `${prompt}\n\nAttached images (open them with the Read tool):\n${images.map((p) => `- ${p}`).join('\n')}`;
}

export interface ClaudeParseResult {
  sawResult: boolean;
  isError: boolean;
  text: string;
  providerSessionId?: string;
  model?: string;
  usage: Partial<UsageTotals>;
  error?: TurnError;
  /** Lines that were not JSON (e.g. "[claude-code:unrecognized_model] …"). */
  nonJson: string[];
  permissionDenials: number;
}

export interface ClaudeParser {
  push(line: string): AgentStreamEvent[];
  result(): ClaudeParseResult;
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p: any) => (p?.type === 'text' && typeof p.text === 'string' ? p.text : p?.type === 'image' ? '[image]' : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

export function mapClaudeRateLimit(info: any, now = Date.now()): RateLimitInfo | null {
  if (!info || typeof info !== 'object') return null;
  const toMs = (v: unknown) => (typeof v === 'number' ? (v < 1e12 ? v * 1000 : v) : undefined);
  const windows: RateLimitInfo['windows'] = {};
  const uw = info.unifiedWindows;
  if (uw && typeof uw === 'object') {
    for (const [k, w] of Object.entries<any>(uw)) {
      if (!w || typeof w !== 'object') continue;
      const utilization = typeof w.utilization === 'number' ? w.utilization : w.status === 'rejected' ? 1 : undefined;
      if (utilization === undefined) continue;
      windows[k] = { utilization, ...(toMs(w.resetsAt) ? { resetsAt: toMs(w.resetsAt) } : {}), ...(w.status ? { status: String(w.status) } : {}) };
    }
  }
  if (!Object.keys(windows).length && typeof info.rateLimitType === 'string') {
    const utilization = typeof info.utilization === 'number' ? info.utilization : info.status === 'rejected' ? 1 : undefined;
    if (utilization !== undefined) {
      windows[info.rateLimitType] = { utilization, ...(toMs(info.resetsAt) ? { resetsAt: toMs(info.resetsAt) } : {}), ...(info.status ? { status: String(info.status) } : {}) };
    }
  }
  if (!Object.keys(windows).length) return null;
  return { windows, observedAt: now };
}

/** Pure stream-json parser. Thinking content is never emitted. */
export function createClaudeParser(cwd: string): ClaudeParser {
  const st: ClaudeParseResult = { sawResult: false, isError: false, text: '', usage: {}, nonJson: [], permissionDenials: 0 };
  let started = false;
  let currentMsgId = '';
  const textBlockKeys = new Map<number, string>();
  let pendingTextKey: string | null = null;
  let fallbackCounter = 0;
  let lastAssistantText = '';
  const tools = new Map<string, ToolClassification & { name: string; done: boolean }>();

  const handleAssistant = (msg: any, parentToolUseId: unknown): AgentStreamEvent[] => {
    const out: AgentStreamEvent[] = [];
    if (!msg) return out;
    if (!st.model && typeof msg.model === 'string' && msg.model !== '<synthetic>') st.model = msg.model;
    const fromSubagent = typeof parentToolUseId === 'string' && parentToolUseId.length > 0;
    for (const block of Array.isArray(msg.content) ? msg.content : []) {
      if (block?.type === 'text' && typeof block.text === 'string') {
        if (fromSubagent || !block.text.trim()) continue;
        let key: string;
        if (pendingTextKey && pendingTextKey.startsWith(`${msg.id}:`)) { key = pendingTextKey; pendingTextKey = null; }
        else key = `${msg.id ?? 'msg'}:t${fallbackCounter++}`;
        lastAssistantText = block.text;
        out.push({ t: 'text', msgId: key, text: block.text });
      } else if (block?.type === 'tool_use' && typeof block.id === 'string') {
        if (tools.has(block.id)) continue;
        const c = classifyClaudeTool(String(block.name ?? ''), block.input, cwd);
        tools.set(block.id, { ...c, name: String(block.name ?? ''), done: false });
        out.push({ t: 'tool', id: block.id, kind: c.kind, title: c.title, ...(c.detail ? { detail: c.detail } : {}), ...(c.files ? { files: c.files } : {}), state: 'running' });
      }
      // thinking / redacted_thinking blocks are intentionally dropped.
    }
    return out;
  };

  const handleUser = (msg: any, raw: any): AgentStreamEvent[] => {
    const out: AgentStreamEvent[] = [];
    for (const block of Array.isArray(msg?.content) ? msg.content : []) {
      if (block?.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
      const meta = tools.get(block.tool_use_id);
      if (meta?.done) continue;
      const text = toolResultText(block.content);
      const isError = block.is_error === true;
      let exitCode: number | null | undefined;
      if (meta?.name === 'Bash') {
        const m = /^Exit code (\d+)/m.exec(text);
        if (m) exitCode = Number(m[1]);
        else if (!isError) exitCode = 0;
        else if (raw?.tool_use_result?.interrupted) exitCode = null;
      }
      if (meta) meta.done = true;
      out.push({
        t: 'tool', id: block.tool_use_id,
        kind: meta?.kind ?? 'tool', title: meta?.title ?? 'tool',
        ...(meta?.detail ? { detail: meta.detail } : {}),
        ...(meta?.files ? { files: meta.files } : {}),
        state: isError ? 'error' : 'ok',
        ...(exitCode !== undefined ? { exitCode } : {}),
        output: redactTail(text, 4000),
      });
    }
    return out;
  };

  const handleResult = (d: any): AgentStreamEvent[] => {
    st.sawResult = true;
    if (typeof d.session_id === 'string') st.providerSessionId = d.session_id;
    const u = d.usage ?? {};
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    const cacheRead = num(u.cache_read_input_tokens);
    const cacheCreate = num(u.cache_creation_input_tokens);
    st.usage = {
      inputTokens: num(u.input_tokens) + cacheRead + cacheCreate,
      cachedInputTokens: cacheRead,
      outputTokens: num(u.output_tokens),
      costUsd: num(d.total_cost_usd),
      turns: 1,
    };
    if (d.modelUsage && typeof d.modelUsage === 'object') {
      const keys = Object.keys(d.modelUsage);
      if (keys.length && !st.model) st.model = keys[0];
    }
    if (Array.isArray(d.permission_denials)) st.permissionDenials = d.permission_denials.length;
    st.text = typeof d.result === 'string' ? d.result : lastAssistantText;
    const failed = d.is_error === true || (typeof d.subtype === 'string' && d.subtype.startsWith('error'));
    st.isError = failed;
    if (failed) {
      const msg = typeof d.result === 'string' && d.result ? d.result
        : Array.isArray(d.errors) && d.errors.length ? d.errors.join('; ')
        : `Claude turn failed (${d.subtype ?? 'error'})`;
      st.error = classifyError('claude', msg, { apiStatus: typeof d.api_error_status === 'number' ? d.api_error_status : undefined, stderr: st.nonJson.join('\n') });
    }
    return [{ t: 'usage', usage: st.usage }];
  };

  return {
    push(line: string): AgentStreamEvent[] {
      const s = line.trim();
      if (!s) return [];
      let d: any;
      if (s.startsWith('{')) {
        try { d = JSON.parse(s); } catch { d = undefined; }
      }
      if (!d || typeof d !== 'object') {
        if (st.nonJson.length < 50) st.nonJson.push(redact(s).slice(0, 2000));
        return [];
      }
      switch (d.type) {
        case 'system': {
          if (d.subtype === 'init') {
            if (typeof d.session_id === 'string') st.providerSessionId = d.session_id;
            if (typeof d.model === 'string') st.model = d.model;
            if (started) return [];
            started = true;
            return [{ t: 'started', ...(st.providerSessionId ? { providerSessionId: st.providerSessionId } : {}), ...(st.model ? { model: st.model } : {}) }];
          }
          if (d.subtype === 'api_retry' || d.subtype === 'api_error') {
            const why = d.error ?? d.message ?? d.error_status ?? '';
            return [{ t: 'warning', message: redact(`Claude API retry${d.attempt ? ` ${d.attempt}` : ''}${why ? `: ${typeof why === 'string' ? why : JSON.stringify(why)}` : ''}`).slice(0, 500) }];
          }
          return [];
        }
        case 'stream_event': {
          if (d.parent_tool_use_id) return [];
          const ev = d.event ?? {};
          if (ev.type === 'message_start') {
            currentMsgId = ev.message?.id ?? `msg${fallbackCounter++}`;
            textBlockKeys.clear();
            if (!st.model && typeof ev.message?.model === 'string') st.model = ev.message.model;
          } else if (ev.type === 'content_block_start') {
            if (ev.content_block?.type === 'text') {
              const key = `${currentMsgId}:${ev.index ?? 0}`;
              textBlockKeys.set(ev.index ?? 0, key);
              pendingTextKey = key;
            }
          } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && typeof ev.delta.text === 'string') {
            const key = textBlockKeys.get(ev.index ?? 0) ?? `${currentMsgId}:${ev.index ?? 0}`;
            if (ev.delta.text) return [{ t: 'text_delta', msgId: key, text: ev.delta.text }];
          }
          // thinking_delta, signature_delta, input_json_delta: ignored.
          return [];
        }
        case 'assistant':
          return handleAssistant(d.message, d.parent_tool_use_id);
        case 'user':
          return handleUser(d.message, d);
        case 'rate_limit_event': {
          const info = mapClaudeRateLimit(d.rate_limit_info);
          return info ? [{ t: 'rate_limit', info }] : [];
        }
        case 'result':
          return handleResult(d);
        default:
          return [];
      }
    },
    result(): ClaudeParseResult {
      if (!st.sawResult && !st.text) st.text = lastAssistantText;
      return { ...st, usage: { ...st.usage }, nonJson: [...st.nonJson] };
    },
  };
}

export class ClaudeAdapter implements AgentAdapter {
  readonly id = 'claude' as const;
  readonly bin: string;

  constructor(opts?: { bin?: string }) {
    this.bin = opts?.bin || process.env.LINA_CLAUDE_BIN || 'claude';
  }

  async runTurn(opts: TurnOptions, onEvent: (e: AgentStreamEvent) => void): Promise<TurnResult> {
    const startedAt = Date.now();
    const parser = createClaudeParser(opts.cwd);
    const emit = (evs: AgentStreamEvent[]) => {
      for (const e of evs) { try { onEvent(e); } catch { /* consumer errors must not kill the turn */ } }
    };
    const rea = opts.reaEnabled ? await configuredRea('claude') : undefined;
    const proc = await runProcess({
      cmd: this.bin,
      args: buildClaudeArgs(opts, rea),
      cwd: opts.cwd,
      env: agentEnv(opts.sessionId ? { LINA_SESSION_ID: opts.sessionId } : undefined),
      stdin: claudePrompt(opts.prompt, opts.images),
      signal: opts.signal,
      turnTimeoutMs: opts.turnTimeoutMs,
      idleTimeoutMs: opts.idleTimeoutMs,
      onLine: (line) => emit(parser.push(line)),
    });
    const r = parser.result();
    if (r.model && opts.model) {
      try { recordObservedModel('claude', opts.model, r.model); } catch { /* best effort */ }
    }
    const base = {
      text: r.text,
      ...(r.providerSessionId || opts.resumeId ? { providerSessionId: r.providerSessionId ?? opts.resumeId } : {}),
      ...(r.model ? { model: r.model } : {}),
      usage: r.usage,
      durationMs: Date.now() - startedAt,
    };
    const stderr = [proc.stderrTail, ...r.nonJson].filter(Boolean).join('\n');

    let error: TurnError | undefined;
    if (proc.aborted || proc.timedOut || proc.spawnError) {
      error = classifyError('claude', proc.spawnError ?? '', { aborted: proc.aborted, timedOut: proc.timedOut, spawnError: proc.spawnError, exitCode: proc.exitCode });
    } else if (r.sawResult && !r.isError) {
      return { ok: true, ...base };
    } else if (r.error) {
      error = r.error;
    } else {
      const lastLine = r.nonJson[r.nonJson.length - 1] ?? stderr.trim().split('\n').pop() ?? '';
      error = classifyError('claude', lastLine || 'Claude Code exited without a result', { exitCode: proc.exitCode, stderr });
    }
    return { ok: false, ...base, error };
  }
}
