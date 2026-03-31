import { execSync } from 'child_process';
import { resolve } from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

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

export default defineConfig({
  plugins: [react()],
  base: './', // relative paths for Electron
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
  },
});
