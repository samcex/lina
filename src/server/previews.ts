// Preview processes belong to the session, not to an agent turn or daemon process group.
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, readSync, rmSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { join } from 'node:path';
import type { Preview } from '../shared/types.js';
import type { Db } from './db.js';
import { agentEnv } from './agents/proc.js';
import { paths } from './paths.js';
import { redact } from './agents/redact.js';
import { LinaError, rid } from './util.js';

function identity(pid: number): string | undefined {
  try {
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (fields[0] === 'Z' || fields[0] === 'X') return undefined;
      return `${pid}:${fields[19]}`; // kernel start ticks; protects against PID reuse
    }
    const start = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8' }).trim();
    return start ? `${pid}:${start}` : undefined;
  } catch { return undefined; }
}

function groupAlive(pid: number): boolean { try { process.kill(-pid, 0); return true; } catch { return false; } }
function killRemainingGroup(pid: number, expected: string): void {
  const current = identity(pid);
  if (!current || current === expected) { try { process.kill(-pid, 'SIGKILL'); } catch { /* group already exited */ } }
}

async function reservePort(requested?: number): Promise<number> {
  if (requested !== undefined && (!Number.isInteger(requested) || requested < 1 || requested > 65535)) throw new LinaError('port must be 1–65535', 'invalid');
  return new Promise((res, rej) => {
    const server = createServer();
    server.once('error', () => rej(new LinaError('Preview port is already in use or unavailable', 'port_in_use', 409)));
    server.listen(requested ?? 0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => res(port));
    });
  });
}

function listening(port: number): Promise<boolean> {
  return new Promise((res) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const finish = (ok: boolean) => { socket.destroy(); res(ok); };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(300, () => finish(false));
  });
}

