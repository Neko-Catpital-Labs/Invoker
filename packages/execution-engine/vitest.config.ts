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
    env: {
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'init.defaultBranch',
      GIT_CONFIG_VALUE_0: 'master',
      GIT_CONFIG_KEY_1: 'advice.detachedHead',
      GIT_CONFIG_VALUE_1: 'false',
    },
    poolOptions: {
      forks: {
        maxForks: 1,
      },
    },
    silent: 'passed-only',
  },
}));
