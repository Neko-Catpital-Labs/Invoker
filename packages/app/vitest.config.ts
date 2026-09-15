import path from 'node:path';
import { tmpdir } from 'node:os';
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
    env: {
      INVOKER_AUTO_FIX_PAUSE_FILE: path.join(
        tmpdir(),
        `invoker-app-vitest-auto-fix-pause-${process.pid}.json`,
      ),
      INVOKER_CODEX_SPEND_GATE_PATH: path.join(
        tmpdir(),
        `invoker-app-vitest-codex-spend-gate-${process.pid}.json`,
      ),
      INVOKER_GITHUB_TARGET_REPO: '',
      INVOKER_GITHUB_TARGET_REPOS: '',
    },
    exclude: ['e2e/**', 'node_modules/**', 'dist/**'],
    testTimeout: 60_000,
  },
}));
