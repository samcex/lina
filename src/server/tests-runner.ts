// Detects and runs a project's test command inside the session workspace.
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestRun } from '../shared/types.js';
import { redact, tail } from './agents/redact.js';
import { agentEnv, runProcess } from './agents/proc.js';

export interface TestDetection { command?: string; source: 'config' | 'detected' | 'none'; reason?: string }

const TEST_TIMEOUT_MS = 10 * 60_000;
const OUTPUT_TAIL = 6000;

function readJson(file: string): Record<string, unknown> | undefined {
  try { return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>; } catch { return undefined; }
}

function canRun(cmd: string, args: string[], cwd: string): Promise<boolean> {
  return new Promise((res) => {
    execFile(cmd, args, { cwd, timeout: 15_000 }, (err) => res(!err));
  });
}

/**
 * Order: explicit config (empty string = disabled) → package.json scripts.test → pytest → go → cargo → Makefile.
 */
export async function detectTestCommand(ws: string, configured?: string): Promise<TestDetection> {
  if (configured !== undefined && configured !== null) {
    const c = configured.trim();
    return c ? { command: c, source: 'config' } : { source: 'none', reason: 'Tests are disabled for this project' };
  }
  const pkg = readJson(join(ws, 'package.json'));
  if (pkg) {
    const scripts = (pkg.scripts ?? {}) as Record<string, unknown>;
    const t = typeof scripts.test === 'string' ? scripts.test : '';
    if (t && !/no test specified/i.test(t)) {
      const deps = { ...(pkg.dependencies as object ?? {}), ...(pkg.devDependencies as object ?? {}) };
      if (Object.keys(deps).length && !existsSync(join(ws, 'node_modules'))) {
        return { source: 'none', reason: 'package.json declares dependencies but node_modules is missing in the workspace (run npm install to enable tests)' };
      }
      return { command: 'npm test --silent', source: 'detected' };
    }
  }
  const pyMarkers = ['pytest.ini', 'pyproject.toml', 'setup.cfg', 'tox.ini'];
  const hasPy = pyMarkers.some((f) => existsSync(join(ws, f))) || isDir(join(ws, 'tests'));
  if (hasPy && (existsSync(join(ws, 'pytest.ini')) || fileHas(join(ws, 'pyproject.toml'), /pytest/) || fileHas(join(ws, 'setup.cfg'), /pytest/) || fileHas(join(ws, 'tox.ini'), /pytest/) || hasPyTests(join(ws, 'tests')))) {
    if (await canRun('python3', ['-m', 'pytest', '--version'], ws)) return { command: 'python3 -m pytest -q', source: 'detected' };
  }
  if (existsSync(join(ws, 'go.mod'))) return { command: 'go test ./...', source: 'detected' };
  if (existsSync(join(ws, 'Cargo.toml'))) return { command: 'cargo test', source: 'detected' };
  if (fileHas(join(ws, 'Makefile'), /^test\s*:/m)) return { command: 'make test', source: 'detected' };
  return { source: 'none', reason: 'No test command configured or detected' };
}

function isDir(p: string): boolean { try { return statSync(p).isDirectory(); } catch { return false; } }
function fileHas(p: string, re: RegExp): boolean { try { return re.test(readFileSync(p, 'utf8')); } catch { return false; } }
function hasPyTests(dir: string): boolean {
  try { return isDir(dir) && readdirSync(dir).some((f) => /^test_.*\.py$|_test\.py$/.test(f)); } catch { return false; }
}

