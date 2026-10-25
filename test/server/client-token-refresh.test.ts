import { afterAll, describe, expect, it } from 'vitest';
import { setupEnv, waitUntil } from './helpers.js';

setupEnv();
const { startServer } = await import('../../src/server/daemon.js');
const { LinaClient } = await import('../../src/shared/client.js');

const handle = await startServer({ port: 0, token: 'current-token' });
const baseUrl = `http://127.0.0.1:${handle.port}`;
afterAll(() => handle.close());

describe('client after a daemon restart issued a new token', () => {
  it('refreshes the token once on 401 and replays the request', async () => {
    let calls = 0;
    const client = new LinaClient({ baseUrl, token: 'stale-token', refresh: async () => { calls++; return { baseUrl, token: 'current-token' }; } });
    expect(await client.sessions()).toEqual([]);
    expect(await client.createSession({ projectId: 'nope' }).catch((e) => e.status)).toBe(404); // POST works with the new token too
    expect(calls).toBe(1);
  });

  it('still fails when the refreshed token is the same or refresh is unavailable', async () => {
    const same = new LinaClient({ baseUrl, token: 'stale-token', refresh: async () => ({ baseUrl, token: 'stale-token' }) });
    await expect(same.sessions()).rejects.toMatchObject({ status: 401 });
    const none = new LinaClient({ baseUrl, token: 'stale-token' });
    await expect(none.sessions()).rejects.toMatchObject({ status: 401 });
  });

  it('recovers all concurrent reads when another request has already refreshed the token', async () => {
    const client = new LinaClient({ baseUrl, token: 'stale-token', refresh: async () => ({ baseUrl, token: 'current-token' }) });
    const results = await Promise.allSettled([client.sessions(), client.projects(), client.getSettings()]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled']);
  });

  it('reconnects the live socket with the refreshed token', async () => {
    const client = new LinaClient({ baseUrl, token: 'stale-token', refresh: async () => ({ baseUrl, token: 'current-token' }) });
    const opened = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 5000);
      const conn = client.connect({ onMessage: () => {}, onStatus: (s) => { if (s === 'open') { clearTimeout(timer); conn.close(); resolve(true); } } });
    });
    expect(opened).toBe(true);
  });

  it('reconnects an established socket after the daemon restarts and rotates its token', async () => {
    let srv = await startServer({ port: 0, token: 'before-restart' });
    const restartPort = srv.port;
    let token = 'before-restart';
    const client = new LinaClient({ baseUrl: `http://127.0.0.1:${restartPort}`, token, refresh: async () => ({ baseUrl: `http://127.0.0.1:${restartPort}`, token }) });
    let opens = 0;
    const conn = client.connect({ onMessage: () => {}, onStatus: (status) => { if (status === 'open') opens++; } });
    try {
      await waitUntil(() => opens === 1, 5000);
      await srv.close();
      token = 'after-restart';
      srv = await startServer({ port: restartPort, token });
      await waitUntil(() => opens === 2, 8000, 'established socket reconnected');
    } finally { conn.close(); await srv.close(); }
  });
});
