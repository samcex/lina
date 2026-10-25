import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    environment: 'node',
    testTimeout: 30_000,
    pool: 'forks',
    // node:sqlite prints an ExperimentalWarning; silence it in workers
    execArgv: ['--disable-warning=ExperimentalWarning'],
  },
});
