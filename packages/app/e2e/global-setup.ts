/**
 * Playwright global setup: create a local bare repo for E2E tests.
 *
 * By default, all E2E plans use file:///tmp/invoker-e2e-repo.git as their repoUrl
 * so WorktreeExecutor can clone without a network. Sharded CI can override the
 * bare-repo path via INVOKER_E2E_BARE_REPO to avoid cross-shard interference.
 */
import { execSync } from 'child_process';
import { existsSync, rmSync } from 'fs';
import * as path from 'path';

export const E2E_BARE_REPO = process.env.INVOKER_E2E_BARE_REPO ?? '/tmp/invoker-e2e-repo.git';

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME ?? 'Invoker E2E',
  GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL ?? 'ci@invoker.dev',
  GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? 'Invoker E2E',
  GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? 'ci@invoker.dev',
};

const repoRoot = path.resolve(__dirname, '..', '..', '..');

export default function globalSetup(): void {
  // Build dependent packages and the app itself if artifacts are missing.
  if (!existsSync(path.join(repoRoot, 'packages', 'ui', 'dist', 'index.html'))) {
    execSync('pnpm --filter @invoker/ui build', { cwd: repoRoot, stdio: 'inherit' });
  }
  if (!existsSync(path.join(repoRoot, 'packages', 'surfaces', 'dist', 'index.js'))) {
    execSync('pnpm --filter @invoker/surfaces build', { cwd: repoRoot, stdio: 'inherit' });
  }
  if (!existsSync(path.join(repoRoot, 'packages', 'app', 'dist', 'main.js'))) {
    execSync('pnpm run build', { cwd: path.join(repoRoot, 'packages', 'app'), stdio: 'inherit' });
  }

  if (existsSync(E2E_BARE_REPO)) rmSync(E2E_BARE_REPO, { recursive: true });

  const tmpClone = `${E2E_BARE_REPO}.setup`;
  if (existsSync(tmpClone)) rmSync(tmpClone, { recursive: true });

  execSync(`git init --bare "${E2E_BARE_REPO}"`);
  execSync(`git clone "${E2E_BARE_REPO}" "${tmpClone}"`, { env: gitEnv });
  execSync('git commit --allow-empty -m "init"', { cwd: tmpClone, env: gitEnv });
  execSync('git push origin HEAD:refs/heads/master', { cwd: tmpClone, env: gitEnv });
  rmSync(tmpClone, { recursive: true });
}
