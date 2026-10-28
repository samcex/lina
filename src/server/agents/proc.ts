// Child-process plumbing for agent CLIs: detached process groups, line-buffered
// stdout, stderr tail, turn/idle timeouts and group kill (SIGTERM → SIGKILL).
import { spawn, type ChildProcess } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access } from 'node:fs/promises';
import { delimiter, join, isAbsolute } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

export interface RunProcessOptions {
  cmd: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Written to the child's stdin, which is then always closed. */
  stdin?: string;
  /**
   * Takes over the child's stdin instead of writing+closing it. Interactive TUIs need
   * to be typed into after they are ready; call `end` when no more input is coming.
   */
  stdinControl?: (write: (s: string) => boolean, end: () => void) => void;
  signal?: AbortSignal;
  /** Hard limit for the whole process. */
  turnTimeoutMs?: number;
  /** Limit for a period without any stdout/stderr output. */
  idleTimeoutMs?: number;
  onLine?: (line: string) => void;
  /** Raw stdout text as it arrives (TUIs redraw without newlines, so lines alone can miss screen state). */
  onData?: (text: string) => void;
  onStderr?: (chunk: string) => void;
  /** Grace period between SIGTERM and SIGKILL (default 5000ms). */
  killGraceMs?: number;
}

export interface RunProcessResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: 'turn' | 'idle' | null;
  aborted: boolean;
  stderrTail: string;
  spawnError?: string;
  /** Lines dropped because they exceeded MAX_LINE_CHARS. */
  droppedLines?: number;
}

const STDERR_TAIL_CHARS = 16 * 1024;
/** Lines longer than this are dropped (protects memory); JSONL events are far smaller. */
export const MAX_LINE_CHARS = 64 * 1024 * 1024;
/** After the main process exits, how long to wait for its pipes to drain. */
const DRAIN_AFTER_EXIT_MS = 1500;

/** Environment variables that describe a *parent* agent session; they must not leak into LINA's agents. */
const PARENT_SESSION_ENV = [
  'LINA_SESSION_ID',
  'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_SSE_PORT', 'CLAUDE_PID', 'CLAUDE_EFFORT',
  'CODEX_THREAD_ID', 'CODEX_SANDBOX', 'CODEX_SANDBOX_NETWORK_DISABLED',
];

/** process.env minus variables inherited from an enclosing agent session (e.g. when linad was started from Claude Code). */
export function agentEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of PARENT_SESSION_ENV) delete env[k];
  return { ...env, ...extra };
}

function killGroup(child: ChildProcess, sig: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, sig);
  } catch {
    try { child.kill(sig); } catch { /* already gone */ }
  }
}

/** Splits a byte stream into lines without quadratic concatenation on huge lines. */
class LineSplitter {
  private decoder = new StringDecoder('utf8');
  private parts: string[] = [];
  private partLen = 0;
  private overflow = false;
  dropped = 0;
  constructor(private onLine: (line: string) => void) {}

  push(chunk: Buffer): void {
    this.feed(this.decoder.write(chunk));
  }

  end(): void {
    this.feed(this.decoder.end());
    if (this.partLen > 0 || this.parts.length) this.flush();
    else if (this.overflow) { this.overflow = false; this.dropped++; }
  }

  private feed(s: string): void {
    let start = 0;
    for (;;) {
      const nl = s.indexOf('\n', start);
      if (nl < 0) break;
      this.append(s.slice(start, nl));
      this.flush();
      start = nl + 1;
    }
    if (start < s.length) this.append(s.slice(start));
  }

  private append(s: string): void {
    if (!s || this.overflow) return;
    if (this.partLen + s.length > MAX_LINE_CHARS) {
      this.overflow = true;
      this.parts = [];
      this.partLen = 0;
      return;
    }
    this.parts.push(s);
    this.partLen += s.length;
  }

  private flush(): void {
    if (this.overflow) {
      this.dropped++;
      this.overflow = false;
      this.parts = [];
      this.partLen = 0;
      return;
    }
    let line = this.parts.length === 1 ? this.parts[0] : this.parts.join('');
    this.parts = [];
    this.partLen = 0;
    if (line.endsWith('\r')) line = line.slice(0, -1);
    try { this.onLine(line); } catch { /* consumer errors must not break the pipe */ }
  }
}

