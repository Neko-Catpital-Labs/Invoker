import { defineConfig } from 'vitest/config';

const maxWorkers = process.env.INVOKER_VITEST_MAX_WORKERS
  ?? (process.env.INVOKER_VITEST_HIGH_RESOURCE === '1' ? undefined : '50%');

export default defineConfig({
  test: {
    globals: true,
    pool: 'forks',
    poolOptions: {
      forks: {
        ...(maxWorkers ? { maxForks: Number(maxWorkers) || maxWorkers } : {}),
      },
    },
  },
});
