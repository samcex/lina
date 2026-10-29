// Isomorphic LINA client (Node ≥22 and browsers): uses global fetch + WebSocket.
import type { ApiError, ClientMessage, ServerMessage, ConnectionBundle, HomeConfig, HomeStatus } from './protocol.js';
import type {
  AgentId, AgentModels, AnyLinaEvent, ApplyStrategy, Attachment, DiffFile, DoctorCheck, ModelValidation,
  Project, ProjectSettings, SearchHit, Session, SessionConfig, SessionSnapshot, Settings, TreeEntry, TurnChange, Preview,
} from './types.js';

export class LinaApiError extends Error {
  constructor(message: string, public status: number, public code?: string, public hint?: string) { super(message); }
}

export interface ClientOptions {
  baseUrl: string;
  token: string;
  /**
   * Re-reads where the daemon is and its current token. The daemon issues a new token on every start, so a
   * long-lived client (the TUI) calls this after a 401 or a refused live connection instead of failing.
   */
  refresh?: () => Promise<{ baseUrl: string; token: string } | undefined>;
}

/** Applies refreshed credentials; true when they changed (so a retry can succeed). */
async function refreshCredentials(opts: ClientOptions): Promise<boolean> {
  const next = await opts.refresh?.().catch(() => undefined);
  if (!next || (next.token === opts.token && next.baseUrl === opts.baseUrl)) return false;
  opts.baseUrl = next.baseUrl;
  opts.token = next.token;
  return true;
}

export class LinaClient {
  constructor(public opts: ClientOptions) {}