export function runProcess(opts: RunProcessOptions): Promise<RunProcessResult> {
  const killGraceMs = opts.killGraceMs ?? 5000;
  return new Promise((resolve) => {
    let stderrTail = '';
    let timedOut: 'turn' | 'idle' | null = null;
    let aborted = false;
    let settled = false;
    let exitCode: number | null = null;
    let exitSignal: string | null = null;
    let exited = false;
    let killing = false;
    const timers: NodeJS.Timeout[] = [];
    let idleTimer: NodeJS.Timeout | undefined;

    if (opts.signal?.aborted) {
      resolve({ exitCode: null, signal: null, timedOut: null, aborted: true, stderrTail: '' });
      return;
    }

    let child: ChildProcess;
    try {
      child = spawn(opts.cmd, opts.args, {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err: any) {
      resolve({ exitCode: null, signal: null, timedOut: null, aborted: false, stderrTail: '', spawnError: err?.code || String(err?.message || err) });
      return;
    }

    const splitter = new LineSplitter((line) => opts.onLine?.(line));

    const finish = (spawnError?: string) => {
      if (settled) return;
      settled = true;
      for (const t of timers) clearTimeout(t);
      if (idleTimer) clearTimeout(idleTimer);
      opts.signal?.removeEventListener('abort', onAbort);
      splitter.end();
      resolve({
        exitCode, signal: exitSignal, timedOut, aborted, stderrTail,
        ...(spawnError ? { spawnError } : {}),
        ...(splitter.dropped ? { droppedLines: splitter.dropped } : {}),
      });
    };

    const terminate = () => {
      if (killing) return;
      killing = true;
      killGroup(child, 'SIGTERM');
      // Not cleared on exit: children of the group may ignore SIGTERM and outlive the leader.
      const t = setTimeout(() => killGroup(child, 'SIGKILL'), killGraceMs);
      t.unref();
    };

    const onAbort = () => { if (!settled) { aborted = true; terminate(); } };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    const resetIdle = () => {
      if (!opts.idleTimeoutMs || killing) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => { if (!timedOut) timedOut = 'idle'; terminate(); }, opts.idleTimeoutMs);
    };
    resetIdle();
    if (opts.turnTimeoutMs) {
      timers.push(setTimeout(() => { if (!timedOut) timedOut = 'turn'; terminate(); }, opts.turnTimeoutMs));
    }

    child.stdout!.on('data', (chunk: Buffer) => {
      resetIdle();
      try { opts.onData?.(chunk.toString('utf8')); } catch { /* consumer errors must not break the pipe */ }
      splitter.push(chunk);
    });
    child.stderr!.on('data', (chunk: Buffer) => {
      resetIdle();
      const s = chunk.toString('utf8');
      stderrTail = (stderrTail + s).slice(-STDERR_TAIL_CHARS);
      try { opts.onStderr?.(s); } catch { /* ignore */ }
    });
    child.stdin!.on('error', () => { /* EPIPE when the child exits before reading stdin */ });
    child.stdout!.on('error', () => {});
    child.stderr!.on('error', () => {});

    child.on('error', (err: NodeJS.ErrnoException) => {
      // Spawn failure (ENOENT, EACCES…). 'close' may or may not follow.
      if (!exited) finish(err.code || err.message);
    });

    child.on('exit', (code, sig) => {
      exited = true;
      exitCode = code;
      exitSignal = sig;
      // Give stdout/stderr a moment to drain. If a background grandchild keeps the pipes
      // open, don't wait for it: kill the rest of the group and resolve.
      const t = setTimeout(() => {
        killGroup(child, 'SIGTERM');
        const k = setTimeout(() => killGroup(child, 'SIGKILL'), killGraceMs);
        k.unref();
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish();
      }, DRAIN_AFTER_EXIT_MS);
      timers.push(t);
    });

    child.on('close', () => {
      // Leftover background processes in the group are stray once the agent turn ended.
      // Use the same escalation as cancellation: a descendant may have closed its
      // inherited pipes and ignored SIGTERM, so neither close nor pipe-drain cleanup
      // proves that the process group has stopped.
      if (!killing && child.pid) {
        try { process.kill(-child.pid, 0); terminate(); } catch { /* none left */ }
      }
      finish();
    });

    try {
      if (opts.stdinControl) {
        opts.stdinControl(
          (s) => { try { return child.stdin!.write(s); } catch { return false; } },
          () => { try { child.stdin!.end(); } catch { /* already closed */ } },
        );
      } else {
        if (opts.stdin) child.stdin!.write(opts.stdin);
        child.stdin!.end();
      }
    } catch { /* child already gone */ }
  });
}

/** Resolves an executable on PATH (or checks an explicit path). */
export async function which(cmd: string): Promise<string | null> {
  if (!cmd) return null;
  const isExec = async (p: string) => {
    try { await access(p, fsConstants.X_OK); return true; } catch { return false; }
  };
  if (cmd.includes('/')) return (await isExec(cmd)) ? (isAbsolute(cmd) ? cmd : join(process.cwd(), cmd)) : null;
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, cmd);
    if (await isExec(p)) return p;
  }
  return null;
}

export interface ExecTextResult { code: number | null; stdout: string; stderr: string; error?: string; timedOut?: boolean }

/** Runs a short command and collects its output. Never throws. */
export async function execText(
  cmd: string, args: string[], opts: { cwd?: string; timeoutMs?: number; input?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<ExecTextResult> {
  const out: string[] = [];
  let stderr = '';
  const r = await runProcess({
    cmd, args, cwd: opts.cwd || process.cwd(), env: opts.env ?? agentEnv(),
    stdin: opts.input, turnTimeoutMs: opts.timeoutMs ?? 30_000, killGraceMs: 2000,
    onLine: (l) => out.push(l),
    onStderr: (c) => { if (stderr.length < 1_000_000) stderr += c; },
  });
  return {
    code: r.exitCode,
    stdout: out.join('\n'),
    stderr,
    ...(r.spawnError ? { error: r.spawnError } : {}),
    ...(r.timedOut ? { timedOut: true } : {}),
  };
}
