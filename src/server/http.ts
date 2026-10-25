// HTTP + WebSocket front door of the daemon. 127.0.0.1 only, bearer token, Host/Origin checks.
// Connections handed over from the tailnet socket (tailscale serve) may sign in by Tailscale login instead.
import { createHash, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import type { ClientMessage, ServerMessage } from '../shared/protocol.js';
import { AGENT_IDS, LINA_VERSION, type AgentId } from '../shared/types.js';
import type { EventStore } from './events.js';
import { log } from './log.js';
import type { SessionManager } from './sessions.js';
import { isAgentId } from './settings.js';
import { LinaError, errMessage } from './util.js';
import type { HomeAccess } from './home.js';

const JSON_LIMIT = 1024 * 1024;
const WS_BUFFER_LIMIT = 32 * 1024 * 1024;

export interface HttpDeps {
  manager: SessionManager;
  events: EventStore;
  token: string;
  /** Actual listening port (known after listen). */
  port(): number;
  startedAt: number;
  home?: () => HomeAccess;
}

type Handler = (ctx: { req: IncomingMessage; res: ServerResponse; params: string[]; url: URL }) => Promise<unknown> | unknown;
interface Route { method: string; re: RegExp; handler: Handler }

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json', '.wasm': 'application/wasm',
  '.apk': 'application/vnd.android.package-archive',
};

/** Locates the built web UI: dist/web next to the bundle, or <repo>/dist/web when running from src via tsx. */
export function findWebDir(): string | undefined {
  const candidates = [
    process.env.LINA_WEB_DIR,
    fileURLToPath(new URL('./web/', import.meta.url)),
    fileURLToPath(new URL('../../dist/web/', import.meta.url)),
    fileURLToPath(new URL('../web/', import.meta.url)),
  ];
  for (const c of candidates) if (c && existsSync(join(c, 'index.html'))) return resolve(c);
  return undefined;
}

function digest(s: string): Buffer { return createHash('sha256').update(s).digest(); }

export function tokenMatches(expected: string, given: string | undefined | null): boolean {
  if (!given) return false;
  return timingSafeEqual(digest(expected), digest(given));
}

function bearer(req: IncomingMessage): string | undefined {
  const h = req.headers.authorization;
  if (!h) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m?.[1].trim();
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body ?? null);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-length': Buffer.byteLength(data),
  });
  res.end(data);
}

function sendError(res: ServerResponse, status: number, error: string, code?: string, hint?: string): void {
  sendJson(res, status, { error, ...(code ? { code } : {}), ...(hint ? { hint } : {}) });
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > JSON_LIMIT) throw new LinaError('Request body too large (max 1 MB)', 'too_large', 413);
    chunks.push(c as Buffer);
  }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new LinaError('Invalid JSON body', 'invalid', 400); }
}