  private async req<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}, observe?: (res: Response) => void, signal?: AbortSignal): Promise<T> {
    const isRaw = body instanceof Uint8Array || (typeof Blob !== 'undefined' && body instanceof Blob);
    let sentBaseUrl = this.opts.baseUrl;
    let sentToken = this.opts.token;
    const request = () => {
      sentBaseUrl = this.opts.baseUrl;
      sentToken = this.opts.token;
      return fetch(sentBaseUrl + path, {
        method,
        signal,
        headers: {
          authorization: `Bearer ${sentToken}`,
          ...(body !== undefined && !isRaw ? { 'content-type': 'application/json' } : {}),
          ...headers,
        },
        body: body === undefined ? undefined : isRaw ? (body as BodyInit) : JSON.stringify(body),
      });
    };
    let res: Response;
    try { res = await request(); }
    catch (error) {
      // A daemon restart can close a pooled keep-alive socket. Only reads are safe to replay.
      if (method !== 'GET' || signal?.aborted) throw error;
      await refreshCredentials(this.opts);
      res = await request();
    }
    // A 401 means the request was refused before it ran, so replaying it with a fresh token is safe.
    if (res.status === 401) {
      await refreshCredentials(this.opts);
      // Concurrent reads (and the live socket) share opts. One may already have
      // refreshed them while this request's 401 was still in flight.
      if (sentToken !== this.opts.token || sentBaseUrl !== this.opts.baseUrl) res = await request();
    }
    const text = await res.text();
    let data: unknown;
    let invalidJson = false;
    try { data = text ? JSON.parse(text) : undefined; }
    catch { invalidJson = true; }
    if (!res.ok) {
      // SSH/Tailscale proxies can return HTML or plain text while the daemon is
      // unavailable. Preserve the HTTP status for authentication/error recovery.
      const e = (data && typeof data === 'object' ? data : {}) as ApiError;
      throw new LinaApiError(e.error ?? `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`, res.status, e.code, e.hint);
    }
    if (invalidJson) throw new LinaApiError('The server returned an unreadable response. Check the LINA connection and try again.', res.status, 'invalid_response');
    observe?.(res);
    return data as T;
  }

  health() { return this.req<{ ok: true; version: string; pid: number; uptimeMs: number; serverId: string }>('GET', '/api/health'); }
  connection() { return this.req<ConnectionBundle>('GET', '/api/connection'); }
  home() { return this.req<HomeStatus>('GET', '/api/home'); }
  putHome(config: HomeConfig) { return this.req<HomeStatus>('PUT', '/api/home', config); }
  getSettings() { return this.req<Settings>('GET', '/api/settings'); }
  putSettings(s: Partial<Settings>) { return this.req<Settings>('PUT', '/api/settings', s); }
  doctor(live = false) { return this.req<{ checks: DoctorCheck[] }>('GET', `/api/doctor${live ? '?live=1' : ''}`); }
  models(refresh = false) { return this.req<Record<AgentId, AgentModels>>('GET', `/api/models${refresh ? '?refresh=1' : ''}`); }
  validateModel(agent: AgentId, model: string) { return this.req<ModelValidation>('POST', '/api/models/validate', { agent, model }); }

  projects() { return this.req<Project[]>('GET', '/api/projects'); }
  addProject(body: { path: string; name?: string; create?: boolean; initGit?: boolean }) { return this.req<Project>('POST', '/api/projects', body); }
  updateProject(id: string, body: { name?: string; settings?: Partial<ProjectSettings> }) { return this.req<Project>('PATCH', `/api/projects/${id}`, body); }
  removeProject(id: string) { return this.req<{ ok: true }>('DELETE', `/api/projects/${id}`); }
  projectTree(id: string) { return this.req<TreeEntry[]>('GET', `/api/projects/${id}/tree`); }

  sessions(q: { projectId?: string; q?: string } = {}) {
    const p = new URLSearchParams(Object.entries(q).filter(([, v]) => v) as [string, string][]);
    return this.req<Session[]>('GET', `/api/sessions${p.size ? '?' + p : ''}`);
  }
  createSession(body: { projectId: string; title?: string; config?: Partial<SessionConfig>; prompt?: string }) { return this.req<Session>('POST', '/api/sessions', body); }
  session(id: string, since?: number) { return this.req<SessionSnapshot>('GET', `/api/sessions/${id}${since === undefined ? '' : `?since=${since}`}`); }
  /** All contiguous events through the high-water mark captured by the first page. */
  async events(id: string, since = 0, through?: number, signal?: AbortSignal): Promise<AnyLinaEvent[]> {
    const events: AnyLinaEvent[] = [];
    let cursor = since, highWater = through;
    for (;;) {
      if (highWater !== undefined && cursor >= highWater) break;
      const limit = highWater === undefined ? 2000 : Math.min(2000, highWater - cursor);
      const page = await this.req<AnyLinaEvent[]>('GET', `/api/sessions/${id}/events?since=${cursor}&limit=${limit}`, undefined, {}, (res) => {
        const value = res.headers.get('x-lina-last-seq');
        if (highWater === undefined && value !== null && Number.isSafeInteger(Number(value))) highWater = Number(value);
      }, signal);
      if (!page.length) {
        if (highWater !== undefined && cursor < highWater) throw new Error('Session history ended before the requested cursor');
        break;
      }
      const included = page.filter((e) => highWater === undefined || e.seq <= highWater);
      for (const event of included) {
        if (event.seq !== cursor + 1) throw new Error('Session history has a gap; reconnect to retry');
        events.push(event);
        cursor = event.seq;
      }
      if (page.length < limit || !included.length) break;
    }
    return events;
  }
  /** An older chronological page, exclusive of before. */
  history(id: string, before: number, limit = 500) {
    return this.req<AnyLinaEvent[]>('GET', `/api/sessions/${id}/events?before=${before}&limit=${limit}`);
  }
  updateSession(id: string, body: { title?: string; config?: Partial<SessionConfig> }) { return this.req<Session>('PATCH', `/api/sessions/${id}`, body); }
  deleteSession(id: string) { return this.req<{ ok: true }>('DELETE', `/api/sessions/${id}?confirm=1`); }
  turnChanges(id: string) { return this.req<TurnChange[]>('GET', `/api/sessions/${id}/changes`); }
  turnDiff(id: string, turn: number) { return this.req<{ base: string; head: string; files: DiffFile[] }>('GET', `/api/sessions/${id}/changes/${turn}`); }
  undo(id: string, turn?: number) { return this.req<TurnChange>('POST', `/api/sessions/${id}/undo`, { turn }); }
  previews(id: string) { return this.req<Preview[]>('GET', `/api/sessions/${id}/previews`); }
  startPreview(id: string, body: { command: string; port?: number }) { return this.req<Preview>('POST', `/api/sessions/${id}/previews`, body); }
  stopPreview(id: string, preview: string) { return this.req<Preview>('POST', `/api/sessions/${id}/previews/${encodeURIComponent(preview)}/stop`, {}); }
  previewLogs(id: string, preview: string) { return this.req<{ output: string }>('GET', `/api/sessions/${id}/previews/${encodeURIComponent(preview)}/logs`); }
  send(id: string, text: string, opts: { attachments?: string[]; interrupt?: boolean } = {}) {
    return this.req<{ ok: true; queued: boolean; takeover?: AgentId }>('POST', `/api/sessions/${id}/messages`, { text, ...opts });
  }
  upload(id: string, name: string, mime: string, bytes: Uint8Array | Blob) {
    return this.req<Attachment>('POST', `/api/sessions/${id}/attachments`, bytes, { 'x-filename': encodeURIComponent(name), 'content-type': mime || 'application/octet-stream' });
  }
  control(id: string, action: 'pause' | 'resume' | 'cancel' | 'review' | 'retry') { return this.req<Session>('POST', `/api/sessions/${id}/control`, { action }); }
  approval(id: string, body: { decision: 'approve' | 'reject' | 'waive' | 'choose'; strategy?: ApplyStrategy; note?: string; findingId?: string; variant?: AgentId }) {
    return this.req<Session>('POST', `/api/sessions/${id}/approval`, body);
  }
  diff(id: string, q: { from?: string; to?: string; variant?: AgentId } = {}) {
    const p = new URLSearchParams(Object.entries(q).filter(([, v]) => v) as [string, string][]);
    return this.req<{ base: string; head: string; files: DiffFile[] }>('GET', `/api/sessions/${id}/diff${p.size ? '?' + p : ''}`);
  }
  tree(id: string, variant?: AgentId) { return this.req<TreeEntry[]>('GET', `/api/sessions/${id}/tree${variant ? `?variant=${variant}` : ''}`); }
  file(id: string, path: string, variant?: AgentId) {
    return this.req<{ path: string; content: string; truncated: boolean; binary: boolean }>('GET', `/api/sessions/${id}/file?path=${encodeURIComponent(path)}${variant ? `&variant=${variant}` : ''}`);
  }
  search(q: string) { return this.req<SearchHit[]>('GET', `/api/search?q=${encodeURIComponent(q)}`); }

  /** Opens a live connection that auto-reconnects and re-subscribes with the last seen seq. */
  connect(handlers: LiveHandlers): LiveConnection { return new LiveConnection(this.opts, handlers); }
}

