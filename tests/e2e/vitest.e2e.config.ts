import { defineConfig } from 'vitest/config';
import NumericSequencer from './sequencer.js';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Explicit ordering: files run in array order (01 -> 09)
    include: [
      'tests/e2e/suites/01-factory.e2e.test.ts',
      'tests/e2e/suites/02-deposits.e2e.test.ts',
      'tests/e2e/suites/03-transactions.e2e.test.ts',
      'tests/e2e/suites/04-owners.e2e.test.ts',
      'tests/e2e/suites/05-modules.e2e.test.ts',
      'tests/e2e/suites/06-daily-limit.e2e.test.ts',
      'tests/e2e/suites/07-whitelist.e2e.test.ts',
      'tests/e2e/suites/08-zodiac.e2e.test.ts',
      'tests/e2e/suites/09-social-recovery.e2e.test.ts',
    ],
    testTimeout: 120000, // 2 minutes per test (blockchain is slow)
    hookTimeout: 60000, // 1 minute for setup/teardown
    setupFiles: ['tests/e2e/setup.ts'],
    fileParallelism: false, // Run files sequentially to preserve order
    sequence: {
      shuffle: false,
      sequencer: NumericSequencer,
    },
    pool: 'forks', // Isolate tests
    poolOptions: {
      forks: {
        singleFork: true, // Single process to avoid nonce conflicts
      },
    },
    // Output test results to JSON file for analysis
    reporters: ['verbose', 'json'],
    outputFile: {
      json: 'tests/e2e/logs/results.json',
    },
  },
});
