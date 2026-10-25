import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { request } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { setupEnv } from './helpers.js';
import { serviceWorkerSource } from '../../scripts/pwa.mjs';
import type { ServerHandle } from '../../src/server/daemon.js';

const home = setupEnv();
const dir = mkdtempSync(join(tmpdir(), 'lina-pwa-'));
const root = resolve(import.meta.dirname, '../..');
let server: ServerHandle;
beforeAll(async () => {
  cpSync(join(root, 'web/public'), dir, { recursive: true });
  writeFileSync(join(dir, 'index.html'), readFileSync(join(root, 'web/index.html')));
  writeFileSync(join(dir, 'sw.js'), serviceWorkerSource([], 'http-test'));
  vi.stubEnv('LINA_WEB_DIR', dir);
  const { startServer } = await import('../../src/server/daemon.js');
  server = await startServer({ port: 0 });
});
afterAll(async () => {
  await server?.close();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe('PWA static serving', () => {
  it.each([
    ['/manifest.webmanifest', 'application/manifest+json'],
    ['/sw.js', 'text/javascript; charset=utf-8'],
    ['/icons/lina.svg', 'image/svg+xml'],
    ['/icons/lina-192.png', 'image/png'],
    ['/icons/lina-512.png', 'image/png'],
    ['/icons/lina-maskable-512.png', 'image/png'],
  ])('serves %s without a token using %s', async (path, mime) => {
    const response = await fetch(`http://127.0.0.1:${server.port}${path}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(mime);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    if (path.startsWith('/icons/')) expect(response.headers.get('cache-control')).not.toContain('immutable');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(readFileSync(join(dir, path)));
    const head = await fetch(`http://127.0.0.1:${server.port}${path}`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-type')).toBe(mime);
    expect(await head.text()).toBe('');
  });
  it('uses a token-free root start URL, CSS colours and correctly sized icons', async () => {
    const manifest = await (await fetch(`http://127.0.0.1:${server.port}/manifest.webmanifest`)).json();
    expect(manifest).toMatchObject({ name: 'LINA', display: 'standalone', start_url: '/', scope: '/' });
    const tokens = readFileSync(join(root, 'web/src/styles/tokens.css'), 'utf8');
    expect(tokens).toContain(`--bg: ${manifest.background_color}`);
    expect(tokens).toContain(`--s0: ${manifest.theme_color}`);
    expect(manifest.icons.some((icon: { purpose: string }) => icon.purpose === 'maskable')).toBe(true);
    for (const icon of manifest.icons.filter((i: { type: string }) => i.type === 'image/png')) {
      const png = readFileSync(join(dir, icon.src));
      expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      expect(`${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`).toBe(icon.sizes);
    }
  });
  it('serves the current Android package at the same URL without HTTP caching', async () => {
    const path = join(dir, 'lina.apk');
    const url = `http://127.0.0.1:${server.port}/lina.apk`;
    const before = Buffer.from([0x50, 0x4b, 0x03, 0x04, 1]);
    const after = Buffer.from([0x50, 0x4b, 0x03, 0x04, 2, 3, 4]);
    for (const bytes of [before, after]) {
      writeFileSync(path, bytes);
      const response = await fetch(url);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('application/vnd.android.package-archive');
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('content-length')).toBe(String(bytes.length));
      expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    }
    const head = await fetch(url, { method: 'HEAD' });
    expect(head.headers.get('cache-control')).toBe('no-store');
    expect(head.headers.get('content-type')).toBe('application/vnd.android.package-archive');
    expect(await head.text()).toBe('');
  });
  it('revalidates the worker and leaves API routes protected', async () => {
    const base = `http://127.0.0.1:${server.port}`;
    expect((await fetch(`${base}/sw.js`)).headers.get('cache-control')).toBe('no-cache');
    for (const path of ['/api', '/api/health', '/api/settings', '/api/not-a-route']) {
      const response = await fetch(base + path);
      expect(response.status).toBe(401);
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
    expect((await fetch(`${base}/api/health`, { headers: { authorization: `Bearer ${server.token}` } })).status).toBe(200);
  });
  it('keeps Host restrictions on PWA resources, including a mismatched tunnel port', async () => {
    const status = (host: string) => new Promise<number>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: server.port, path: '/manifest.webmanifest', headers: { host } }, (res) => {
        res.resume(); resolve(res.statusCode!);
      });
      req.on('error', reject); req.end();
    });
    expect(await status(`localhost:${server.port}`)).toBe(200);
    expect(await status('evil.example:7077')).toBe(403);
    expect(await status(`127.0.0.1:${server.port + 1}`)).toBe(403);
  });
});
