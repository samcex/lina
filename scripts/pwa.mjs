import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

// Kept separate so tests exercise exactly the worker emitted by Vite.
export function serviceWorkerSource(assets, fingerprint) {
  const shell = ['/index.html', '/manifest.webmanifest', '/icons/lina.svg',
    '/icons/lina-192.png', '/icons/lina-512.png', '/icons/lina-maskable-512.png',
    ...assets.filter((name) => name.startsWith('assets/') && !name.endsWith('.map')).map((name) => `/${name}`)];
  const template = readFileSync(new URL('../web/sw.js', import.meta.url), 'utf8');
  const version = createHash('sha256').update(template).update(JSON.stringify(shell)).update(fingerprint).digest('hex').slice(0, 16);
  return template.replace("'__LINA_SHELL__'", JSON.stringify(shell))
    .replace("'__LINA_CACHE__'", JSON.stringify(`lina-shell-${version}`));
}
