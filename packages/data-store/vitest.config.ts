import { defineConfig, mergeConfig } from 'vitest/config';
import sharedConfig from '../../vitest.shared.ts';

export default mergeConfig(sharedConfig, defineConfig({
  test: {
    // Long SQLite scale/recovery files can starve Vitest's fork RPC when run
    // beside each other; keep the assertions concurrent within each file only.
    fileParallelism: false,
  },
}));
