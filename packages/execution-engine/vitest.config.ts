import { defineConfig, mergeConfig } from 'vitest/config';
import sharedConfig from '../../vitest.shared.ts';

export default mergeConfig(sharedConfig, defineConfig({
  test: {
    // Restrict discovery to the real src/ tree so tests are not also picked up
    // through the packages/execution-engine/packages/execution-engine/src
    // symlink workaround (which would otherwise run every test file twice in
    // parallel and cause Date.now()-based path collisions).
    include: ['src/**/*.{test,spec}.{js,ts,jsx,tsx}'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/*.integration.test.ts',
    ],
  },
}));