export function createHttpServer(deps: HttpDeps): { server: Server; wss: WebSocketServer; acceptTailnet(socket: Socket): void; acceptHome(socket: Socket): void; closeClients(): void } {
  const { manager, events } = deps;
  const webDir = findWebDir();

  // Remote origins come through a local HTTPS proxy (tailscale serve) that keeps the browser's Host.
  const remoteOrigins = () => manager.settings().remoteOrigins ?? [];
  const allowedHosts = () => {
    const s = new Set([`127.0.0.1:${deps.port()}`, `localhost:${deps.port()}`]);
    for (const o of remoteOrigins()) {
      const u = new URL(o);
      s.add(u.host);
      if (!u.port) s.add(`${u.hostname}:443`);
    }
    return s;
  };
  // Sockets accepted on the tailnet socket. Only there is the identity header trustworthy: tailscale serve
  // sets Tailscale-User-Login itself (overwriting a client's), while anything can send it to the TCP port.
  const viaTailnet = new WeakSet<object>();
  const viaHome = new WeakSet<object>();
  const homeOrigin = () => deps.home?.().origin();
  const tailnetUser = (req: IncomingMessage): string | undefined => {
    if (!viaTailnet.has(req.socket)) return undefined;
    const login = String(req.headers['tailscale-user-login'] ?? '').trim().toLowerCase();
    return login && (manager.settings().tailnetUsers ?? []).includes(login) ? login : undefined;
  };
  // tailscale serve rewrites Host for a unix-socket target; the Origin check still applies.
  const hostOk = (req: IncomingMessage) => {
    const host = String(req.headers.host ?? '').toLowerCase();
    if (viaHome.has(req.socket)) { const origin = homeOrigin(); return !!origin && host === new URL(origin).host; }
    return viaTailnet.has(req.socket) || allowedHosts().has(host);
  };
  const authenticated = (req: IncomingMessage, given: string | null | undefined = bearer(req)) => viaHome.has(req.socket)
    ? !!deps.home && tokenMatches(deps.home().token, given)
    : !!tailnetUser(req) || tokenMatches(deps.token, given);
  const originOk = (req: IncomingMessage) => !req.headers.origin || (viaHome.has(req.socket)
    ? req.headers.origin === homeOrigin() : allowedOrigins().has(req.headers.origin));
  const allowedOrigins = () => {
    const s = new Set([`http://127.0.0.1:${deps.port()}`, `http://localhost:${deps.port()}`, ...remoteOrigins()]);
    if (process.env.LINA_DEV === '1') { s.add('http://localhost:5173'); s.add('http://127.0.0.1:5173'); }
    return s;
  };

  const routes: Route[] = [];
  const route = (method: string, pattern: string, handler: Handler) => {
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, '([^/]+)') + '$');
    routes.push({ method, re, handler });
  };

  // ── REST ────────────────────────────────────────────────────────────
  route('GET', '/api/health', ({ req }) => {
    const user = tailnetUser(req);
    return { ok: true, version: LINA_VERSION, pid: process.pid, uptimeMs: Date.now() - deps.startedAt, ...(deps.home ? { serverId: deps.home().serverId } : {}), ...(user ? { tailnetUser: user } : {}) };
  });
  const homeManagement = (req: IncomingMessage) => {
    if (!deps.home) throw new LinaError('Home access is unavailable', 'unavailable', 503);
    if (viaHome.has(req.socket)) throw new LinaError('Pair or configure home access through localhost or Tailscale', 'forbidden', 403);
    return deps.home();
  };
  route('GET', '/api/connection', ({ req }) => {
    const tailnetUrl = remoteOrigins().find((o) => { const u = new URL(o); return u.protocol === 'https:' && u.hostname.endsWith('.ts.net'); });
    return homeManagement(req).bundle(tailnetUrl);
  });
  route('GET', '/api/home', ({ req }) => homeManagement(req).status());
  route('PUT', '/api/home', async ({ req }) => homeManagement(req).configure(await readJson(req)));
  route('GET', '/api/settings', () => manager.settings());
  route('PUT', '/api/settings', async ({ req }) => manager.putSettings(await readJson(req) as never));
  route('GET', '/api/doctor', async ({ url }) => {
    const { runDoctor } = await import('./agents/doctor.js');
    return { checks: await runDoctor({ live: url.searchParams.get('live') === '1' }) };
  });
  route('GET', '/api/models', async ({ url }) => {
    const { discoverModels } = await import('./agents/models.js');
    const refresh = url.searchParams.get('refresh') === '1';
    const out = {} as Record<AgentId, unknown>;
    await Promise.all(AGENT_IDS.map(async (a) => { out[a] = await discoverModels(a, { refresh }); }));
    return out;
  });
  route('POST', '/api/models/validate', async ({ req }) => {
    const b = await readJson(req) as { agent?: unknown; model?: unknown };
    if (!isAgentId(b.agent)) throw new LinaError('Unknown agent', 'invalid');
    if (typeof b.model !== 'string' || !b.model.trim()) throw new LinaError('model must be a non-empty string', 'invalid');
    const { validateModel } = await import('./agents/models.js');
    return validateModel(b.agent, b.model.trim());
  });

  route('GET', '/api/projects', () => manager.listProjects());
  route('POST', '/api/projects', async ({ req }) => manager.addProject(await readJson(req) as never));
  route('PATCH', '/api/projects/:id', async ({ req, params }) => manager.updateProject(params[0], await readJson(req) as never));
  route('DELETE', '/api/projects/:id', ({ params }) => { manager.removeProject(params[0]); return { ok: true }; });
  route('GET', '/api/projects/:id/tree', ({ params }) => manager.projectTree(params[0]));

  route('GET', '/api/sessions', ({ url }) => manager.listSessions({
    projectId: url.searchParams.get('projectId') || undefined, q: url.searchParams.get('q') || undefined,
  }));
  route('POST', '/api/sessions', async ({ req }) => manager.createSession(await readJson(req) as never));
  route('GET', '/api/sessions/:id', ({ params, url }) => {
    const since = Number(url.searchParams.get('since') ?? 0);
    if (!Number.isSafeInteger(since) || since < 0) throw new LinaError('since must be a non-negative integer', 'invalid');
    return manager.snapshot(params[0], since);
  });
  route('GET', '/api/sessions/:id/events', ({ params, url, res }) => {
    const before = url.searchParams.has('before') ? Number(url.searchParams.get('before')) : undefined;
    const since = Number(url.searchParams.get('since') ?? 0);
    const limit = Number(url.searchParams.get('limit') ?? (before === undefined ? 2000 : 500));
    if (!Number.isSafeInteger(since) || since < 0 || (before !== undefined && (!Number.isSafeInteger(before) || before < 1)) || !Number.isInteger(limit) || limit < 1 || limit > 2000 || (before !== undefined && url.searchParams.has('since'))) {
      throw new LinaError('Use a non-negative since or positive before cursor, and limit 1–2000', 'invalid');
    }
    res.setHeader('x-lina-last-seq', String(manager.getSession(params[0]).lastSeq));
    return manager.eventsSince(params[0], since, limit, before);
  });
  route('PATCH', '/api/sessions/:id', async ({ req, params }) => manager.updateSession(params[0], await readJson(req) as never));
  route('DELETE', '/api/sessions/:id', async ({ params, url }) => {
    if (url.searchParams.get('confirm') !== '1') throw new LinaError('Deleting a session requires ?confirm=1', 'confirm_required', 400);
    await manager.deleteSession(params[0]);
    return { ok: true };
  });
  route('POST', '/api/sessions/:id/messages', async ({ req, params }) => manager.sendMessage(params[0], await readJson(req) as never));
  route('GET', '/api/sessions/:id/changes', ({ params }) => manager.turnChanges(params[0]));
  route('GET', '/api/sessions/:id/previews', ({ params }) => manager.listPreviews(params[0]));
  route('POST', '/api/sessions/:id/previews', async ({ req, params }) => manager.startPreview(params[0], await readJson(req) as never));
  route('POST', '/api/sessions/:id/previews/:preview/stop', ({ params }) => manager.stopPreview(params[0], params[1]));
  route('GET', '/api/sessions/:id/previews/:preview/logs', ({ params }) => manager.previewLogs(params[0], params[1]));
  route('GET', '/api/sessions/:id/changes/:turn', ({ params }) => manager.turnDiff(params[0], Number(params[1])));
  route('POST', '/api/sessions/:id/undo', async ({ req, params }) => {
    const b = await readJson(req) as { turn?: number };
    if (b.turn !== undefined && (!Number.isInteger(b.turn) || b.turn < 1)) throw new LinaError('turn must be a positive integer', 'invalid');
    return manager.undoTurn(params[0], b.turn);
  });
  route('POST', '/api/sessions/:id/attachments', async ({ req, params }) => {
    const len = Number(req.headers['content-length'] ?? 0);
    if (len > 20 * 1024 * 1024) throw new LinaError('Attachment exceeds 20 MB', 'too_large', 413);
    let name = String(req.headers['x-filename'] ?? 'file');
    try { name = decodeURIComponent(name); } catch { /* keep raw */ }
    return manager.addAttachment(params[0], name, String(req.headers['content-type'] ?? 'application/octet-stream'), req);
  });
  route('POST', '/api/sessions/:id/control', async ({ req, params }) => {
    const b = await readJson(req) as { action?: string };
    return manager.control(params[0], String(b.action ?? ''));
  });
  route('POST', '/api/sessions/:id/approval', async ({ req, params }) => manager.approval(params[0], await readJson(req) as never));
  const variantOf = (url: URL) => url.searchParams.get('variant') || undefined;
  route('GET', '/api/sessions/:id/diff', ({ params, url }) => manager.diff(params[0], url.searchParams.get('from') || undefined, url.searchParams.get('to') || undefined, variantOf(url)));
  route('GET', '/api/sessions/:id/tree', ({ params, url }) => manager.tree(params[0], variantOf(url)));
  route('GET', '/api/sessions/:id/file', ({ params, url }) => {
    const p = url.searchParams.get('path');
    if (!p) throw new LinaError('path is required', 'invalid');
    return manager.file(params[0], p, variantOf(url));
  });
  route('GET', '/api/search', ({ url }) => manager.search(url.searchParams.get('q') ?? ''));

  // ── static web UI ───────────────────────────────────────────────────
  const serveStatic = (req: IncomingMessage, res: ServerResponse, url: URL) => {
    const head = {
      'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer',
    };
    if (!webDir) {
      res.writeHead(200, { ...head, 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end('<!doctype html><meta charset="utf-8"><title>LINA</title><body style="font-family:sans-serif;padding:2rem"><h1>LINA daemon is running</h1><p>The web UI has not been built. Run <code>npm run build</code>.</p></body>');
      return;
    }
    let rel: string;
    try { rel = decodeURIComponent(url.pathname); } catch { return sendError(res, 400, 'Bad path', 'invalid'); }
    if (rel.includes('\0')) return sendError(res, 400, 'Bad path', 'invalid');
    let file = resolve(webDir, '.' + rel);
    if (file !== webDir && !file.startsWith(webDir + sep)) return sendError(res, 403, 'Forbidden', 'forbidden');
    let st = existsSync(file) ? statSync(file) : undefined;
    if (!st || !st.isFile()) {
      // SPA fallback (but a missing asset with an extension is a real 404).
      if (extname(rel) && rel !== '/') return sendError(res, 404, 'Not found', 'not_found');
      file = join(webDir, 'index.html');
      st = statSync(file);
    }
    const ext = extname(file).toLowerCase();
    // PWA icons have stable URLs; their names can resemble a content hash.
    const hashed = !rel.startsWith('/icons/') && (/\/assets\//.test(file.slice(webDir.length)) || /[.-][0-9a-zA-Z_-]{8,}\.(js|css|woff2?|png|svg|jpg|webp)$/.test(file));
    res.writeHead(200, {
      ...head,
      'content-type': MIME[ext] ?? 'application/octet-stream',
      'content-length': st.size,
      // APKs have a stable download URL but change on rebuild. A phone should
      // always receive the current signed package, even immediately after updating.
      'cache-control': ext === '.apk' ? 'no-store' : ext === '.html' || rel === '/sw.js' ? 'no-cache' : hashed ? 'public, max-age=31536000, immutable' : 'public, max-age=300',
    });
    if (req.method === 'HEAD') { res.end(); return; }
    createReadStream(file).pipe(res);
  };

  const server = createServer(async (req, res) => {
    const method = req.method ?? 'GET';
    let url: URL;
    try { url = new URL(req.url ?? '/', 'http://127.0.0.1'); } catch { return sendError(res, 400, 'Bad request', 'invalid'); }
    if (!hostOk(req)) {
      return sendError(res, 403, 'Forbidden host', 'bad_host');
    }
    if (!url.pathname.startsWith('/api/') && url.pathname !== '/api') {
      if (method !== 'GET' && method !== 'HEAD') return sendError(res, 405, 'Method not allowed', 'method');
      return serveStatic(req, res, url);
    }
    if (!authenticated(req)) return sendError(res, 401, 'Unauthorized', 'unauthorized');
    if (!originOk(req)) return sendError(res, 403, 'Forbidden origin', 'bad_origin');
    const expectedServer = req.headers['x-lina-server-id'];
    if (expectedServer !== undefined && (!deps.home || expectedServer !== deps.home().serverId))
      return sendError(res, 409, 'This connection belongs to a different LINA server', 'server_identity');
    let matchedPath = false;
    for (const r of routes) {
      const m = r.re.exec(url.pathname);
      if (!m) continue;
      matchedPath = true;
      if (r.method !== method) continue;
      try {
        const params = m.slice(1).map((p) => decodeURIComponent(p));
        const out = await r.handler({ req, res, params, url });
        if (!res.headersSent) sendJson(res, 200, out);
      } catch (e) {
        if (res.headersSent) { res.end(); return; }
        if (e instanceof LinaError) return sendError(res, e.status, e.message, e.code, e.hint);
        log.error(`${method} ${url.pathname} failed`, e);
        return sendError(res, 500, errMessage(e), 'internal');
      }
      return;
    }
    if (matchedPath) return sendError(res, 405, 'Method not allowed', 'method');
    return sendError(res, 404, 'Not found', 'not_found');
  });

  // ── WebSocket ───────────────────────────────────────────────────────
  const wss = new WebSocketServer({ noServer: true, maxPayload: JSON_LIMIT });

  server.on('upgrade', (req, socket, head) => {
    const reject = (code: number, msg: string) => {
      socket.write(`HTTP/1.1 ${code} ${msg}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    };
    let url: URL;
    try { url = new URL(req.url ?? '/', 'http://127.0.0.1'); } catch { return reject(400, 'Bad Request'); }
    if (url.pathname !== '/ws') return reject(404, 'Not Found');
    if (!hostOk(req)) return reject(403, 'Forbidden');
    if (!originOk(req)) return reject(403, 'Forbidden');
    if (!authenticated(req, url.searchParams.get('token') ?? bearer(req))) return reject(401, 'Unauthorized');
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws));
  });

  const onConnection = (ws: WebSocket) => {
    const subs = new Map<string, () => void>();
    const cleanups: (() => void)[] = [];
    const send = (m: ServerMessage) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (ws.bufferedAmount > WS_BUFFER_LIMIT) { ws.terminate(); return; }
      ws.send(JSON.stringify(m));
    };
    send({ kind: 'hello', version: LINA_VERSION, serverTime: Date.now() });
    ws.on('message', (raw) => {
      let m: ClientMessage;
      try { m = JSON.parse(String(raw)); } catch { return send({ kind: 'error', message: 'Invalid JSON' }); }
      try {
        switch (m?.op) {
          case 'ping': send({ kind: 'pong' }); break;
          case 'subscribe': {
            const id = String(m.sessionId ?? '');
            subs.get(id)?.();
            const since = Math.max(0, Number(m.since) || 0);
            const snapshot = manager.snapshot(id, since);
            subs.set(id, events.subscribe(id, (e) => send({ kind: 'event', event: e })));
            send({ kind: 'snapshot', sessionId: id, snapshot });
            break;
          }
          case 'unsubscribe': {
            const id = String(m.sessionId ?? '');
            subs.get(id)?.();
            subs.delete(id);
            break;
          }
          case 'watchAll': {
            if (cleanups.length) break;
            cleanups.push(events.watchAll((e) => { if (!subs.has(e.sessionId)) send({ kind: 'event', event: e }); }));
            cleanups.push(manager.onProjectsChanged((projects) => send({ kind: 'projects', projects })));
            send({ kind: 'projects', projects: manager.listProjects() });
            break;
          }
          default:
            send({ kind: 'error', message: 'Unknown op' });
        }
      } catch (e) {
        send({ kind: 'error', message: errMessage(e) });
      }
    });
    ws.on('close', () => {
      for (const u of subs.values()) u();
      for (const c of cleanups) c();
    });
    ws.on('error', () => { /* close follows */ });
  };

  return {
    server,
    wss,
    /** Serves a connection accepted on the tailnet socket. */
    acceptTailnet(socket: Socket) { viaTailnet.add(socket); server.emit('connection', socket); },
    /** Only called after TLS negotiation on the explicitly bound private home address. */
    acceptHome(socket: Socket) { viaHome.add(socket); server.emit('connection', socket); },
    closeClients() { for (const c of wss.clients) { try { c.terminate(); } catch { /* ignore */ } } },
  };
}
