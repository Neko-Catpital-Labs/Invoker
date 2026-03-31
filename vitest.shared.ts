import { execSync } from 'child_process';
import { resolve } from 'path';
import { defineConfig } from 'vitest/config';

// Temporary guard: prevent tests from running in LOCAL git worktrees (freezes the machine).
// Remote SSH targets (SSH_CONNECTION set) are allowed. Remove when resource issues are resolved.
try {
  const gitDir = execSync('git rev-parse --git-dir', { encoding: 'utf8' }).trim();
  const commonDir = execSync('git rev-parse --git-common-dir', { encoding: 'utf8' }).trim();
  const isWorktree = resolve(gitDir) !== resolve(commonDir);
  const isRemoteSsh = !!(process.env.SSH_CONNECTION || process.env.SSH_CLIENT);
  if (isWorktree && !isRemoteSsh) {
    console.error('\n\u274c Tests are disabled in local git worktrees (temporary guard).\n');
    process.exit(1);
  }
} catch {
  // Not a git repo — allow tests to proceed.
}

const maxWorkers = process.env.INVOKER_VITEST_MAX_WORKERS
  ?? (process.env.INVOKER_VITEST_HIGH_RESOURCE === '1' ? undefined : 2);

export default defineConfig({
  test: {
    globals: true,
    // App plan-parser tests call git ls-remote (execSync timeout 10s); Vitest default 5s flakes.
    testTimeout: 20_000,
    pool: 'forks',
    poolOptions: {
      forks: {
        ...(maxWorkers ? { maxForks: Number(maxWorkers) || maxWorkers } : {}),
        maxMemoryLimitBeforeRecycle: 512 * 1024 * 1024, // 512MB — restart fork to shed leaked memory
      },
    },
  },
});
