import { randomUUID } from 'node:crypto';
// Freebuff adapter: drives the interactive `freebuff` TUI through a pseudo-terminal
// and reads the structured chat log the CLI itself persists under its config dir.
//
// freebuff has no headless/JSON mode (verified on 0.2.34: `--print`, `-p` and a
// positional prompt are rejected), so this adapter is deliberately best-effort:
//  - it types the prompt into the TUI (bracketed paste + Enter),
//  - it tails <config>/projects/<project>/chats/<chat>/chat-messages.json, which the
//    CLI writes with text/tool blocks and an `isComplete` flag,
//  - it stops the TUI once the turn is complete (the CLI would otherwise stay open).
// It cannot report token usage, cannot pin a model per turn, and cannot enforce a
// read-only reviewer role — freebuff applies its own permissions.
import { appendFileSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ActivityKind, AgentModels, ModelValidation, UsageTotals } from '../../shared/types.js';
import type { AgentAdapter, AgentStreamEvent, TurnError, TurnOptions, TurnResult } from './types.js';
import { agentEnv, runProcess, which } from './proc.js';
import { classifyError } from './errors.js';
import { redactTail } from './redact.js';

/** Directory the freebuff CLI keeps credentials, settings and per-project chats in. */
export function freebuffConfigDir(): string {
  return process.env.FREEBUFF_CONFIG_DIR || join(homedir(), '.config', 'manicode');
}

export function freebuffBin(): string {
  return process.env.LINA_FREEBUFF_BIN || 'freebuff';
}

// ───────────────────────────── persisted chat model ─────────────────────────────

export interface FreebuffToolBlock {
  type: 'tool';
  toolCallId: string;
  toolName?: string;
  input?: unknown;
  agentId?: string;
  output?: string;
}

export interface FreebuffTextBlock {
  type: 'text';
  content: string;
  /** 'reasoning' blocks are the model's thinking and must never reach the transcript. */
  textType?: 'text' | 'reasoning';
}

export type FreebuffBlock = FreebuffToolBlock | FreebuffTextBlock | { type: string;[k: string]: unknown };

export interface FreebuffMessage {
  id: string;
  variant: 'ai' | 'user';
  content?: string;
  blocks?: FreebuffBlock[];
  timestamp?: string;
  isComplete?: boolean;
}

/** Assistant text visible in the transcript (never reasoning blocks). */
export function visibleText(m: FreebuffMessage): string {
  if (m.variant !== 'ai') return '';
  return (m.blocks ?? [])
    .filter((b): b is FreebuffTextBlock => b.type === 'text' && (b as FreebuffTextBlock).textType !== 'reasoning')
    .map((b) => (typeof (b as FreebuffTextBlock).content === 'string' ? (b as FreebuffTextBlock).content : ''))
    .filter((s) => s.trim().length > 0)
    .join('\n\n');
}

const TOOL_KIND: Record<string, ActivityKind> = {
  run_terminal_command: 'command',
  read_files: 'read',
  read_subtree: 'read',
  code_search: 'search',
  glob: 'search',
  list_directory: 'search',
  str_replace: 'edit',
  write_file: 'write',
  write_todos: 'note',
  set_output: 'note',
  spawn_agents: 'tool',
  web_search: 'web',
  read_url: 'web',
  ask_user: 'note',
  skill: 'tool',
};

export function toolKind(name: string): ActivityKind {
  return TOOL_KIND[name] ?? 'tool';
}

function oneLine(s: string, max = 160): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function inputOf(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
}

/** Human title for a tool block, from its name and input. */
export function toolTitle(name: string, input: unknown): string {
  const i = inputOf(input);
  switch (name) {
    case 'run_terminal_command': return oneLine(`$ ${str(i.command) || str(i.cmd) || 'command'}`);
    case 'read_files': {
      const paths = Array.isArray(i.paths) ? i.paths.map(str).filter(Boolean) : [];
      return paths.length === 1 ? `Read ${paths[0]}` : `Read ${paths.length} files`;
    }
    case 'str_replace': return oneLine(`Edit ${str(i.path) || 'file'}`);
    case 'write_file': return oneLine(`Write ${str(i.path) || 'file'}`);
    case 'list_directory': return oneLine(`List ${str(i.path) || '.'}`);
    case 'glob': return oneLine(`Glob ${str(i.pattern)}`);
    case 'code_search': return oneLine(`Search ${str(i.pattern)}`);
    case 'read_subtree': return oneLine(`Read tree ${str(i.path) || '.'}`);
    case 'web_search': return oneLine(`Search web: ${str(i.query)}`);
    case 'read_url': return oneLine(`Fetch ${str(i.url)}`);
    case 'spawn_agents': {
      const n = Array.isArray(i.agents) ? i.agents.length : 0;
      return n ? `Spawn ${n} agent${n === 1 ? '' : 's'}` : 'Spawn agents';
    }
    case 'write_todos': return 'Update plan';
    case 'ask_user': return 'Ask the user';
    default: return oneLine(name || 'tool');
  }
}

