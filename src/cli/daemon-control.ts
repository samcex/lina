// Finding, starting and stopping the LINA daemon from the CLI.
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, readSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { paths } from '../server/paths.js';
import type { DaemonInfo } from '../shared/protocol.js';
import { LinaClient } from '../shared/client.js';

export type Discovery =
  | { state: 'running'; info: DaemonInfo; version?: string }
  | { state: 'absent' }
  | { state: 'stale'; info: DaemonInfo; reason: 'dead_pid' | 'unhealthy' };

export interface DiscoveryDeps {
  readInfo(): DaemonInfo | null;
  isAlive(pid: number): boolean;
  health(info: DaemonInfo): Promise<{ ok: boolean; version?: string }>;
}

export function baseUrl(info: Pick<DaemonInfo, 'port'>): string { return `http://127.0.0.1:${info.port}`; }

export function readDaemonInfo(file = paths.daemonInfo): DaemonInfo | null {
  try {
    const j = JSON.parse(readFileSync(file, 'utf8')) as Partial<DaemonInfo>;
    if (typeof j.pid !== 'number' || typeof j.port !== 'number' || typeof j.token !== 'string') return null;
    return j as DaemonInfo;
  } catch {
    return null;
  }
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * True only if `pid` is alive AND is a LINA daemon. A stale daemon.json (e.g. after a
 * reboot) may name a pid that now belongs to an unrelated process — never signal those.
 */
export function isLinaDaemonPid(pid: number): boolean {
  if (!isPidAlive(pid)) return false;
  try {
    const argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
    if (argv[0]?.trim() === 'linad') return true; // the daemon sets process.title = 'linad'
    return argv.includes('daemon') && argv.includes('run') && argv.some((a) => /lina/i.test(a));
  } catch {
    return process.platform !== 'linux'; // no procfs: fall back to liveness only
  }
}

export async function checkHealth(info: DaemonInfo, timeoutMs = 1500): Promise<{ ok: boolean; version?: string }> {
  try {
    const res = await fetch(`${baseUrl(info)}/api/health`, {
      headers: { authorization: `Bearer ${info.token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { ok: false };
    const j = (await res.json()) as { ok?: boolean; version?: string };
    return { ok: j.ok === true, version: j.version };
  } catch {
    return { ok: false };
  }
}

export const defaultDeps: DiscoveryDeps = { readInfo: () => readDaemonInfo(), isAlive: isLinaDaemonPid, health: (i) => checkHealth(i) };

/** Pure-ish discovery: reads daemon.json, verifies the pid is alive and /api/health answers. */
export async function discoverDaemon(deps: DiscoveryDeps = defaultDeps): Promise<Discovery> {
  const info = deps.readInfo();
  if (!info) return { state: 'absent' };
  if (!deps.isAlive(info.pid)) return { state: 'stale', info, reason: 'dead_pid' };
  const h = await deps.health(info);
  if (!h.ok) return { state: 'stale', info, reason: 'unhealthy' };
  return { state: 'running', info, version: h.version };
}

/** Path of the bundled CLI entry (dist/lina.js) used to spawn `lina daemon run`. */
export function selfEntry(): { script: string; execArgv: string[] } {
  const script = fileURLToPath(import.meta.url);
  const execArgv = ['--disable-warning=ExperimentalWarning'];
  if (/\.tsx?$/.test(script)) {
    // running from sources (tsx): spawn the CLI entry through tsx
    // The child runs from LINA_HOME, which does not contain this project's node_modules.
    return { script: script.replace(/[^/\\]+$/, 'main.tsx'), execArgv: [...execArgv, '--import', import.meta.resolve('tsx')] };
  }
  return { script, execArgv };
}

export class DaemonError extends Error {
  constructor(message: string, public hint?: string) { super(message); }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function tailFile(file: string, lines = 50): string[] {
  if (!existsSync(file)) return [];
  const size = statSync(file).size;
  const len = Math.min(size, 256 * 1024);
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const all = buf.toString('utf8').split('\n');
    if (all[all.length - 1] === '') all.pop();
    return all.slice(-lines);
  } finally {
    closeSync(fd);
  }
}

/** Spawns a detached daemon and waits until it is healthy (≤ timeoutMs). */
export async function startDaemon(opts: { timeoutMs?: number; deps?: DiscoveryDeps } = {}): Promise<DaemonInfo> {
  const deps = opts.deps ?? defaultDeps;
  const timeoutMs = opts.timeoutMs ?? 8000;
  mkdirSync(paths.home, { recursive: true, mode: 0o700 });
  const before = deps.readInfo();
  const { script, execArgv } = selfEntry();
  const logFd = openSync(paths.daemonLog, 'a', 0o600);
  let exited: number | null | undefined;
  const child = spawn(process.execPath, [...execArgv, script, 'daemon', 'run'], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env, LINA_DAEMON: '1' },
    cwd: paths.home,
  });
  closeSync(logFd);
  child.on('exit', (code) => { exited = code; });
  child.on('error', () => { exited = -1; });
  child.unref();

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(120);
    const info = deps.readInfo();
    if (info && (info.pid === child.pid || info.startedAt !== before?.startedAt) && deps.isAlive(info.pid)) {
      const h = await deps.health(info);
      if (h.ok) return info;
    }
    if (exited !== undefined) {
      const tail = tailFile(paths.daemonLog, 12).join('\n');
      throw new DaemonError(`The LINA daemon exited during startup (code ${exited}).`, tail ? `Last log lines:\n${tail}` : `See ${paths.daemonLog}`);
    }
  }
  throw new DaemonError(`The LINA daemon did not become healthy within ${Math.round(timeoutMs / 1000)}s.`, `Check \`lina daemon logs\` (${paths.daemonLog}).`);
}

export async function waitForExit(pid: number, timeoutMs: number, isAlive = isPidAlive): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await sleep(100);
  }
  return !isAlive(pid);
}

/** SIGTERMs the daemon and waits for it to exit. Returns what happened. */
export async function stopDaemon(timeoutMs = 6000): Promise<'stopped' | 'not_running' | 'killed'> {
  const info = readDaemonInfo();
  if (!info || !isLinaDaemonPid(info.pid)) {
    if (info) cleanupInfo(info.pid);
    return 'not_running';
  }
  try { process.kill(info.pid, 'SIGTERM'); } catch { /* raced */ }
  if (await waitForExit(info.pid, timeoutMs)) { cleanupInfo(info.pid); return 'stopped'; }
  try { process.kill(info.pid, 'SIGKILL'); } catch { /* gone */ }
  await waitForExit(info.pid, 2000);
  cleanupInfo(info.pid);
  return 'killed';
}

/** Removes daemon.json only if it still refers to `pid`. */
export function cleanupInfo(pid: number): void {
  const cur = readDaemonInfo();
  if (cur && cur.pid === pid) { try { rmSync(paths.daemonInfo, { force: true }); } catch { /* ignore */ } }
}

/** Returns a healthy daemon, starting (or restarting a stale) one if needed. */
export async function ensureDaemon(opts: { deps?: DiscoveryDeps; onStatus?: (msg: string) => void; start?: typeof startDaemon } = {}): Promise<DaemonInfo> {
  const deps = opts.deps ?? defaultDeps;
  const start = opts.start ?? startDaemon;
  let d = await discoverDaemon(deps);
  if (d.state === 'running') return d.info;
  if (d.state === 'stale' && d.reason === 'unhealthy') {
    // It may still be booting: give it a moment before declaring it stuck.
    for (let i = 0; i < 15 && d.state === 'stale'; i++) {
      await sleep(200);
      d = await discoverDaemon(deps);
    }
    if (d.state === 'running') return d.info;
    if (d.state === 'stale' && deps.isAlive(d.info.pid)) {
      opts.onStatus?.('Restarting an unresponsive LINA daemon…');
      try { process.kill(d.info.pid, 'SIGTERM'); } catch { /* ignore */ }
      if (!(await waitForExit(d.info.pid, 4000, deps.isAlive))) { try { process.kill(d.info.pid, 'SIGKILL'); } catch { /* ignore */ } }
    }
  }
  if (d.state === 'stale') cleanupInfo(d.info.pid);
  opts.onStatus?.('Starting the LINA daemon…');
  return start({ deps });
}

export function clientFor(info: DaemonInfo): LinaClient {
  const refresh = async () => {
    try {
      const cur = JSON.parse(readFileSync(paths.daemonInfo, 'utf8')) as DaemonInfo;
      return { baseUrl: baseUrl(cur), token: cur.token };
    } catch { return undefined; }
  };
  return new LinaClient({ baseUrl: baseUrl(info), token: info.token, refresh });
}
