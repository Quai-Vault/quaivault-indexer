import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/e2e/suites/01-full-lifecycle.e2e.test.ts'],
    testTimeout: 600000, // 10 minutes (real timelock/expiration waits)
    hookTimeout: 600000,
    setupFiles: ['tests/e2e/setup.ts'],
    fileParallelism: false,
    disableConsoleIntercept: true, // Inline console output (no "stdout |" prefix)
    pool: 'threads',
    poolOptions: {
      threads: {
        singleThread: true, // Sequential execution to avoid nonce conflicts
      },
    },
    reporters: ['verbose'],
  },
});
