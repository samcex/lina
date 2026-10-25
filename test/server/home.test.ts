import { createHash, generateKeyPairSync, X509Certificate } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect } from 'node:net';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { startServer, type ServerHandle } from '../../src/server/daemon.js';
import { HomeAccess, homeAddresses, isPrivateIPv4 } from '../../src/server/home.js';
import { LinaClient } from '../../src/shared/client.js';
import type { ConnectionBundle } from '../../src/shared/protocol.js';
import { setupEnv } from './helpers.js';

let home: string;
let server: ServerHandle | undefined;
let client: LinaClient;
const address = homeAddresses()[0]?.address;

beforeEach(async () => {
  home = setupEnv();
  server = await startServer({ port: 0 });
  client = new LinaClient({ baseUrl: `http://127.0.0.1:${server.port}`, token: server.token });
});
afterEach(async () => { await server?.close(); rmSync(home, { recursive: true, force: true }); });

function tlsGet(bundle: ConnectionBundle, path = '/api/health', headers: Record<string, string> = {}, pin = bundle.home!.certificateSha256): Promise<{ status: number; body: string; location?: string }> {
  return new Promise((resolve, reject) => {
    const cert = readFileSync(join(home, 'home-access', 'cert.pem'));
    const request = httpsRequest(bundle.home!.url + path, {
      ca: cert,
      checkServerIdentity: (_, leaf) => createHash('sha256').update(leaf.raw).digest('hex') === pin ? undefined : new Error('Certificate pin mismatch'),
      headers: { authorization: `Bearer ${bundle.token}`, ...headers }, agent: false,
    }, (response) => {
      let body = '';
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode!, body, location: response.headers.location }));
    });
    request.on('error', reject); request.end();
  });
}

function tailnetGet(path: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ socketPath: join(home, 'tailnet.sock'), path, headers: { host: 'localhost', ...headers } }, (response) => {
      let body = ''; response.on('data', (c) => { body += c; });
      response.on('end', () => resolve({ status: response.statusCode!, body }));
    });
    request.on('error', reject); request.end();
  });
}

