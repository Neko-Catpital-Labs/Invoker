import { defineConfig, mergeConfig } from 'vitest/config';
import sharedConfig from '../../vitest.shared.ts';

export default mergeConfig(sharedConfig, defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/dist/**'],
    // cli.test.ts runs heavy e2e (real engine, git, IPC). Run files sequentially and give the
    // ~18s workflow runs ample headroom so a busy machine doesn't brush the global 20s timeout.
    fileParallelism: false,
    testTimeout: 60_000,
  },
}));
