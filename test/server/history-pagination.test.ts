import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { makeRepo, setupEnv, waitUntil } from './helpers.js';
import type { AnyLinaEvent, SessionSnapshot } from '../../src/shared/types.js';
import type { ServerMessage } from '../../src/shared/protocol.js';

setupEnv();
const { startServer } = await import('../../src/server/daemon.js');
const { LinaClient } = await import('../../src/shared/client.js');
let srv = await startServer({ port: 0 });
const baseUrl = `http://127.0.0.1:${srv.port}`;
const headers = { authorization: `Bearer ${srv.token}` };
const api = new LinaClient({ baseUrl, token: srv.token });
afterAll(() => srv.close());
afterEach(() => vi.unstubAllGlobals());
const project = await api.addProject({ path: makeRepo() });
async function session() { return api.createSession({ projectId: project.id, config: { mock: true } }); }
function append(id: string, count: number) {
  for (let i = 0; i < count; i++) srv.manager.events.append(id, 'message', 'user', { id: 'm' + i, text: `Context ${i}`, kind: 'chat' });
}

describe('bounded complete session history', () => {
  it('retains a recent initial window, loads older searchable messages and replays every forward page', async () => {
    const s = await session();
    const old = srv.manager.events.append(s.id, 'message', 'user', { id: 'old', text: 'uniquepaginationanchor old instruction', kind: 'chat' });
    append(s.id, 4500);
    const initial = await api.session(s.id);
    expect(initial.events).toHaveLength(2000);
    expect(initial.history).toEqual({ firstSeq: initial.events[0].seq, cursor: initial.session.lastSeq, hasEarlier: true, hasLater: false });
    expect(initial.events.some((e) => e.seq === old.seq)).toBe(false);
    expect((await api.search('uniquepaginationanchor'))[0].seq).toBe(old.seq);
    const earlier: AnyLinaEvent[] = [];
    let before = initial.events[0].seq;
    while (before > 1) {
      const page = await api.history(s.id, before);
      expect(page.length).toBeLessThanOrEqual(500);
      expect(page.at(-1)!.seq).toBe(before - 1);
      earlier.unshift(...page);
      before = page[0].seq;
    }
    expect(earlier.some((e) => e.seq === old.seq)).toBe(true);
    const all = await api.events(s.id);
    expect(all).toEqual([...earlier, ...initial.events]);
    expect(all.map((e) => e.seq)).toEqual(Array.from({ length: initial.session.lastSeq }, (_, i) => i + 1));
    const incremental = await api.session(s.id, old.seq);
    expect(incremental.events[0].seq).toBe(old.seq + 1);
    expect(incremental.history).toMatchObject({ cursor: old.seq + 2000, hasLater: true });
    const raw = await fetch(`${baseUrl}/api/sessions/${s.id}/events?since=${old.seq}&limit=3`, { headers });
    expect(raw.headers.get('x-lina-last-seq')).toBe(String(initial.session.lastSeq));
    expect((await raw.json()).map((e: AnyLinaEvent) => e.seq)).toEqual([old.seq + 1, old.seq + 2, old.seq + 3]);
  });

  it('validates page boundaries and mutually exclusive cursors', async () => {
    const s = await session();
    for (const query of ['before=0', 'before=NaN', 'since=-1', 'since=0.5', 'limit=2001', 'limit=0', 'before=3&since=0']) {
      expect((await fetch(`${baseUrl}/api/sessions/${s.id}/events?${query}`, { headers })).status).toBe(400);
    }
  });

  it('hydrates a reconnect gap larger than the snapshot cap before delivering queued live events', async () => {
    const s = await session();
    const cursor = (await api.session(s.id)).session.lastSeq;
    append(s.id, 4500);
    const highWater = srv.manager.getSession(s.id).lastSeq;
    const snapshots: SessionSnapshot[] = [], delivered: ServerMessage[] = [];
    const nativeFetch = globalThis.fetch;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let requested = false;
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes(`/api/sessions/${s.id}/events?`)) { requested = true; await held; }
      return nativeFetch(input, init);
    });
    const conn = api.connect({ onMessage: (msg) => { delivered.push(msg); if (msg.kind === 'snapshot') snapshots.push(msg.snapshot); } });
    conn.subscribe(s.id, cursor);
    try {
      await waitUntil(() => requested, 5000, 'history hydration request');
      const tail = srv.manager.events.append(s.id, 'message', 'user', { id: 'queued-tail', text: 'arrived while hydrating', kind: 'chat' });
      expect(snapshots).toEqual([]);
      release();
      await waitUntil(() => delivered.some((m) => m.kind === 'event' && m.event.seq === tail.seq), 5000, 'queued live tail');
      expect(snapshots[0].events.map((e) => e.seq)).toEqual(Array.from({ length: highWater - cursor }, (_, i) => cursor + i + 1));
      expect(snapshots[0].history).toMatchObject({ cursor: highWater, hasLater: false });
      expect(delivered.findIndex((m) => m.kind === 'snapshot')).toBeLessThan(delivered.findIndex((m) => m.kind === 'event' && m.event.seq === tail.seq));
    } finally { release(); conn.close(); }
  });

  it('does not acknowledge a failed hydration and retries the complete gap on reconnect', async () => {
    const s = await session();
    const cursor = (await api.session(s.id)).session.lastSeq;
    append(s.id, 2100);
    const nativeFetch = globalThis.fetch;
    let failedCalls = 0;
    vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes(`/api/sessions/${s.id}/events?`) && failedCalls++ < 2) return Promise.reject(new TypeError('simulated outage'));
      return nativeFetch(input, init);
    });
    const snapshots: SessionSnapshot[] = [], errors: string[] = [];
    const conn = api.connect({ onMessage: (m) => { if (m.kind === 'snapshot') snapshots.push(m.snapshot); if (m.kind === 'error') errors.push(m.message); } });
    conn.subscribe(s.id, cursor);
    try {
      await waitUntil(() => snapshots.length === 1, 8000, 'hydration retried after reconnect');
      expect(errors).toContain('Could not reload complete session history; reconnecting to retry.');
      expect(snapshots[0].events[0].seq).toBe(cursor + 1);
      expect(snapshots[0].events).toHaveLength(2100);
    } finally { conn.close(); }
  });

  it('discards hydration after unsubscribing or closing the connection', async () => {
    const s = await session();
    const cursor = (await api.session(s.id)).session.lastSeq;
    append(s.id, 2100);
    const nativeFetch = globalThis.fetch;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let requested = false;
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes(`/api/sessions/${s.id}/events?`)) { requested = true; await held; }
      return nativeFetch(input, init);
    });
    const snapshots: SessionSnapshot[] = [];
    const conn = api.connect({ onMessage: (m) => { if (m.kind === 'snapshot') snapshots.push(m.snapshot); } });
    conn.subscribe(s.id, cursor);
    try {
      await waitUntil(() => requested);
      conn.unsubscribe(s.id);
      conn.close();
      release();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(snapshots).toEqual([]);
    } finally { release(); conn.close(); }
  });

  it('replays more than 2000 events after an actual daemon restart with a new token', async () => {
    const s = await session();
    const snapshots: SessionSnapshot[] = [];
    const reconnecting = new LinaClient({ baseUrl, token: api.opts.token, refresh: async () => ({ baseUrl, token: api.opts.token }) });
    const conn = reconnecting.connect({ onMessage: (m) => { if (m.kind === 'snapshot') snapshots.push(m.snapshot); } });
    conn.subscribe(s.id);
    try {
      await waitUntil(() => snapshots.length === 1);
      const cursor = snapshots[0].history!.cursor;
      const port = srv.port;
      await srv.close();
      srv = await startServer({ port, token: 'history-after-real-restart' });
      api.opts.token = srv.token;
      append(s.id, 4500);
      const highWater = srv.manager.getSession(s.id).lastSeq;
      await waitUntil(() => snapshots.length === 2, 10000, 'complete replay after daemon restart');
      expect(snapshots[1].events.map((e) => e.seq)).toEqual(Array.from({ length: highWater - cursor }, (_, i) => cursor + i + 1));
      expect(snapshots[1].history).toMatchObject({ cursor: highWater, hasLater: false });
    } finally { conn.close(); }
  });
});
