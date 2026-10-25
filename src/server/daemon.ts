// Daemon lifecycle: startServer (embeddable, used by tests) and runDaemon (`lina daemon run`).
import { randomBytes } from 'node:crypto';
import { chmodSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer as createNetServer, type AddressInfo, type Server as NetServer, type Socket } from 'node:net';
import type { DaemonInfo } from '../shared/protocol.js';
import { LINA_VERSION } from '../shared/types.js';
import { Db } from './db.js';
import { EventStore } from './events.js';
import { createHttpServer } from './http.js';
import { log, logToStderr } from './log.js';
import { DEFAULT_PORT, ensureHome, paths } from './paths.js';
import { Notifier } from './notify.js';
import { SessionManager } from './sessions.js';
import { HomeAccess } from './home.js';

export interface ServerHandle {
  port: number;
  token: string;
  manager: SessionManager;
  close(): Promise<void>;
}

export async function startServer(opts: { port?: number; host?: '127.0.0.1'; token?: string } = {}): Promise<ServerHandle> {
  ensureHome();
  const host = opts.host ?? '127.0.0.1';
  const token = opts.token ?? randomBytes(32).toString('hex');
  const db = new Db(paths.db);
  const events = new EventStore(db);
  const manager = new SessionManager(db, events);
  const notifier = new Notifier((id) => { try { return manager.getProject(id).name; } catch { return undefined; } });
  events.watchAll((e) => {
    if (e.type === 'session.updated') notifier.onSession(e.data.session);
    else if (e.type === 'session.deleted') notifier.forget(e.sessionId);
  });
  let port = 0;
  let home: HomeAccess;
  const { server, wss, acceptTailnet, acceptHome, closeClients } = createHttpServer({ manager, events, token, port: () => port, startedAt: Date.now(), home: () => home });
  try { home = new HomeAccess(acceptHome, () => port); }
  catch (e) { db.close(); throw e; }

  const listen = (p: number) => new Promise<void>((resolve, reject) => {
    const onError = (e: Error) => { server.off('listening', onListening); reject(e); };
    const onListening = () => { server.off('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(p, host);
  });
  try {
    try {
      await listen(opts.port ?? DEFAULT_PORT);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EADDRINUSE' && opts.port === undefined) {
        log.warn(`port ${DEFAULT_PORT} is busy; using a random free port`);
        await listen(0);
      } else throw e;
    }
  } catch (e) {
    db.close();
    throw e;
  }
  port = (server.address() as AddressInfo).port;
  log.info(`LINA ${LINA_VERSION} listening on http://${host}:${port}`);
  const tailnet = await listenTailnet(acceptTailnet);
  await home.start();
  if (home.status().error) log.warn(`home access unavailable: ${home.status().error}`);

  let closed: Promise<void> | undefined;
  const close = () => {
    closed ??= (async () => {
      manager.stopAutomatic();
      const stopped = new Promise<void>((r) => server.close(() => r()));
      closeClients();
      await home.close();
      wss.close();
      server.closeAllConnections?.();
      if (tailnet) {
        tailnet.server.close();
        // a newer daemon in the same home may have replaced the socket: only remove our own
        try { if (statSync(paths.tailnetSocket).ino === tailnet.ino) unlinkSync(paths.tailnetSocket); } catch { /* already gone */ }
      }
      await manager.shutdown();
      await stopped;
      db.close();
      log.info('server closed');
    })();
    return closed;
  };
  manager.startAutomatic();
  return { port, token, manager, close };
}

/** The socket `lina tailscale on` points tailscale serve at (owner-only; tailscaled connects as root). */
async function listenTailnet(accept: (s: Socket) => void): Promise<{ server: NetServer; ino: number } | undefined> {
  const path = paths.tailnetSocket;
  try { unlinkSync(path); } catch { /* none left over */ }
  const srv = createNetServer(accept);
  try {
    await new Promise<void>((resolve, reject) => { srv.once('error', reject); srv.listen(path, () => { srv.off('error', reject); resolve(); }); });
    chmodSync(path, 0o600);
    return { server: srv, ino: statSync(path).ino };
  } catch (e) {
    log.warn(`tailnet socket unavailable (${(e as Error).message}); \`lina tailscale\` sign-in by email is off`);
    srv.close();
    return undefined;
  }
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

function readDaemonInfo(): DaemonInfo | undefined {
  try { return JSON.parse(readFileSync(paths.daemonInfo, 'utf8')) as DaemonInfo; } catch { return undefined; }
}

async function healthy(info: DaemonInfo): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${info.port}/api/health`, {
      headers: { authorization: `Bearer ${info.token}` }, signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch { return false; }
}

function writeDaemonInfo(info: DaemonInfo): void {
  const tmp = `${paths.daemonInfo}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(info, null, 2), { mode: 0o600 });
  renameSync(tmp, paths.daemonInfo);
}

/** Runs the daemon in the foreground until SIGTERM/SIGINT. Used by `lina daemon run`. */
export async function runDaemon(opts: { port?: number } = {}): Promise<void> {
  ensureHome();
  const existing = readDaemonInfo();
  if (existing && existing.pid !== process.pid && pidAlive(existing.pid) && await healthy(existing)) {
    process.stderr.write(`LINA daemon already running (pid ${existing.pid}, http://127.0.0.1:${existing.port}).\n`);
    process.exitCode = 0;
    return;
  }
  if (process.env.LINA_LOG_STDERR === '1') logToStderr(true);
  const handle = await startServer({ port: opts.port });
  const info: DaemonInfo = { pid: process.pid, port: handle.port, token: handle.token, version: LINA_VERSION, startedAt: Date.now() };
  writeDaemonInfo(info);
  log.info(`daemon started pid=${process.pid} port=${handle.port}`);

  let stopping = false;
  const stop = async (sig: string) => {
    if (stopping) return;
    stopping = true;
    log.info(`received ${sig}; shutting down`);
    const force = setTimeout(() => process.exit(1), 15_000);
    force.unref();
    try { await handle.close(); } catch (e) { log.error('shutdown failed', e); }
    const cur = readDaemonInfo();
    if (cur?.pid === process.pid) rmSync(paths.daemonInfo, { force: true });
    process.exit(0);
  };
  process.on('SIGTERM', () => void stop('SIGTERM'));
  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('uncaughtException', (e) => log.error('uncaught exception', e));
  process.on('unhandledRejection', (e) => log.error('unhandled rejection', e));
  await new Promise<void>(() => { /* run until signalled */ });
}
