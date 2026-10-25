// Bundles the daemon + CLI into dist/lina.js. Dependencies stay external (resolved from node_modules).
import { build } from 'esbuild';
await build({
  entryPoints: ['src/cli/main.tsx'],
  outfile: 'dist/lina.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
  jsx: 'automatic',
  sourcemap: 'linked',
  banner: { js: "import { createRequire as __lina_cr } from 'node:module'; const require = __lina_cr(import.meta.url);" },
  logLevel: 'warning',
});
console.log('built dist/lina.js');
