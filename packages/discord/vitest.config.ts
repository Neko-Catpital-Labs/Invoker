import { defineConfig, mergeConfig } from 'vitest/config';
import sharedConfig from '../../vitest.shared.ts';

export default mergeConfig(sharedConfig, defineConfig({
  resolve: {
    alias: {
      '@invoker/surfaces': new URL('../surfaces/src/index.ts', import.meta.url).pathname,
    },
  },
  test: {},
}));