/** Heuristic pass/fail counts for common runners (vitest, jest, pytest, go, cargo, node:test, mocha). */
export function parseCounts(output: string): { passed?: number; failed?: number } {
  const text = output.replace(/\x1b\[[0-9;]*m/g, '');
  let passed: number | undefined;
  let failed: number | undefined;
  const last = (re: RegExp): number | undefined => {
    let m: RegExpExecArray | null;
    let v: number | undefined;
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    while ((m = g.exec(text))) v = Number(m[1]);
    return v;
  };
  // vitest: "Tests  1 failed | 2 passed (3)"
  const vit = /^\s*Tests\s+(.+\(\d+\))\s*$/m.exec(text);
  if (vit) {
    passed = Number(/(\d+) passed/.exec(vit[1])?.[1] ?? 0);
    failed = Number(/(\d+) failed/.exec(vit[1])?.[1] ?? 0);
    return { passed, failed };
  }
  // jest: "Tests:       1 failed, 2 passed, 3 total"
  const jest = /^Tests:\s+(.+total)\s*$/m.exec(text);
  if (jest) {
    return { passed: Number(/(\d+) passed/.exec(jest[1])?.[1] ?? 0), failed: Number(/(\d+) failed/.exec(jest[1])?.[1] ?? 0) };
  }
  // node:test (tap or spec reporter): "# pass 2" / "ℹ pass 2"
  const np = last(/^(?:#|ℹ)\s*pass (\d+)/m);
  if (np !== undefined) return { passed: np, failed: last(/^(?:#|ℹ)\s*fail (\d+)/m) ?? 0 };
  // cargo: "test result: ok. 3 passed; 0 failed"
  if (/test result:/.test(text)) {
    let p = 0; let f = 0;
    for (const m of text.matchAll(/test result: \w+\. (\d+) passed; (\d+) failed/g)) { p += Number(m[1]); f += Number(m[2]); }
    return { passed: p, failed: f };
  }
  // go: count --- PASS / --- FAIL lines
  const goPass = (text.match(/^\s*--- PASS/gm) ?? []).length;
  const goFail = (text.match(/^\s*--- FAIL/gm) ?? []).length;
  if (goPass || goFail) return { passed: goPass, failed: goFail };
  // pytest / mocha / generic
  passed = last(/(\d+) (?:passed|passing)/);
  failed = last(/(\d+) (?:failed|failing)/);
  if (passed !== undefined || failed !== undefined) return { passed: passed ?? 0, failed: failed ?? 0 };
  return {};
}

// Files and directories with credentials that sandboxed tests must not read (masked with an empty tmpfs or /dev/null).
const SECRET_DIRS = ['.ssh', '.gnupg', '.codex', '.claude', '.lina', '.aws', '.azure', '.kube', '.docker', '.config/gh', '.config/gcloud', '.password-store'];
const SECRET_FILES = ['.claude.json', '.netrc', '.npmrc', '.pypirc', '.git-credentials'];

/**
 * Argv that runs `command` under bubblewrap: the whole filesystem read-only, the workspace writable (its .git
 * read-only), a private /tmp, credentials masked, its own pid namespace and, unless the project allows network,
 * its own network namespace (loopback only).
 * Not `codex sandbox`: its seccomp filter blocks the socketpairs Node uses for child stdio, which makes
 * `node --test` report files as passing without running them.
 */
export function sandboxedTestArgv(command: string, ws: string, network: boolean): { cmd: string; args: string[] } {
  const home = homedir();
  const args = ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp'];
  for (const d of SECRET_DIRS) if (isDir(join(home, d))) args.push('--tmpfs', join(home, d));
  for (const f of SECRET_FILES) if (existsSync(join(home, f))) args.push('--ro-bind', '/dev/null', join(home, f));
  args.push('--bind', ws, ws);
  if (existsSync(join(ws, '.git'))) args.push('--ro-bind', join(ws, '.git'), join(ws, '.git'));
  if (!network) args.push('--unshare-net');
  args.push('--unshare-pid', '--unshare-ipc', '--unshare-uts', '--die-with-parent', '--new-session', '--chdir', ws, '--', 'bash', '-lc', command);
  return { cmd: process.env.LINA_BWRAP_BIN || 'bwrap', args };
}

/** bwrap could not set up the sandbox at all (as opposed to the tests failing inside it). */
export function isSandboxSetupFailure(exitCode: number | null, output: string): boolean {
  return exitCode !== 0 && /^bwrap: /m.test(output);
}

/** Whether bubblewrap can create the test sandbox on this machine (runs `true` inside it). */
export async function probeTestSandbox(): Promise<{ ok: boolean; error?: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'lina-sbx-test-'));
  try {
    const argv = sandboxedTestArgv('true', dir, false);
    let last = '';
    for (let i = 0; i < 2; i++) { // autofs mounts can fail on first touch
      const r = await attempt(argv.cmd, argv.args, dir, process.env, 30_000);
      if (r.exitCode === 0) return { ok: true };
      last = r.output.trim().split('\n').filter(Boolean).slice(-1)[0] ?? `exit ${r.exitCode}`;
    }
    return { ok: false, error: last };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface RunTestsOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /**
   * Run inside the bubblewrap sandbox. Tool caches are redirected to the sandbox's private /tmp.
   * fallback: when the sandbox itself cannot start (twice), run unsandboxed and say so instead of failing.
   */
  sandbox?: { network: boolean; fallback?: boolean };
}

export async function runTests(ws: string, command: string, opts: RunTestsOptions = {}): Promise<TestRun & { aborted?: boolean }> {
  const env = agentEnv({ CI: '1', FORCE_COLOR: '0', NO_COLOR: '1', npm_config_update_notifier: 'false' });
  delete env.NODE_OPTIONS;
  const timeoutMs = opts.timeoutMs ?? TEST_TIMEOUT_MS;
  const start = Date.now();
  let notes = '';
  let sandboxed = !!opts.sandbox;
  let r: Attempt;
  if (opts.sandbox) {
    const cache = '/tmp/lina-test-cache';
    const sbxEnv = {
      ...env, XDG_CACHE_HOME: cache, npm_config_cache: join(cache, 'npm'), GOCACHE: join(cache, 'go-build'),
      PIP_CACHE_DIR: join(cache, 'pip'), PYTHONDONTWRITEBYTECODE: '1',
    };
    const argv = sandboxedTestArgv(command, ws, opts.sandbox.network);
    r = await attempt(argv.cmd, argv.args, ws, sbxEnv, timeoutMs, opts.signal);
    // Automounts (e.g. an idle autofs NAS) can make bwrap's mounts fail on first touch: retry once.
    if (!r.aborted && isSandboxSetupFailure(r.exitCode, r.output)) r = await attempt(argv.cmd, argv.args, ws, sbxEnv, timeoutMs, opts.signal);
    if (!r.aborted && isSandboxSetupFailure(r.exitCode, r.output)) {
      const why = r.output.trim().split('\n').filter(Boolean).slice(-1)[0] ?? 'unknown error';
      if (opts.sandbox.fallback) {
        notes = `[LINA] The test sandbox could not start (${why.slice(0, 200)}); ran the tests WITHOUT the sandbox.\n`;
        sandboxed = false;
        r = await attempt('bash', ['-lc', command], ws, env, timeoutMs, opts.signal);
      } else {
        r.output += `\n[LINA] The test sandbox could not start; tests were not run. Set the test sandbox to "auto" or "off" to run them unsandboxed.`;
      }
    }
  } else {
    r = await attempt('bash', ['-lc', command], ws, env, timeoutMs, opts.signal);
  }
  const output = notes + r.output;
  const counts = parseCounts(output);
  const run: TestRun & { aborted?: boolean } = {
    command,
    exitCode: r.exitCode,
    ok: r.exitCode === 0 && !r.timedOut,
    durationMs: Date.now() - start,
    output: tail(redact(output), OUTPUT_TAIL),
    sandboxed,
  };
  if (counts.passed !== undefined) run.passed = counts.passed;
  if (counts.failed !== undefined) run.failed = counts.failed;
  if (r.aborted) run.aborted = true;
  return run;
}

interface Attempt { exitCode: number | null; timedOut: boolean; aborted: boolean; output: string }

async function attempt(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number, signal?: AbortSignal): Promise<Attempt> {
  const MAX = 256 * 1024;
  let output = '';
  const add = (s: string) => { output += s; if (output.length > MAX * 2) output = output.slice(-MAX); };
  const r = await runProcess({
    cmd, args, cwd, env, signal, turnTimeoutMs: timeoutMs, killGraceMs: 3000,
    onLine: (l) => add(l + '\n'),
    onStderr: (c) => add(c),
  });
  if (r.timedOut) output += `\n[LINA] test command timed out after ${Math.round(timeoutMs / 1000)}s`;
  if (r.spawnError) output += `\n[LINA] failed to start: ${r.spawnError}`;
  return { exitCode: r.exitCode, timedOut: !!r.timedOut, aborted: !!r.aborted, output };
}
