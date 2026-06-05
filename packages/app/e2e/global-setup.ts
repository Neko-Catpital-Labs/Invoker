/**
 * Playwright global setup: create a local bare repo for E2E tests.
 *
 * By default, all E2E plans use file:///tmp/invoker-e2e-repo.git as their repoUrl
 * so WorktreeExecutor can clone without a network. Sharded CI can override the
 * bare-repo path via INVOKER_E2E_BARE_REPO to avoid cross-shard interference.
 */
import { execSync, spawn, type ChildProcess } from 'child_process';
import { existsSync, rmSync } from 'fs';
import * as path from 'path';
import { resolveRepoRoot } from '@invoker/contracts';

export const E2E_BARE_REPO = process.env.INVOKER_E2E_BARE_REPO ?? '/tmp/invoker-e2e-repo.git';

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME ?? 'Invoker E2E',
  GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL ?? 'ci@invoker.dev',
  GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? 'Invoker E2E',
  GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? 'ci@invoker.dev',
};

const repoRoot = resolveRepoRoot(__dirname);

function startXvfbIfNeeded(): ChildProcess | null {
  if (process.platform !== 'linux' || process.env.DISPLAY) {
    return null;
  }

  try {
    execSync('command -v Xvfb', { stdio: 'ignore' });
  } catch {
    return null;
  }

  for (let display = 90; display < 110; display += 1) {
    const child = spawn('Xvfb', [`:${display}`, '-screen', '0', '1280x720x24', '-nolisten', 'tcp'], {
      detached: false,
      stdio: 'ignore',
    });
    const lockPath = `/tmp/.X${display}-lock`;
    const started = Date.now();
    while (Date.now() - started < 1000) {
      if (child.exitCode !== null) {
        break;
      }
      if (existsSync(lockPath)) {
        process.env.DISPLAY = `:${display}`;
        child.unref();
        return child;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
    child.kill();
  }

  return null;
}

export default function globalSetup(): void {
  const xvfb = startXvfbIfNeeded();
  if (xvfb) {
    process.once('exit', () => {
      xvfb.kill();
    });
  }

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
  execSync('git push origin HEAD:refs/heads/main', { cwd: tmpClone, env: gitEnv });
  rmSync(tmpClone, { recursive: true });
}
