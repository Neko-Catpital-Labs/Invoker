import { spawnSync } from 'node:child_process';

// Portable regression lever: uses only disposable repositories and harmless commands.
const result = spawnSync('pnpm', [
  '--filter', '@invoker/execution-engine', 'test', '--',
  'task-runner.test.ts', 'worktree-executor.test.ts', 'repo-pool.test.ts',
  '-t', 'startup cancellation', '--reporter=verbose',
], { stdio: 'inherit', shell: process.platform === 'win32' });
if (result.error) console.error(result.error);
console.log(`worktree-startup-cancellation exit code: ${result.status ?? 1}`);
process.exit(result.status ?? 1);