export function toolFiles(name: string, input: unknown): string[] | undefined {
  const i = inputOf(input);
  if (name === 'read_files' && Array.isArray(i.paths)) return i.paths.map(str).filter(Boolean);
  if ((name === 'str_replace' || name === 'write_file') && typeof i.path === 'string' && i.path) return [i.path];
  return undefined;
}

// ───────────────────────────── chat discovery ─────────────────────────────

function safeReaddir(dir: string): string[] {
  try { return readdirSync(dir); } catch { return []; }
}

function isDir(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

/** Every chat directory freebuff persisted, most recent first by name (ISO timestamps). */
export function listChatDirs(root = freebuffConfigDir()): string[] {
  const projects = join(root, 'projects');
  const out: string[] = [];
  for (const project of safeReaddir(projects)) {
    const chats = join(projects, project, 'chats');
    if (!isDir(chats)) continue;
    for (const chat of safeReaddir(chats)) {
      const dir = join(chats, chat);
      if (isDir(dir)) out.push(dir);
    }
  }
  return out.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
}

export function snapshotChats(root = freebuffConfigDir()): Set<string> {
  return new Set(listChatDirs(root));
}

function readJson<T>(file: string): T | undefined {
  try { return JSON.parse(readFileSync(file, 'utf8')) as T; } catch { return undefined; }
}

export function readChatMessages(chatDir: string): FreebuffMessage[] | undefined {
  return readJson<FreebuffMessage[]>(join(chatDir, 'chat-messages.json'));
}

/** The project root recorded in a chat's run state, when it has one. */
export function chatProjectRoot(chatDir: string): string | undefined {
  const rs = readJson<{ sessionState?: { fileContext?: { projectRoot?: string; cwd?: string } } }>(join(chatDir, 'run-state.json'));
  return rs?.sessionState?.fileContext?.projectRoot ?? rs?.sessionState?.fileContext?.cwd;
}

/** The first prompt freebuff recorded for the chat (the CLI truncates long prompts with "…"). */
export function chatFirstPrompt(chatDir: string): string | undefined {
  const meta = readJson<{ firstPrompt?: string }>(join(chatDir, 'chat-meta.json'));
  return typeof meta?.firstPrompt === 'string' ? meta.firstPrompt : undefined;
}

function norm(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** chat-meta keeps only the start of a long prompt, so a long shared prefix is a match. */
export function samePrompt(a: string | undefined, b: string): boolean {
  if (typeof a !== 'string') return false;
  const x = norm(a).replace(/(?:\.{3}|\u2026)+$/, '').trim(), y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 40 && long.startsWith(short);
}

/** The chat this resume id names (directories are named by chat id). */
export function findChatById(id: string, root = freebuffConfigDir()): string | undefined {
  return listChatDirs(root).find((dir) => dir.endsWith(`/${id}`));
}

/** A chat that did not exist before `before` and whose prompt matches `prompt`. */
export function findNewChat(before: Set<string>, prompt: string, root = freebuffConfigDir()): string | undefined {
  for (const dir of listChatDirs(root)) {
    if (before.has(dir)) continue;
    if (samePrompt(chatFirstPrompt(dir), prompt)) return dir;
    // Projects freebuff only writes chat-messages.json for: check the first user message.
    const msgs = readChatMessages(dir);
    const firstUser = msgs?.find((m) => m.variant === 'user')?.content;
    if (samePrompt(firstUser, prompt)) return dir;
  }
  return undefined;
}

// ───────────────────────────── turn observation ─────────────────────────────

export interface FreebuffTurnState {
  /** Messages that exist before our prompt (the TUI may replay history). */
  baseline: number;
  /** Visible text of the newest assistant message for this turn. */
  text: string;
  complete: boolean;
  interrupted: boolean;
  /** Tool blocks already emitted. */
  seenTools: Set<string>;
  /** Text blocks already emitted. */
  seenTexts: Set<string>;
}

export function emptyTurnState(messageCount = 0): FreebuffTurnState {
  return { baseline: messageCount, text: '', complete: false, interrupted: false, seenTools: new Set(), seenTexts: new Set() };
}

/**
 * Folds one poll of a chat into the turn state, returning events to emit.
 * Pure apart from the mutable state, so it is testable without a PTY.
 */
export function readTurn(messages: FreebuffMessage[], st: FreebuffTurnState): AgentStreamEvent[] {
  const events: AgentStreamEvent[] = [];
  let lastAi: FreebuffMessage | undefined;
  for (const m of messages.slice(st.baseline)) {
    if (m.variant !== 'ai') continue;
    lastAi = m;
    const blocks = m.blocks ?? [];
    for (const [i, b] of blocks.entries()) {
      if (b.type === 'text' && (b as FreebuffTextBlock).textType !== 'reasoning') {
        const text = str((b as FreebuffTextBlock).content);
        const key = `${m.id}:${i}`;
        if (st.seenTexts.has(key) || !text.trim()) continue;
        st.seenTexts.add(key);
        events.push({ t: 'text', msgId: m.id, text });
      } else if (b.type === 'tool') {
        const tb = b as FreebuffToolBlock;
        const id = str(tb.toolCallId) || `${m.id}:tool:${i}`;
        if (st.seenTools.has(id)) continue;
        st.seenTools.add(id);
        const name = str(tb.toolName);
        const files = toolFiles(name, tb.input);
        events.push({
          t: 'tool', id, kind: toolKind(name), title: toolTitle(name, tb.input), state: 'ok',
          ...(files ? { files } : {}),
          ...(typeof tb.output === 'string' && tb.output ? { output: redactTail(tb.output, 4000) } : {}),
        });
      }
    }
  }
  if (lastAi) {
    st.text = visibleText(lastAi);
    st.interrupted = /\[response interrupted\]/i.test(st.text);
    st.complete = lastAi.isComplete === true;
  }
  return events;
}

// ───────────────────────────── process driving ─────────────────────────────

/** POSIX single-quote for `sh -c`. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The `script(1)` invocation that gives the TUI a pseudo-terminal. */
export function buildFreebuffCommand(opts: { bin: string; cwd: string; resumeId?: string; trustAgents?: boolean }): { cmd: string; args: string[] } {
  const argv = [opts.bin];
  if (opts.trustAgents !== false) argv.push('--trust-agents');
  if (opts.resumeId) argv.push('--continue', opts.resumeId);
  argv.push('--cwd', opts.cwd);
  const line = argv.map((a) => (a.includes(' ') || a.includes("'") ? shellQuote(a) : a)).join(' ');
  return { cmd: 'script', args: ['-qfc', line, '/dev/null'] };
}

/** The TUI is accepting input once it has drawn its composer. */
export const READY_RE = /Enter a coding task|Add to the current task|\/model to change/;

/**
 * Freebuff metes out free session hours. At zero it keeps the composer but refuses to start a
 * session, so the only signal is the screen text — detect it instead of waiting for a timeout.
 */
export const LIMIT_RE = /not enough hours|\b0\/\d+ hours remaining|no hours remaining|session over;? holding|free session hours/i;

/** The TUI redraws the screen with cursor/colour sequences inside words, so match on plain text. */
export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, '');
}

