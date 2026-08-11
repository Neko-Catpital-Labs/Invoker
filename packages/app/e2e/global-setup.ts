/**
 * Playwright global setup: create a local bare repo for E2E tests.
 *
 * By default, all E2E plans use file:///tmp/invoker-e2e-repo.git as their repoUrl
 * so WorktreeExecutor can clone without a network. Sharded CI can override the
 * bare-repo path via INVOKER_E2E_BARE_REPO to avoid cross-shard interference.
 */
import { execSync, spawn } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
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

function resolveXvfbPath(): string | null {
  try {
    return execSync('command -v Xvfb', { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

async function startXvfbIfNeeded(): Promise<void> {
  if (process.platform !== 'linux' || process.env.DISPLAY) return;

  const xvfbPath = resolveXvfbPath();
  if (!xvfbPath) {
    console.warn('[e2e global setup] DISPLAY is unset and Xvfb was not found; Electron UI tests may fail to launch.');
    return;
  }

  const displayBase = 90 + (process.pid % 1000);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const displayNumber = displayBase + attempt;
    const display = `:${displayNumber}`;
    const socketPath = `/tmp/.X11-unix/X${displayNumber}`;
    if (existsSync(socketPath)) continue;

    const child = spawn(xvfbPath, [display, '-screen', '0', '1280x720x24', '-nolisten', 'tcp'], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();

    let exited = false;
    child.once('exit', () => {
      exited = true;
    });

    for (let poll = 0; poll < 50; poll += 1) {
      if (existsSync(socketPath) && !exited) {
        process.env.DISPLAY = display;
        const statePath = process.env.INVOKER_E2E_XVFB_STATE;
        if (statePath) {
          writeFileSync(statePath, JSON.stringify({ pid: child.pid, display }), 'utf8');
        }
        return;
      }
      if (exited) break;
      await delay(50);
    }

    if (!exited && child.pid) {
      try {
        process.kill(child.pid, 'SIGTERM');
      } catch {
        // Best effort; the next display attempt is the useful fallback.
      }
    }
  }

  throw new Error('Could not start Xvfb for Electron UI tests while DISPLAY is unset.');
}

export default async function globalSetup(): Promise<void> {
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

  await startXvfbIfNeeded();
}
