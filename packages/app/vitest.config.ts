import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, mergeConfig } from 'vitest/config';
import sharedConfig from '../../vitest.shared.ts';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default mergeConfig(sharedConfig, defineConfig({
  resolve: {
    alias: {
      '@invoker/surfaces': path.resolve(rootDir, '../surfaces/src/index.ts'),
    },
  },
  test: {
    exclude: ['e2e/**', 'node_modules/**', 'dist/**'],
  },
}));
