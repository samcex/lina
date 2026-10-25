import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { waitUntil } from './helpers.js';

const root = resolve(import.meta.dirname, '../..');
const script = "import('./src/server/index.ts').then((m) => m.runDaemon({ port: 0 }))";

function launch(home: string) {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', '-e', script], {
    cwd: root, env: { ...process.env, LINA_HOME: home, LINA_MOCK: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let err = '';
  child.stderr.on('data', (d) => { err += String(d); });
  const exited = new Promise<number | null>((r) => child.on('exit', (c) => r(c)));
  return { child, exited, stderr: () => err };
}

describe('runDaemon', () => {
  it('writes daemon.json (0600), refuses a second instance, cleans up on SIGTERM', async () => {
    const home = mkdtempSync(join(tmpdir(), 'lina-daemon-'));
    const info = join(home, 'daemon.json');
    const a = launch(home);
    await waitUntil(() => existsSync(info), 20_000, 'daemon.json');
    expect(statSync(info).mode & 0o777).toBe(0o600);
    const d = JSON.parse(readFileSync(info, 'utf8'));
    expect(d.pid).toBe(a.child.pid);
    expect(d.token).toMatch(/^[0-9a-f]{64}$/);
    const health = await fetch(`http://127.0.0.1:${d.port}/api/health`, { headers: { authorization: `Bearer ${d.token}` } });
    expect((await health.json()).ok).toBe(true);

    const b = launch(home);
    expect(await b.exited).toBe(0);
    expect(b.stderr()).toMatch(/already running/);
    expect(JSON.parse(readFileSync(info, 'utf8')).pid).toBe(a.child.pid);

    a.child.kill('SIGTERM');
    expect(await a.exited).toBe(0);
    expect(existsSync(info)).toBe(false);
    expect(readFileSync(join(home, 'daemon.log'), 'utf8')).toMatch(/shutting down/);
  }, 60_000);
});
