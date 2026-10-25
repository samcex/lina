import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { cleanupInfo, discoverDaemon, ensureDaemon, isPidAlive, readDaemonInfo, type DiscoveryDeps } from '../../src/cli/daemon-control.js';
import type { DaemonInfo } from '../../src/shared/protocol.js';

const info: DaemonInfo = { pid: 4242, port: 7077, token: 't', version: '0.1.0', startedAt: 1 };

function deps(over: Partial<DiscoveryDeps>): DiscoveryDeps {
  return { readInfo: () => info, isAlive: () => true, health: async () => ({ ok: true, version: '0.1.0' }), ...over };
}

describe('daemon discovery', () => {
  it('absent when there is no daemon.json', async () => {
    expect(await discoverDaemon(deps({ readInfo: () => null }))).toEqual({ state: 'absent' });
  });
  it('stale when the pid is dead', async () => {
    expect(await discoverDaemon(deps({ isAlive: () => false }))).toMatchObject({ state: 'stale', reason: 'dead_pid' });
  });
  it('stale when alive but unhealthy', async () => {
    expect(await discoverDaemon(deps({ health: async () => ({ ok: false }) }))).toMatchObject({ state: 'stale', reason: 'unhealthy' });
  });
  it('running when alive and healthy', async () => {
    expect(await discoverDaemon(deps({}))).toMatchObject({ state: 'running', info, version: '0.1.0' });
  });
  it('isPidAlive: self is alive, nonsense pids are not', () => {
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(-1)).toBe(false);
    expect(isPidAlive(2 ** 22 + 12345)).toBe(false);
  });
});

describe('ensureDaemon with an isolated LINA_HOME', () => {
  let home: string;
  const prevHome = process.env.LINA_HOME;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'lina-cli-')); process.env.LINA_HOME = home; });
  afterEach(() => { process.env.LINA_HOME = prevHome; if (prevHome === undefined) delete process.env.LINA_HOME; rmSync(home, { recursive: true, force: true }); });

  it('reads daemon.json and ignores malformed files', () => {
    writeFileSync(join(home, 'daemon.json'), '{nope');
    expect(readDaemonInfo()).toBeNull();
    writeFileSync(join(home, 'daemon.json'), JSON.stringify(info));
    expect(readDaemonInfo()).toEqual(info);
  });

  it('removes a stale pid file and starts a new daemon', async () => {
    const dead = { ...info, pid: 2 ** 22 + 999 };
    writeFileSync(join(home, 'daemon.json'), JSON.stringify(dead));
    let started = 0;
    const fresh = { ...info, pid: process.pid, startedAt: 2 };
    const got = await ensureDaemon({
      deps: { readInfo: () => readDaemonInfo(), isAlive: isPidAlive, health: async () => ({ ok: false }) },
      start: async () => { started++; expect(existsSync(join(home, 'daemon.json'))).toBe(false); return fresh; },
    });
    expect(started).toBe(1);
    expect(got).toEqual(fresh);
  });

  it('returns the running daemon without starting another', async () => {
    let started = 0;
    const got = await ensureDaemon({ deps: deps({}), start: async () => { started++; return info; } });
    expect(got).toEqual(info);
    expect(started).toBe(0);
  });

  it('cleanupInfo only removes the file for the matching pid', () => {
    writeFileSync(join(home, 'daemon.json'), JSON.stringify(info));
    cleanupInfo(1);
    expect(existsSync(join(home, 'daemon.json'))).toBe(true);
    cleanupInfo(info.pid);
    expect(existsSync(join(home, 'daemon.json'))).toBe(false);
  });

  it('starts the source CLI daemon from a data directory outside node_modules', async () => {
    const socket = createServer();
    await new Promise<void>((resolve) => socket.listen(0, '127.0.0.1', resolve));
    const port = (socket.address() as { port: number }).port;
    await new Promise<void>((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()));
    const entry = fileURLToPath(new URL('../../src/cli/main.tsx', import.meta.url));
    const run = (action: string) => spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), entry, 'daemon', action], {
      cwd: home, encoding: 'utf8', timeout: 12000,
      env: { ...process.env, LINA_HOME: home, LINA_PORT: String(port), LINA_MOCK: '1' },
    });
    try {
      const started = run('start');
      expect(started.stderr).toBe('');
      expect(started.status).toBe(0);
      expect(started.stdout).toContain('Daemon started');
      expect(readDaemonInfo()?.port).toBe(port);
      expect(run('status').stdout).toContain('running');
    } finally {
      const stopped = run('stop');
      expect(stopped.status).toBe(0);
    }
  }, 20000);
});

describe('isLinaDaemonPid', () => {
  it('refuses live pids that are not a LINA daemon (pid reuse after reboot)', async () => {
    const { isLinaDaemonPid } = await import('../../src/cli/daemon-control.js');
    expect(isLinaDaemonPid(process.pid)).toBe(false); // vitest worker: alive, but not `lina daemon run`
    expect(isLinaDaemonPid(1)).toBe(false);
  });
});
