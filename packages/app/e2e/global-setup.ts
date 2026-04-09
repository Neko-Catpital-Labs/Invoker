/**
 * Playwright global setup: create a local bare repo for E2E tests.
 *
 * All E2E plans use file:///tmp/invoker-e2e-repo.git as their repoUrl
 * so WorktreeExecutor can clone without a network.
 */
import { execSync } from 'child_process';
import { existsSync, rmSync } from 'fs';

export const E2E_BARE_REPO = '/tmp/invoker-e2e-repo.git';

export default function globalSetup(): void {
  if (existsSync(E2E_BARE_REPO)) rmSync(E2E_BARE_REPO, { recursive: true });

  const tmpClone = '/tmp/invoker-e2e-repo-setup';
  if (existsSync(tmpClone)) rmSync(tmpClone, { recursive: true });

  execSync(`git init --bare "${E2E_BARE_REPO}"`);
  execSync(`git clone "${E2E_BARE_REPO}" "${tmpClone}"`);
  execSync('git commit --allow-empty -m "init"', { cwd: tmpClone });
  execSync('git push origin HEAD:refs/heads/master', { cwd: tmpClone });
  rmSync(tmpClone, { recursive: true });
}