/** The composer footer's "0/21 hours remaining" line, if it is on screen. */
export function hoursRemaining(screen: string): { remaining: number; total: number } | undefined {
  const m = /(\d+)\s*\/\s*(\d+)\s*hours remaining/.exec(stripAnsi(screen));
  return m ? { remaining: Number(m[1]), total: Number(m[2]) } : undefined;
}

export interface FreebuffProbe {
  ok: boolean;
  hours?: number;
  /** Human-readable reason when ok is false (shown in the session notice). */
  reason?: string;
}

/**
 * Starts the TUI just long enough to read its status line, without typing anything — used before a
 * three-way parallel split, so an agent with no free session hours is left out instead of failing its
 * first turn. Inconclusive results are reported as ok (the normal fail-fast turn path still applies).
 */
export async function probeFreebuff(opts: { cwd: string; bin?: string; timeoutMs?: number } = { cwd: process.cwd() }): Promise<FreebuffProbe> {
  const bin = opts.bin || freebuffBin();
  if (!(await which(bin))) return { ok: false, reason: `${bin} is not installed` };
  const { cmd, args } = buildFreebuffCommand({ bin, cwd: opts.cwd });
  const controller = new AbortController();
  let raw = '';
  const timeoutMs = opts.timeoutMs ?? 12_000;
  const done = runProcess({
    cmd, args, cwd: opts.cwd,
    env: agentEnv({ TERM: 'xterm-256color', COLUMNS: '160', LINES: '50' }),
    signal: controller.signal,
    turnTimeoutMs: timeoutMs,
    idleTimeoutMs: 0,
    onData: (text) => { raw = (raw + text).slice(-8000); },
  }).catch(() => undefined);
  const deadline = Date.now() + timeoutMs;
  let sawReady = false;
  let verdict: FreebuffProbe | undefined;
  while (Date.now() < deadline) {
    const screen = stripAnsi(raw);
    if (LIMIT_RE.test(screen)) { verdict = { ok: false, reason: 'it has no free session hours left' }; break; }
    const hours = hoursRemaining(screen);
    if (hours) {
      verdict = hours.remaining > 0
        ? { ok: true, hours: hours.remaining }
        : { ok: false, reason: `its ${hours.total} free session hours are used up` };
      break;
    }
    sawReady ||= READY_RE.test(screen);
    await sleep(150);
  }
  controller.abort();
  await done;
  // No hours counter on screen: treat a drawn composer (or silence) as unknown and let the turn run.
  return verdict ?? { ok: true, ...(sawReady ? { reason: 'freebuff did not report its remaining hours in time' } : {}) };
}

