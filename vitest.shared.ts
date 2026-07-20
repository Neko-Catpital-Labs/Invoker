import { defineConfig } from 'vitest/config';
import MergifyReporter from '@mergifyio/vitest';

const maxWorkers = process.env.INVOKER_VITEST_MAX_WORKERS
  ?? (process.env.INVOKER_VITEST_HIGH_RESOURCE === '1' ? undefined : 2);

export default defineConfig({
  test: {
    env: {
      INVOKER_TEST_WORKFLOW_IDS: '1',
    },
    exclude: ['**/node_modules/**', '**/dist/**'],
    globals: true,
    // App plan-parser tests call git ls-remote (execSync timeout 10s); Vitest default 5s flakes.
    testTimeout: 20_000,
    pool: 'forks',
    poolOptions: {
      forks: {
        ...(maxWorkers ? { maxForks: Number(maxWorkers) || maxWorkers } : {}),
        maxMemoryLimitBeforeRecycle: 512 * 1024 * 1024, // 512MB — restart fork to shed leaked memory
      },
    },
    reporters: ['default', new MergifyReporter()],
  },
});
