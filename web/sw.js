// Replaced by the production build. No API data or credentials belong in this cache.
const SHELL = '__LINA_SHELL__';
const CACHE = '__LINA_CACHE__';
const STATIC = new Set(SHELL);

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(
    keys.filter((key) => key.startsWith('lina-shell-') && key !== CACHE).map((key) => caches.delete(key)),
  )));
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  // Return without respondWith: these requests go straight to the daemon.
  if (url.origin !== self.location.origin || request.method !== 'GET'
    || url.pathname === '/api' || url.pathname.startsWith('/api/')
    || url.pathname === '/ws' || url.pathname.startsWith('/ws/')
    || request.headers.has('authorization') || url.search) return;

  const index = url.pathname === '/' || url.pathname === '/index.html';
  if (!index && !STATIC.has(url.pathname)) return;
  const key = index ? '/index.html' : url.pathname;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    if (!index) {
      const cached = await cache.match(key);
      if (cached) return cached;
    }
    try {
      const response = await fetch(request);
      if (response.ok && !response.redirected) await cache.put(key, response.clone());
      return response;
    } catch (err) {
      const cached = await cache.match(key);
      if (cached) return cached;
      throw err;
    }
  })());
});
