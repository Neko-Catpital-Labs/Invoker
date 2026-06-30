import { defineConfig, mergeConfig } from 'vitest/config';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharedConfig from '../../vitest.shared.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default mergeConfig(sharedConfig, defineConfig({
  resolve: {
    alias: {
      '@invoker/surfaces': resolve(__dirname, '../surfaces/src/index.ts'),
    },
  },
  test: {
    exclude: ['e2e/**', 'node_modules/**', 'dist/**'],
  },
}));