export interface LiveHandlers {
  onMessage(msg: ServerMessage): void;
  onStatus?(s: 'connecting' | 'open' | 'closed'): void;
}

export class LiveConnection {
  private ws?: WebSocket;
  private closed = false;
  private subs = new Map<string, number>(); // sessionId → last seq seen
  private subVersions = new Map<string, number>();
  private watchingAll = false;
  private retry = 0;
  private opened = false;
  private pingTimer?: ReturnType<typeof setInterval>;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private hydrationAbort?: AbortController;

  constructor(private opts: ClientOptions, private h: LiveHandlers) { this.open(); }

  private open() {
    if (this.closed) return;
    this.h.onStatus?.('connecting');
    const url = this.opts.baseUrl.replace(/^http/, 'ws') + `/ws?token=${encodeURIComponent(this.opts.token)}`;
    const ws = new WebSocket(url);
    const hydrationAbort = new AbortController();
    this.hydrationAbort = hydrationAbort;
    this.ws = ws;
    this.opened = false;
    let abandoned = false;
    const current = () => !this.closed && this.ws === ws && !abandoned;
    ws.onopen = () => {
      if (!current()) { try { ws.close(); } catch { /* closed */ } return; }
      this.opened = true;
      if (!this.subs.size) this.retry = 0;
      this.h.onStatus?.('open');
      if (!current()) return;
      if (this.watchingAll) this.raw({ op: 'watchAll' });
      for (const [sessionId, since] of this.subs) this.raw({ op: 'subscribe', sessionId, since });
      this.pingTimer = setInterval(() => this.raw({ op: 'ping' }), 25_000);
    };
    let delivery = Promise.resolve();
    ws.onmessage = (ev) => {
      let msg: ServerMessage;
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); } catch { return; }
      const sid = msg.kind === 'snapshot' ? msg.sessionId : msg.kind === 'event' ? msg.event.sessionId : undefined;
      const version = sid === undefined ? undefined : this.subVersions.get(sid);
      const applicable = () => current() && (sid === undefined || version === this.subVersions.get(sid));
      // A truncated reconnect snapshot must be complete before any following live
      // events are acknowledged, otherwise the missing middle is lost forever.
      delivery = delivery.then(async () => {
        if (!applicable()) return;
        if (msg.kind === 'snapshot') {
          if (!this.subs.has(msg.sessionId)) return;
          const snap = msg.snapshot;
          if (snap.history?.hasLater) {
            const more = await new LinaClient(this.opts).events(msg.sessionId, snap.history.cursor, snap.session.lastSeq, hydrationAbort.signal);
            if (!applicable() || !this.subs.has(msg.sessionId)) return;
            snap.events = [...snap.events, ...more];
            snap.history = { ...snap.history, cursor: snap.events.at(-1)?.seq ?? snap.history.cursor, hasLater: false };
          }
          if (!applicable()) return;
          this.h.onMessage(msg);
          this.retry = 0; // the subscription, including its full replay, is healthy
          const cursor = snap.history?.cursor ?? snap.events.at(-1)?.seq ?? this.subs.get(msg.sessionId) ?? 0;
          if (applicable() && this.subs.has(msg.sessionId)) this.subs.set(msg.sessionId, Math.max(this.subs.get(msg.sessionId) ?? 0, cursor));
        } else {
          this.h.onMessage(msg);
          if (applicable() && msg.kind === 'event' && msg.event.seq > 0 && this.subs.has(msg.event.sessionId)) {
            const cursor = this.subs.get(msg.event.sessionId) ?? 0;
            // A watchAll session.updated can race the subscribe response. It
            // describes current state but does not prove the intervening events
            // were received. Keep the last contiguous replay acknowledgement.
            if (msg.event.seq === cursor + 1) this.subs.set(msg.event.sessionId, msg.event.seq);
          }
        }
      }).catch(() => {
        if (!current()) return;
        abandoned = true;
        this.h.onMessage({ kind: 'error', message: 'Could not reload complete session history; reconnecting to retry.' });
        retryLater();
        try { ws.close(); } catch { /* already closed */ }
      });
    };
    let retrying = false;
    const retryLater = () => {
      if (retrying || this.ws !== ws) return;
      retrying = true;
      abandoned = true;
      hydrationAbort.abort();
      clearInterval(this.pingTimer);
      this.h.onStatus?.('closed');
      if (this.closed) return;
      const delay = Math.min(10_000, 300 * 2 ** this.retry++);
      // Refused before opening: possibly a daemon restart with a new token (or port).
      const ready = this.opened ? Promise.resolve(false) : refreshCredentials(this.opts);
      void ready.then(() => {
        if (!this.closed && this.ws === ws) this.retryTimer = setTimeout(() => this.open(), delay);
      });
    };
    ws.onclose = retryLater;
    // Node's WebSocket reports a refused handshake only as an error and never closes, so retry from here too.
    ws.onerror = () => {
      if (!this.opened && !retrying) {
        // Mark the retry first: closing a failed CONNECTING socket can synchronously
        // dispatch another error in Node's WebSocket implementation.
        retryLater();
        try { ws.close(); } catch { /* not open */ }
      }
    };
  }

  private raw(m: ClientMessage) { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(m)); }

  subscribe(sessionId: string, since = 0) { this.subVersions.set(sessionId, (this.subVersions.get(sessionId) ?? 0) + 1); this.subs.set(sessionId, since); this.raw({ op: 'subscribe', sessionId, since }); }
  unsubscribe(sessionId: string) { this.subVersions.set(sessionId, (this.subVersions.get(sessionId) ?? 0) + 1); this.subs.delete(sessionId); this.raw({ op: 'unsubscribe', sessionId }); }
  watchAll() { this.watchingAll = true; this.raw({ op: 'watchAll' }); }
  close() { this.closed = true; clearInterval(this.pingTimer); clearTimeout(this.retryTimer); this.hydrationAbort?.abort(); this.ws?.close(); }
}