/**
 * Bracketed paste keeps embedded newlines literal. The Enter must be a separate write:
 * when it shares a write with the paste, freebuff inserts the text but never submits.
 */
export function pasteKeystrokes(prompt: string): string {
  return `\x1b[200~${prompt}\x1b[201~`;
}

/** Submit the composer (a bare carriage return is Enter in the TUI). */
export const SUBMIT_KEY = '\r';

const POLL_MS = 400;

/**
 * Freebuff creates the chat within a few seconds of the first prompt. When it never does, the TUI is
 * stuck on a screen LINA cannot drive (first-run, login, ads, or no free session hours) — fail with
 * an actionable error instead of holding the turn until the per-turn timeout.
 */
export const NO_CHAT_MS = 90_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class FreebuffAdapter implements AgentAdapter {
  readonly id = 'freebuff' as const;
  readonly bin: string;

  constructor(opts?: { bin?: string }) {
    this.bin = opts?.bin || freebuffBin();
  }

  async runTurn(opts: TurnOptions, onEvent: (e: AgentStreamEvent) => void): Promise<TurnResult> {
    const startedAt = Date.now();
    // Freebuff has no system-prompt flag: include the coordinator's permissions and full goal.
    const prompt = [`LINA delegated turn ${randomUUID()}`, opts.systemPrompt, opts.prompt].filter(Boolean).join('\n\n');
    const emit = (evs: AgentStreamEvent[]) => {
      for (const e of evs) { try { onEvent(e); } catch { /* consumer errors must not kill the turn */ } }
    };

    if (!(await which(this.bin))) {
      return {
        ok: false, text: '', usage: {}, durationMs: 0,
        error: {
          code: 'cli_missing',
          message: 'Freebuff CLI (`freebuff`) was not found on PATH.',
          hint: 'Install it (`npm install -g freebuff`) and make sure it is on the daemon\'s PATH, then run `lina doctor`.',
        },
      };
    }

    const before = snapshotChats();
    const controller = new AbortController();
    const onOuterAbort = () => controller.abort();
    opts.signal.addEventListener('abort', onOuterAbort, { once: true });

    let ready = false;
    let screenTail = '';
    let writeStdin: ((s: string) => void) | undefined;
    let chatDir = opts.resumeId ? findChatById(opts.resumeId) : undefined;
    let state = emptyTurnState(chatDir ? (readChatMessages(chatDir) ?? []).length : 0);
    let lastActivity = Date.now();
    let outcome: 'complete' | 'interrupted' | 'timeout' | 'idle' | 'exited' | 'aborted' | 'nochat' | 'limit' = 'nochat';
    let procError: TurnError | undefined;

    const { cmd, args } = buildFreebuffCommand({ bin: this.bin, cwd: opts.cwd, resumeId: opts.resumeId });

    const procPromise = runProcess({
      cmd, args,
      cwd: opts.cwd,
      env: agentEnv({
        TERM: 'xterm-256color',
        COLUMNS: '200',
        LINES: '60',
        ...(opts.sessionId ? { LINA_SESSION_ID: opts.sessionId } : {}),
      }),
      signal: controller.signal,
      turnTimeoutMs: opts.turnTimeoutMs,
      idleTimeoutMs: 0,
      stdinControl: (write) => { writeStdin = write; },
      onLine: (line) => {
        if (!ready && READY_RE.test(line)) ready = true;
      },
      onData: (text) => {
        // Raw window; ANSI is stripped only when it is tested, so sequences split across chunks still match.
        screenTail = (screenTail + text).slice(-8000);
      },
    });

    const deadline = startedAt + opts.turnTimeoutMs;
    let pastedAt = 0;
    let submittedAt = 0;
    let submits = 0;
    let userSeen = false;
    let lastSig = '';
    let warned = false;
    try {
      while (Date.now() < deadline) {
        await sleep(POLL_MS);
        const now = Date.now();
        if (controller.signal.aborted) { outcome = 'aborted'; break; }

        // Type the prompt only once the composer exists, then submit with a separate Enter.
        if (!pastedAt && writeStdin && (ready || now - startedAt > 10_000)) {
          writeStdin(pasteKeystrokes(prompt));
          pastedAt = now;
          lastActivity = now;
          continue;
        }
        if (pastedAt && !submittedAt && now - pastedAt > 1200 && writeStdin) {
          writeStdin(SUBMIT_KEY);
          submittedAt = now;
          lastActivity = now;
          continue;
        }

        if (!chatDir) chatDir = findNewChat(before, prompt);
        if (!chatDir && LIMIT_RE.test(stripAnsi(screenTail))) {
          emit([{ t: 'warning', message: 'Freebuff has no free session hours left; the turn was stopped before it started.' }]);
          outcome = 'limit';
          break;
        }
        if (!chatDir) {
          if (now - startedAt > NO_CHAT_MS) { outcome = 'nochat'; break; }
          // No chat means the message never reached the composer; retry the Enter once or twice.
          if (submittedAt && now - submittedAt > 12_000 && submits < 2 && writeStdin) {
            writeStdin(SUBMIT_KEY); submits += 1; submittedAt = now; lastActivity = now;
          }
          if (!warned && now - startedAt > 45_000) {
            warned = true;
            try { onEvent({ t: 'warning', message: 'Freebuff has not started a chat yet; it may be showing a first-run, login or session-limit screen.' }); } catch { /* ignore */ }
          }
          continue;
        }

        const msgs = readChatMessages(chatDir);
        if (!msgs) continue;
        if (msgs.length < state.baseline) state = emptyTurnState(0);
        if (!userSeen) userSeen = msgs.some((m) => m.variant === 'user' && samePrompt(m.content, prompt));
        if (!userSeen && submittedAt && now - submittedAt > 12_000 && submits < 2 && writeStdin) {
          writeStdin(SUBMIT_KEY); submits += 1; submittedAt = now;
        }

        // chat-messages.json can be megabytes; only parse it when it actually changed.
        let sig = lastSig;
        try {
          const s = statSync(join(chatDir, 'chat-messages.json'));
          sig = `${s.mtimeMs}:${s.size}`;
        } catch { /* not written yet */ }
        if (sig !== lastSig) {
          lastSig = sig;
          emit(readTurn(msgs, state));
          lastActivity = now;
        }
        if (state.complete) {
          outcome = state.interrupted ? 'interrupted' : 'complete';
          break;
        }
        if (now - lastActivity > opts.idleTimeoutMs) { outcome = 'idle'; break; }
      }
      if (outcome === 'nochat' && LIMIT_RE.test(stripAnsi(screenTail))) outcome = 'limit';
      if (process.env.LINA_FREEBUFF_DEBUG) { try { appendFileSync(process.env.LINA_FREEBUFF_DEBUG, `--- outcome=${outcome} bytes=${screenTail.length}\n${stripAnsi(screenTail).slice(-3000)}\n`); } catch { /* ignore */ } }
      else if (!pastedAt && outcome === 'nochat') outcome = 'timeout';
    } finally {
      // The TUI stays open after a turn; stop it (and its pty) before returning.
      if (!controller.signal.aborted) controller.abort();
      opts.signal.removeEventListener('abort', onOuterAbort);
    }

    const proc = await procPromise;
    const durationMs = Date.now() - startedAt;
    const chatId = chatDir ? chatDir.split('/').pop() : undefined;
    const base = {
      text: state.text,
      ...(chatId || opts.resumeId ? { providerSessionId: chatId ?? opts.resumeId } : {}),
      model: opts.model,
      usage: { turns: 1 } as Partial<UsageTotals>,
      durationMs,
    };

    if (opts.signal.aborted) {
      return { ok: false, ...base, error: classifyError('freebuff', '', { aborted: true }) };
    }
    if (outcome === 'complete') {
      try { onEvent({ t: 'usage', usage: base.usage }); } catch { /* ignore */ }
      return { ok: true, ...base };
    }

    if (outcome === 'interrupted') {
      procError = classifyError('freebuff', 'Freebuff reported the response was interrupted.', { exitCode: proc.exitCode });
    } else if (outcome === 'nochat') {
      procError = {
        code: 'timeout',
        message: `Freebuff did not start a chat within ${Math.round(NO_CHAT_MS / 1000)}s.`,
        hint: 'Run `freebuff` once in a terminal next to this project: complete its first-run/login screens and check the free session hours shown there, then retry.',
      };
    } else if (outcome === 'limit') {
      procError = classifyError('freebuff', 'Freebuff usage limit: no free session hours remaining', { exitCode: proc.exitCode });
      procError.hint = 'Freebuff\'s free hours are used up (the CLI shows the reset time). Wait for them to reset, use another agent, or check https://freebuff.com/plans.';
    } else if (outcome === 'timeout') {
      procError = classifyError('freebuff', '', { timedOut: 'turn' });
      procError.hint = 'Freebuff is interactive and may be waiting for input (login, ads, or a permission prompt). Open `freebuff` in this project once, clear any prompts, then retry.';
    } else if (outcome === 'idle') {
      procError = classifyError('freebuff', '', { timedOut: 'idle' });
      procError.hint = 'Freebuff stopped writing to its chat log. It may be waiting for input or out of free session hours; open `freebuff` in this project to check.';
    } else {
      procError = classifyError('freebuff', '', {
        aborted: proc.aborted || outcome === 'aborted',
        timedOut: proc.timedOut,
        spawnError: proc.spawnError,
        exitCode: proc.exitCode,
        stderr: proc.stderrTail,
      });
    }
    return { ok: false, ...base, error: procError };
  }
}