describe('private home access', () => {
  it('rejects a paired client targeting another server before reads or writes are handled', async () => {
    const bundle = await client.connection();
    const settings = await client.getSettings();
    for (const method of ['GET', 'PUT']) {
      const response = await fetch(client.opts.baseUrl + '/api/settings', {
        method, headers: { authorization: `Bearer ${server!.token}`, 'x-lina-server-id': 'different-server', 'content-type': 'application/json' },
        ...(method === 'PUT' ? { body: JSON.stringify({ accessMode: settings.accessMode === 'full' ? 'restricted' : 'full' }) } : {}),
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: 'server_identity' });
    }
    expect(await client.getSettings()).toEqual(settings);
    const health = await fetch(client.opts.baseUrl + '/api/health', { headers: { authorization: `Bearer ${server!.token}`, 'x-lina-server-id': bundle.serverId } });
    expect(health.status).toBe(200);
  });
  it('starts disabled and pairs only through existing authenticated channels without leaking credentials in status/settings', async () => {
    expect(await client.home()).toMatchObject({ enabled: false, active: false });
    const bundle = await client.connection();
    expect(bundle).toMatchObject({ version: 1, serverId: expect.stringMatching(/^[0-9a-f-]{36}$/), token: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(bundle.home).toBeUndefined();
    expect((await client.health()).serverId).toBe(bundle.serverId);
    expect(JSON.stringify(await client.home())).not.toContain(bundle.token);
    expect(JSON.stringify(await client.getSettings())).not.toContain(bundle.token);
    const unauth = await fetch(client.opts.baseUrl + '/api/connection');
    expect(unauth.status).toBe(401); expect(await unauth.text()).not.toContain(bundle.token);
    expect(statSync(join(home, 'home-access')).mode & 0o777).toBe(0o700);
    expect(statSync(join(home, 'home-access', 'identity.json')).mode & 0o777).toBe(0o600);
    expect(existsSync(join(home, 'home-access', 'key.pem'))).toBe(false);
    await client.putSettings({ remoteOrigins: ['https://test.tail1234.ts.net:7077'], tailnetUsers: ['me@example.com'] });
    const paired = await tailnetGet('/api/connection', { 'tailscale-user-login': 'me@example.com', origin: 'https://test.tail1234.ts.net:7077' });
    expect(paired.status).toBe(200);
    expect(JSON.parse(paired.body)).toMatchObject({ ...bundle, tailnetUrl: 'https://test.tail1234.ts.net:7077' });
    expect((await tailnetGet('/api/connection', { authorization: `Bearer ${bundle.token}` })).status).toBe(401);
    expect((await fetch(client.opts.baseUrl + '/api/health', { headers: { authorization: `Bearer ${bundle.token}` } })).status).toBe(401);
  });

  it('refuses wildcard/public/overlay/loopback/unassigned and malformed configurations', async () => {
    for (const host of ['0.0.0.0', '127.0.0.1', '100.64.0.10', '8.8.8.8', '192.168.001.10', '192.168.255.254', '192.168.122.1', '172.17.0.1', '::1']) {
      await expect(client.putHome({ enabled: true, host })).rejects.toMatchObject({ status: 400 });
    }
    for (const body of [{ enabled: 'yes' }, { enabled: true, port: 0 }, { enabled: true, port: 65536 }, { enabled: true, token: 'secret' }, []]) {
      const response = await fetch(client.opts.baseUrl + '/api/home', { method: 'PUT', headers: { authorization: `Bearer ${server!.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      expect(response.status).toBe(400);
    }
    expect(await client.home()).toMatchObject({ enabled: false, active: false });
    for (const ip of ['10.2.3.4', '172.16.0.1', '172.31.255.255', '192.168.1.2']) expect(isPrivateIPv4(ip)).toBe(true);
    for (const ip of ['172.15.0.1', '172.32.0.1', '192.169.1.1', '10.1.2.256']) expect(isPrivateIPv4(ip)).toBe(false);
  });

  it.skipIf(!address)('serves real pinned TLS with a home-only bearer, exact Host/Origin, no redirects or trusted proxy headers', async () => {
    await client.putSettings({ remoteOrigins: ['https://test.tail1234.ts.net:7077'], tailnetUsers: ['me@example.com'] });
    const status = await client.putHome({ enabled: true, host: address });
    expect(status).toMatchObject({ enabled: true, active: true, host: address, port: server!.port });
    const bundle = await client.connection();
    expect(bundle.home!.url).toBe(`https://${address}:${server!.port}`);
    const cert = new X509Certificate(readFileSync(join(home, 'home-access', 'cert.pem')));
    expect(bundle.home!.certificateSha256).toBe(createHash('sha256').update(cert.raw).digest('hex'));
    for (const file of ['key.pem', 'cert.pem', 'config.json']) expect(statSync(join(home, 'home-access', file)).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(home, 'home-access', 'config.json'), 'utf8')).not.toContain(bundle.token);
    const health = await tlsGet(bundle);
    expect(health.status).toBe(200); expect(JSON.parse(health.body).serverId).toBe(bundle.serverId);
    expect(JSON.parse(health.body).tailnetUser).toBeUndefined(); expect(health.location).toBeUndefined();
    expect((await tlsGet(bundle, '/api/sessions', { origin: bundle.home!.url })).status).toBe(200);
    expect((await tlsGet(bundle, '/api/health', { authorization: `Bearer ${server!.token}` })).status).toBe(401);
    const spoof = await tlsGet(bundle, '/api/health', { authorization: '', 'tailscale-user-login': 'me@example.com' });
    expect(spoof.status).toBe(401); expect(spoof.location).toBeUndefined(); expect(spoof.body).not.toContain(bundle.token);
    for (const host of ['evil.example', `127.0.0.1:${server!.port}`, 'test.tail1234.ts.net:7077']) expect((await tlsGet(bundle, '/api/health', { host })).status).toBe(403);
    for (const origin of ['https://evil.example', 'https://test.tail1234.ts.net:7077', bundle.home!.url + '/', bundle.home!.url.replace('https:', 'http:')]) expect((await tlsGet(bundle, '/api/health', { origin })).status).toBe(403);
    expect((await tlsGet(bundle, '/api/connection')).status).toBe(403);
    expect((await tlsGet(bundle, '/api/home')).status).toBe(403);
    await expect(tlsGet(bundle, '/api/health', {}, '0'.repeat(64))).rejects.toThrow(/pin mismatch/);
    const plain = await new Promise<boolean>((resolve) => {
      const req = httpRequest(bundle.home!.url.replace('https:', 'http:') + '/api/health', () => resolve(false));
      req.on('error', () => resolve(true)); req.end();
    });
    expect(plain).toBe(true);
  });

  it.skipIf(!address)('uses the same protected API and live WebSocket, and off immediately closes home clients without stopping the daemon', async () => {
    await client.putHome({ enabled: true, host: address });
    const bundle = await client.connection();
    const options = { ca: readFileSync(join(home, 'home-access', 'cert.pem')), checkServerIdentity: () => undefined };
    const ws = new WebSocket(bundle.home!.url.replace('https:', 'wss:') + '/ws', { ...options, headers: { authorization: `Bearer ${bundle.token}`, origin: bundle.home!.url } });
    const hello = new Promise<string>((resolve) => ws.once('message', (m) => resolve(String(m))));
    await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    expect(JSON.parse(await hello).kind).toBe('hello');
    const opens = (headers: Record<string, string>) => new Promise<boolean>((resolve) => {
      const other = new WebSocket(bundle.home!.url.replace('https:', 'wss:') + '/ws', { ...options, headers });
      other.on('open', () => { other.close(); resolve(true); }); other.on('error', () => resolve(false));
    });
    expect(await opens({ authorization: `Bearer ${server!.token}` })).toBe(false);
    expect(await opens({ 'tailscale-user-login': 'me@example.com' })).toBe(false);
    expect(await opens({ authorization: `Bearer ${bundle.token}`, origin: 'https://evil.example' })).toBe(false);
    // An idle TCP connection that never starts TLS must close on off as well.
    const pendingTls = connect({ host: address!, port: server!.port });
    await new Promise<void>((resolve, reject) => { pendingTls.once('connect', resolve); pendingTls.once('error', reject); });
    pendingTls.resume();
    const pendingClosed = new Promise<void>((resolve) => pendingTls.once('close', () => resolve()));
    const closed = new Promise<void>((resolve) => ws.once('close', () => resolve()));
    const status = await client.putHome({ enabled: false });
    expect(status).toMatchObject({ enabled: false, active: false, host: address });
    await closed;
    await pendingClosed;
    expect((await client.health()).ok).toBe(true);
    expect((await client.connection()).home).toBeUndefined();
    await expect(tlsGet(bundle)).rejects.toThrow();
  });

  it.skipIf(!address)('keeps pairing stable through daemon restarts while the ordinary daemon bearer rotates', async () => {
    await client.putHome({ enabled: true, host: address });
    const first = await client.connection(), firstToken = server!.token;
    await server!.close(); server = undefined;
    server = await startServer({ port: 0 });
    client = new LinaClient({ baseUrl: `http://127.0.0.1:${server.port}`, token: server.token });
    expect(server.token).not.toBe(firstToken);
    expect(await client.connection()).toEqual(first);
    expect((await tlsGet(first)).status).toBe(200);
  });

  it.skipIf(!address)('rejects insecure, mismatched, partial or malformed TLS material without replacing it', async () => {
    await client.putHome({ enabled: true, host: address });
    const first = await client.connection();
    await client.putHome({ enabled: false });
    const key = join(home, 'home-access', 'key.pem'), cert = join(home, 'home-access', 'cert.pem');
    const originalKey = readFileSync(key), originalCert = readFileSync(cert);
    chmodSync(key, 0o644);
    await expect(client.putHome({ enabled: true })).rejects.toThrow(/Unsafe permissions/);
    chmodSync(key, 0o600);
    writeFileSync(cert, 'not a certificate');
    await expect(client.putHome({ enabled: true })).rejects.toThrow();
    writeFileSync(cert, originalCert);
    writeFileSync(key, generateKeyPairSync('ec', { namedCurve: 'prime256v1', privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey);
    await expect(client.putHome({ enabled: true })).rejects.toThrow(/does not match/);
    rmSync(key);
    await expect(client.putHome({ enabled: true })).rejects.toThrow(/Incomplete/);
    writeFileSync(key, originalKey, { mode: 0o600 });
    const foreign = join(home, 'foreign-key'); writeFileSync(foreign, originalKey, { mode: 0o600 });
    rmSync(key); symlinkSync(foreign, key);
    await expect(client.putHome({ enabled: true })).rejects.toThrow(/Unsafe permissions/);
    rmSync(key); writeFileSync(key, originalKey, { mode: 0o600 });
    await client.putHome({ enabled: true });
    expect(await client.connection()).toEqual(first);
  });

  it('refuses damaged identity, unsafe permissions, and symlink substitution without rotating credentials', async () => {
    const dir = join(home, 'home-access'), identity = join(dir, 'identity.json');
    const saved = readFileSync(identity);
    chmodSync(identity, 0o644);
    expect(() => new HomeAccess(() => {}, () => 7077)).toThrow(/Unsafe permissions/);
    chmodSync(identity, 0o600); writeFileSync(identity, '{}');
    expect(() => new HomeAccess(() => {}, () => 7077)).toThrow(/Malformed/);
    writeFileSync(identity, saved); chmodSync(dir, 0o755);
    expect(() => new HomeAccess(() => {}, () => 7077)).toThrow(/Unsafe permissions/);
    chmodSync(dir, 0o700);
    rmSync(identity); symlinkSync(join(home, 'missing-identity'), identity);
    expect(() => new HomeAccess(() => {}, () => 7077)).toThrow(/Unsafe permissions/);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it.skipIf(!address)('fails closed on a damaged saved certificate while keeping localhost/Tailscale available', async () => {
    await client.putHome({ enabled: true, host: address });
    const original = await client.connection();
    await server!.close(); server = undefined;
    writeFileSync(join(home, 'home-access', 'cert.pem'), 'broken');
    server = await startServer({ port: 0 });
    client = new LinaClient({ baseUrl: `http://127.0.0.1:${server.port}`, token: server.token });
    expect(await client.home()).toMatchObject({ enabled: true, active: false, error: expect.any(String) });
    const bundle = await client.connection();
    expect(bundle.serverId).toBe(original.serverId); expect(bundle.token).toBe(original.token); expect(bundle.home).toBeUndefined();
    expect((await client.health()).ok).toBe(true);
    expect(readFileSync(join(home, 'home-access', 'cert.pem'), 'utf8')).toBe('broken');
  });
});
