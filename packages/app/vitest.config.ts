import { defineConfig, mergeConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import sharedConfig from '../../vitest.shared.ts';

export default mergeConfig(sharedConfig, defineConfig({
  resolve: {
    alias: {
      '@invoker/surfaces': fileURLToPath(new URL('../surfaces/src/index.ts', import.meta.url)),
    },
  },
  test: {
    exclude: ['e2e/**', 'node_modules/**', 'dist/**'],
  },
}));