// ───────────────────────────── discovery / validation ─────────────────────────────

/** freebuff has no `--model` flag; it runs whatever model the CLI is configured with. */
export function readFreebuffSettings(root = freebuffConfigDir()): { model?: string; mode?: string } {
  const s = readJson<{ freebuffModel?: string; mode?: string }>(join(root, 'settings.json'));
  return { ...(typeof s?.freebuffModel === 'string' ? { model: s.freebuffModel } : {}), ...(typeof s?.mode === 'string' ? { mode: s.mode } : {}) };
}

export function freebuffLoggedIn(root = freebuffConfigDir()): boolean {
  return existsSync(join(root, 'credentials.json'));
}

export async function discoverFreebuffModels(): Promise<AgentModels> {
  const base: AgentModels = { agent: 'freebuff', installed: false, models: [], defaultModel: 'auto', discoveredVia: 'freebuff settings.json' };
  if (!(await which(freebuffBin()))) return { ...base, error: 'freebuff CLI not found on PATH' };
  const s = readFreebuffSettings();
  const model = s.model ?? 'auto';
  return {
    ...base,
    installed: true,
    defaultModel: model,
    models: [
      { id: model, label: model, description: 'Model selected in the Freebuff CLI (/model). LINA cannot override it per turn.', source: 'catalog' },
      ...(model !== 'auto' ? [{ id: 'auto', label: 'auto', description: 'Use whatever model the Freebuff CLI has selected.', source: 'alias' as const }] : []),
    ],
    ...(freebuffLoggedIn() ? {} : { error: 'freebuff is not logged in (run `freebuff login`)' }),
  };
}

export async function validateFreebuffModel(model: string): Promise<ModelValidation> {
  const checkedAt = Date.now();
  if (!(await which(freebuffBin()))) return { ok: false, checkedAt, error: 'freebuff CLI not found on PATH', code: 'cli_missing' };
  if (!freebuffLoggedIn()) return { ok: false, checkedAt, error: 'freebuff is not logged in', code: 'auth' };
  const configured = readFreebuffSettings().model;
  if (model !== 'auto' && configured && model !== configured) {
    return { ok: false, checkedAt, error: `freebuff runs its configured model (${configured}); switch it in the Freebuff CLI with /model`, code: 'model_unavailable' };
  }
  return { ok: true, checkedAt, ...(configured ? { resolvedModel: configured } : {}) };
}
