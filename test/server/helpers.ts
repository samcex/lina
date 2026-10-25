import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import type { ServerMessage } from '../../src/shared/protocol.js';
import type { AnyLinaEvent } from '../../src/shared/types.js';

export function setupEnv(): string {
  const home = mkdtempSync(join(tmpdir(), 'lina-home-'));
  process.env.LINA_HOME = home;
  process.env.LINA_MOCK_DELAY_MS = '0';
  for (const [k, v] of Object.entries({ GIT_AUTHOR_NAME: 'Tester', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'Tester', GIT_COMMITTER_EMAIL: 't@example.com' })) process.env[k] = v;
  return home;
}

export function sh(cwd: string, cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Temp git repo with a node:test-based package.json and one commit. */
export function makeRepo(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'lina-proj-'));
  sh(dir, 'git', ['init', '-q', '-b', 'main']);
  sh(dir, 'git', ['config', 'user.name', 'Tester']);
  sh(dir, 'git', ['config', 'user.email', 't@example.com']);
  const all = { 'package.json': JSON.stringify({ name: 'demo', version: '1.0.0', scripts: { test: 'node --test' } }, null, 2) + '\n', 'README.md': '# demo\n', ...files };
  for (const [p, c] of Object.entries(all)) { mkdirSync(join(dir, p, '..'), { recursive: true }); writeFileSync(join(dir, p), c); }
  sh(dir, 'git', ['add', '-A']);
  sh(dir, 'git', ['commit', '-q', '-m', 'init']);
  return dir;
}

export class WsClient {
  ws: WebSocket;
  msgs: ServerMessage[] = [];
  private waiters: { pred: () => boolean; resolve: () => void }[] = [];
  constructor(port: number, token: string) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
    this.ws.on('message', (d) => {
      this.msgs.push(JSON.parse(String(d)));
      this.waiters = this.waiters.filter((w) => { if (w.pred()) { w.resolve(); return false; } return true; });
    });
  }
  open(): Promise<void> { return new Promise((r, j) => { this.ws.once('open', () => r()); this.ws.once('error', j); }); }
  send(m: unknown) { this.ws.send(JSON.stringify(m)); }
  events(sessionId?: string): AnyLinaEvent[] {
    return this.msgs.flatMap((m) => m.kind === 'event' ? [m.event] : m.kind === 'snapshot' ? m.snapshot.events : [])
      .filter((e) => !sessionId || e.sessionId === sessionId);
  }
  persisted(sessionId: string): AnyLinaEvent[] {
    const seen = new Map<number, AnyLinaEvent>();
    for (const e of this.events(sessionId)) if (e.seq > 0) seen.set(e.seq, e);
    return [...seen.values()].sort((a, b) => a.seq - b.seq);
  }
  waitFor(pred: () => boolean, timeoutMs = 25_000, label = 'condition'): Promise<void> {
    if (pred()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout waiting for ${label}`)), timeoutMs);
      this.waiters.push({ pred, resolve: () => { clearTimeout(t); resolve(); } });
    });
  }
  /** Waits for a session.updated with the given status. */
  waitStatus(sessionId: string, status: string | string[], timeoutMs?: number): Promise<void> {
    const want = Array.isArray(status) ? status : [status];
    return this.waitFor(() => {
      const last = [...this.events(sessionId)].reverse().find((e) => e.type === 'session.updated');
      return !!last && last.type === 'session.updated' && want.includes(last.data.session.status);
    }, timeoutMs, `status ${want.join('|')}`);
  }
  close() { this.ws.close(); }
}

export async function waitUntil(fn: () => boolean | Promise<boolean>, timeoutMs = 20_000, label = 'condition'): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { if (await fn()) return; await new Promise((r) => setTimeout(r, 25)); }
  throw new Error(`timeout waiting for ${label}`);
}