export class PreviewManager {
  private children = new Map<string, ChildProcess>();
  private timer: NodeJS.Timeout;
  private checking = false;
  private closed = false;
  constructor(private db: Db, private changed: (p: Preview) => void = () => {}) {
    this.timer = setInterval(() => { void this.refresh().catch(() => {}); }, 700);
    this.timer.unref();
  }
  private all(): Preview[] {
    return this.db.sql.prepare('SELECT record FROM previews').all().map((r) => JSON.parse(String(r.record)) as Preview);
  }
  private save(p: Preview): void {
    if (this.closed) return;
    this.db.sql.prepare('INSERT OR REPLACE INTO previews(id,session_id,record) VALUES (?,?,?)').run(p.id, p.sessionId, JSON.stringify(p));
    this.changed(p);
  }
  private file(id: string): string {
    if (!/^[a-z0-9]+$/i.test(id)) throw new LinaError('Invalid preview id', 'invalid');
    return join(paths.previews, `${id}.log`);
  }
  private get(sid: string, id: string): Preview {
    const p = this.all().find((p) => p.id === id && p.sessionId === sid);
    if (!p) throw new LinaError('Unknown preview', 'not_found', 404);
    return p;
  }
  async list(sid: string): Promise<Preview[]> {
    await this.refresh();
    return this.all().filter((p) => p.sessionId === sid).sort((a, b) => b.createdAt - a.createdAt);
  }
  async start(sid: string, cwd: string, body: { command: string; port?: number }): Promise<Preview> {
    if (!body || typeof body.command !== 'string' || !body.command.trim() || body.command.length > 10000) throw new LinaError('A preview command is required (max 10000 characters)', 'invalid');
    if ((await this.list(sid)).filter((p) => p.status === 'starting' || p.status === 'running').length >= 4) throw new LinaError('This session already has four previews; stop one first', 'preview_limit', 409);
    const port = await reservePort(body.port);
    const id = rid(12);
    mkdirSync(paths.previews, { recursive: true, mode: 0o700 });
    const fd = openSync(this.file(id), 'a', 0o600);
    let child: ChildProcess;
    try {
      child = spawn('/bin/sh', ['-lc', body.command.replaceAll('{port}', String(port))], {
        cwd, env: agentEnv({ PORT: String(port), HOST: '127.0.0.1', LINA_SESSION_ID: sid }),
        detached: true, stdio: ['ignore', fd, fd],
      });
    } finally { closeSync(fd); }
    await new Promise<void>((res, rej) => { child.once('spawn', res); child.once('error', rej); });
    const p: Preview = { id, sessionId: sid, command: body.command, cwd, port, url: `http://127.0.0.1:${port}`, pid: child.pid,
      identity: child.pid ? identity(child.pid) : undefined, status: 'starting', createdAt: Date.now() };
    if (!p.identity) {
      try { process.kill(-child.pid!, 'SIGTERM'); } catch { /* exited already */ }
      p.status = 'failed'; p.error = 'Preview exited before its process identity could be recorded';
    }
    this.children.set(id, child);
    child.once('exit', (code) => {
      this.children.delete(id);
      if (this.closed) return;
      const current = this.all().find((p) => p.sessionId === sid && p.id === id);
      if (!current) return;
      if (current.status === 'stopped') return;
      current.status = code === 0 ? 'stopped' : 'failed';
      current.stoppedAt = Date.now(); current.exitCode = code;
      if (code !== 0) current.error = `Preview exited (${code ?? 'signal'}); inspect its logs`;
      this.save(current);
      // A preview command must stay in the foreground; stray descendants have no managed leader.
      try { process.kill(-child.pid!, 'SIGTERM'); } catch { /* none left */ }
      if (p.identity) { const timer = setTimeout(() => killRemainingGroup(child.pid!, p.identity!), 1500); timer.unref(); }
    });
    child.unref();
    this.save(p);
    return p;
  }
  private async refresh(): Promise<void> {
    if (this.checking || this.closed) return;
    this.checking = true;
    try {
      for (const p of this.all()) {
        if (!['starting', 'running'].includes(p.status)) continue;
        if (!p.pid || !p.identity || identity(p.pid) !== p.identity) {
          p.status = 'stopped'; p.stoppedAt = Date.now(); p.error = 'Preview process is no longer running'; this.save(p);
        } else if (p.status === 'starting' && await listening(p.port)) {
          if (this.closed) return;
          const latest = this.get(p.sessionId, p.id);
          if (latest.status === 'starting') { latest.status = 'running'; this.save(latest); }
        }
      }
    } finally { this.checking = false; }
  }
  async stop(sid: string, id: string): Promise<Preview> {
    const p = this.get(sid, id);
    p.status = 'stopped'; p.stoppedAt = Date.now(); this.save(p);
    if (p.pid && p.identity && identity(p.pid) === p.identity) {
      try { process.kill(-p.pid, 'SIGTERM'); } catch { /* already gone */ }
      const deadline = Date.now() + 1500;
      while (Date.now() < deadline && groupAlive(p.pid)) await new Promise((r) => setTimeout(r, 30));
      killRemainingGroup(p.pid, p.identity);
    }
    return p;
  }
  logs(sid: string, id: string): { output: string } {
    this.get(sid, id);
    const path = this.file(id);
    if (!existsSync(path)) return { output: '' };
    const fd = openSync(path, 'r');
    try {
      const size = statSync(path).size, bytes = Buffer.alloc(Math.min(size, 64000));
      readSync(fd, bytes, 0, bytes.length, Math.max(0, size - bytes.length));
      return { output: redact(bytes.toString()) };
    } finally { closeSync(fd); }
  }
  async remove(sid: string): Promise<void> {
    for (const p of await this.list(sid)) { await this.stop(sid, p.id); rmSync(this.file(p.id), { force: true }); }
    this.db.sql.prepare('DELETE FROM previews WHERE session_id = ?').run(sid);
  }
  /** Processes deliberately survive daemon restart; descriptors point to independent log files. */
  close(): void { this.closed = true; clearInterval(this.timer); this.children.clear(); }
}
