import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { serviceWorkerSource } from '../../scripts/pwa.mjs';

const origin = 'http://127.0.0.1:7077';
const asset = '/assets/main-AbCd1234.js';
const source = serviceWorkerSource([asset.slice(1), 'assets/font-12345678.woff2'], 'build-one');

function worker() {
  const handlers: Record<string, (event: unknown) => void> = {};
  const cache = { addAll: vi.fn(async (_urls: string[]) => {}), match: vi.fn(async (_key: string): Promise<Response | undefined> => undefined), put: vi.fn(async (_key: string, _response: Response) => {}) };
  const caches = { open: vi.fn(async (_name: string) => cache), keys: vi.fn(async () => ['lina-shell-old', 'other-app']), delete: vi.fn(async (_key: string) => true) };
  const network = vi.fn(async (_request: Request) => new Response('network'));
  runInNewContext(source, { URL, caches, fetch: network, self: { location: { origin }, addEventListener: (name: string, handler: (event: unknown) => void) => { handlers[name] = handler; } } });
  const fetchEvent = (path: string, options?: RequestInit) => {
    let response: Promise<Response> | undefined;
    const respondWith = vi.fn((value: Promise<Response>) => { response = value; });
    handlers.fetch({ request: new Request(new URL(path, origin), options), respondWith });
    return { respondWith, response };
  };
  const lifecycle = async (name: string) => {
    let work: Promise<unknown> | undefined;
    handlers[name]({ waitUntil: (value: Promise<unknown>) => { work = value; } });
    await work;
  };
  return { cache, caches, network, fetchEvent, lifecycle };
}

describe('production service worker', () => {
  it.each(['/api', '/api/', '/api/health', '/api/projects?token=secret', '/ws', '/ws?token=secret', '/ws/nested', '/unknown',
    '/lina.apk', '/lina.apk?version=updated', '/assets/not-in-the-build.js', '/?token=secret', 'http://example.com/index.html'])('does not intercept %s', (path) => {
    const w = worker();
    expect(w.fetchEvent(path).respondWith).not.toHaveBeenCalled();
    expect(w.caches.open).not.toHaveBeenCalled();
    expect(w.network).not.toHaveBeenCalled();
  });
  it('does not intercept writes or authenticated requests, even to shell paths', () => {
    const w = worker();
    expect(w.fetchEvent('/', { method: 'POST' }).respondWith).not.toHaveBeenCalled();
    expect(w.fetchEvent(asset, { headers: { authorization: 'Bearer secret' } }).respondWith).not.toHaveBeenCalled();
    expect(w.caches.open).not.toHaveBeenCalled();
  });
  it('installs only explicit static shell files and cleans only old LINA caches', async () => {
    const w = worker();
    await w.lifecycle('install');
    const shell = w.cache.addAll.mock.calls[0][0];
    expect(shell).toContain('/index.html');
    expect(shell).toContain(asset);
    expect(shell).toContain('/manifest.webmanifest');
    expect(shell.some((url) => /^\/(api|ws)(\/|$|\?)/.test(url))).toBe(false);
    expect(shell.some((url) => url.endsWith('.apk'))).toBe(false);
    await w.lifecycle('activate');
    expect(w.caches.delete.mock.calls).toEqual([['lina-shell-old']]);
  });
  it('returns cached hashed assets before going to the network', async () => {
    const w = worker();
    w.cache.match.mockResolvedValue(new Response('cached asset'));
    expect(await (await w.fetchEvent(asset).response)!.text()).toBe('cached asset');
    expect(w.network).not.toHaveBeenCalled();
  });
  it('caches a successful asset miss', async () => {
    const w = worker();
    expect(await (await w.fetchEvent(asset).response)!.text()).toBe('network');
    expect(w.cache.put).toHaveBeenCalledWith(asset, expect.any(Response));
  });
  it.each(['/', '/index.html'])('fetches %s before its cached index and falls back when offline', async (path) => {
    const w = worker();
    w.cache.match.mockImplementation(async () => new Response('cached index'));
    expect(await (await w.fetchEvent(path).response)!.text()).toBe('network');
    expect(w.cache.put).toHaveBeenCalledWith('/index.html', expect.any(Response));
    expect(w.cache.match).not.toHaveBeenCalled();
    w.network.mockRejectedValue(Error('tunnel disconnected'));
    expect(await (await w.fetchEvent(path).response)!.text()).toBe('cached index');
  });
  it('never caches errors and versions caches when a build changes', async () => {
    const w = worker();
    w.network.mockResolvedValue(new Response('unauthorized', { status: 401 }));
    expect((await w.fetchEvent('/').response)!.status).toBe(401);
    expect(w.cache.put).not.toHaveBeenCalled();
    expect(serviceWorkerSource([asset], 'build-two')).not.toBe(source);
  });
});
