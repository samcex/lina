import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { serviceWorkerSource } from '../scripts/pwa.mjs';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const daemon = `http://127.0.0.1:${process.env.LINA_PORT || 7077}`;

// The daemon rejects foreign Host/Origin headers (DNS-rebinding protection).
// In dev the proxy rewrites both so the Vite origin (localhost:5173) is accepted.
const rewriteOrigin = {
  changeOrigin: true,
  configure(proxy: { on(ev: string, cb: (req: { setHeader(k: string, v: string): void; removeHeader?(k: string): void }) => void): void }) {
    proxy.on('proxyReq', (req) => req.setHeader('origin', daemon));
    proxy.on('proxyReqWs', (req) => req.setHeader('origin', daemon));
  },
};

export default defineConfig({
  root: here('.'),
  base: './',
  plugins: [react(), {
    name: 'lina-pwa',
    apply: 'build',
    generateBundle(_options, bundle) {
      const publicFiles = ['manifest.webmanifest', 'icons/lina.svg', 'icons/lina-192.png',
        'icons/lina-512.png', 'icons/lina-maskable-512.png'];
      const fingerprint = Object.values(bundle).map((entry) => entry.type === 'chunk' ? entry.code : entry.source).join('')
        + readFileSync(here('index.html'), 'utf8')
        + publicFiles.map((file) => readFileSync(here(`public/${file}`)).toString('base64')).join('');
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: serviceWorkerSource(Object.keys(bundle), fingerprint) });
    },
  }],
  resolve: {
    alias: { '@shared': here('../src/shared') },
  },
  build: {
    outDir: here('../dist/web'),
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 700,
  },
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      '/api': { target: daemon, ...rewriteOrigin },
      '/ws': { target: daemon, ws: true, ...rewriteOrigin },
    },
  },
  preview: { port: 4173 },
});
