import { request } from 'node:http';
import { afterAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { setupEnv } from './helpers.js';

setupEnv();
const { startServer } = await import('../../src/server/daemon.js');
const { LinaClient } = await import('../../src/shared/client.js');
const { validateRemoteOrigins, validateTailnetUsers } = await import('../../src/server/settings.js');
const { paths } = await import('../../src/server/paths.js');

const handle = await startServer({ port: 0, token: 'tok' });
const client = new LinaClient({ baseUrl: `http://127.0.0.1:${handle.port}`, token: 'tok' });
afterAll(() => handle.close());

/** A request as tailscale serve forwards it: the browser's Host and Origin, sent to the loopback port. */
function get(path: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const r = request({ host: '127.0.0.1', port: handle.port, path, headers: { authorization: 'Bearer tok', ...headers } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    r.on('error', reject);
    r.end();
  });
}

/** A request through the tailnet socket, as tailscale serve sends it to a unix: target (Host rewritten). */
function viaSocket(path: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const r = request({ socketPath: paths.tailnetSocket, path, headers: { host: 'localhost', ...headers } }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    r.on('error', reject);
    r.end();
  });
}

const TS = 'host.example.ts.net';

describe('remote origins (tailscale serve)', () => {
  it('rejects the tailnet name until it is configured', async () => {
    expect(await get('/api/sessions', { host: `${TS}:7077`, origin: `https://${TS}:7077` })).toBe(403);
  });

  it('accepts the configured origin for API calls and the live socket, and nothing else', async () => {
    const s = await client.putSettings({ remoteOrigins: [`https://${TS}:7077/`, `https://${TS}`] });
    expect(s.remoteOrigins).toEqual([`https://${TS}:7077`, `https://${TS}`]);
    expect(await get('/api/sessions', { host: `${TS}:7077`, origin: `https://${TS}:7077` })).toBe(200);
    expect(await get('/api/sessions', { host: TS, origin: `https://${TS}` })).toBe(200); // default port 443
    expect(await get('/api/sessions', { host: `${TS}:443` })).toBe(200);
    expect(await get('/api/sessions', { host: `${TS}:7077`, origin: 'https://evil.example' })).toBe(403);
    expect(await get('/api/sessions', { host: 'other.tail1234.ts.net:7077' })).toBe(403);
    expect(await get('/api/sessions', { host: `${TS}:7077`, origin: `http://${TS}:7077` })).toBe(403); // https only
    expect(await get('/api/sessions', { host: `${TS}:7077`, authorization: 'Bearer wrong' })).toBe(401); // token still required

    const opened = await new Promise<boolean>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/ws?token=tok`, { headers: { host: `${TS}:7077`, origin: `https://${TS}:7077` } });
      ws.on('open', () => { ws.close(); resolve(true); });
      ws.on('error', () => resolve(false));
    });
    expect(opened).toBe(true);
  });

  it('removes origins again', async () => {
    const s = await client.putSettings({ remoteOrigins: [] });
    expect(s.remoteOrigins).toBeUndefined();
    expect(await get('/api/sessions', { host: `${TS}:7077` })).toBe(403);
  });

  it('signs in an allowed Tailscale login only through the tailnet socket', async () => {
    await client.putSettings({ remoteOrigins: [`https://${TS}:7077`], tailnetUsers: ['Me@Example.com'] });
    const origin = `https://${TS}:7077`;
    const me = { 'tailscale-user-login': 'me@example.com', origin };
    const ok = await viaSocket('/api/health', me);
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body).tailnetUser).toBe('me@example.com');
    expect((await viaSocket('/api/sessions', me)).status).toBe(200);
    expect((await viaSocket('/api/sessions', { 'tailscale-user-login': 'someone@else.com', origin })).status).toBe(401);
    expect((await viaSocket('/api/sessions', { origin })).status).toBe(401); // tagged device / no identity
    expect((await viaSocket('/api/sessions', { origin, authorization: 'Bearer tok' })).status).toBe(200); // token still works
    expect((await viaSocket('/api/sessions', { ...me, origin: 'https://evil.example' })).status).toBe(403);
    // the same header sent to the TCP port is ignored
    expect(await get('/api/sessions', { host: `${TS}:7077`, origin, 'tailscale-user-login': 'me@example.com', authorization: 'Bearer nope' })).toBe(401);

    const wsOpen = (headers: Record<string, string>) => new Promise<boolean>((resolve) => {
      const ws = new WebSocket('ws+unix://' + paths.tailnetSocket + ':/ws?token=', { headers: { host: 'localhost', ...headers } });
      ws.on('open', () => { ws.close(); resolve(true); });
      ws.on('error', () => resolve(false));
    });
    expect(await wsOpen(me)).toBe(true);
    expect(await wsOpen({ 'tailscale-user-login': 'someone@else.com', origin })).toBe(false);
    await client.putSettings({ remoteOrigins: [], tailnetUsers: [] });
    expect((await viaSocket('/api/sessions', me)).status).toBe(401); // sign-in removed
  });

  it('only stores plain https origins and email logins', () => {
    expect(validateTailnetUsers([' A@B.com ', 'a@b.com'])).toEqual(['a@b.com']);
    expect(() => validateTailnetUsers(['not an email'])).toThrow();
    expect(() => validateTailnetUsers('a@b.com')).toThrow();
    for (const bad of ['http://x.ts.net', 'https://x.ts.net/path', 'https://u:p@x.ts.net', 'https://x.ts.net/?a=1', 'nope']) {
      expect(() => validateRemoteOrigins([bad]), bad).toThrow();
    }
    expect(() => validateRemoteOrigins('https://x.ts.net')).toThrow();
    expect(validateRemoteOrigins(['https://X.ts.net:443', 'https://x.ts.net'])).toEqual(['https://x.ts.net']);
  });
});
