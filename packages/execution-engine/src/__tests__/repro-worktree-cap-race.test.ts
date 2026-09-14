/**
 * Repro: Racy worktree cap allows concurrent creates to exceed the limit.
 *
 * This test demonstrates a race condition in RepoPool.acquireWorktree where
 * concurrent requests can bypass the maxWorktrees limit because the check
 * (active.size >= maxWorktrees) and the reservation (active.add()) are not
 * atomic.
 *
 * Expected on master (before fix): > maxWorktrees are created simultaneously,
 * or the test observes inconsistent limit enforcement.
 *
 * Expected after fix: At most maxWorktrees worktrees exist at any time.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RepoPool, ResourceLimitError } from '../repo-pool.js';

function createTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'worktree-cap-race-'));
  execSync('git init', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' });
  writeFileSync(join(dir, 'README.md'), '# Test Repo\n');
  execSync('git add -A && git commit -m "initial"', { cwd: dir, stdio: 'pipe' });
  execSync('git branch -M master', { cwd: dir, stdio: 'pipe' });
  return dir;
}

describe('RepoPool worktree cap race condition', () => {
  let tmpDir: string;
  let worktreeBaseDir: string;
  let localRepoUrl: string;
  let pool: RepoPool;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'worktree-cap-race-cache-'));
    worktreeBaseDir = join(tmpDir, 'worktrees');
    localRepoUrl = createTempRepo();
  });

  afterEach(async () => {
    await pool?.destroyAll();
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(localRepoUrl, { recursive: true, force: true });
  });

  it('concurrent acquireWorktree respects maxWorktrees limit without softRelease', async () => {
    const MAX_WORKTREES = 6;
    const CONCURRENT_REQUESTS = 25;

    pool = new RepoPool({
      cacheDir: tmpDir,
      maxWorktrees: MAX_WORKTREES,
      worktreeBaseDir,
    });

    const results = await Promise.allSettled(
      Array.from({ length: CONCURRENT_REQUESTS }, (_, i) =>
        pool.acquireWorktree(localRepoUrl, `branch-${i}`, undefined, `session-${i}`)
      )
    );

    const succeeded = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');
    const resourceLimitErrors = failed.filter(
      (r) => r.status === 'rejected' && r.reason instanceof ResourceLimitError
    );

    expect(succeeded.length).toBeLessThanOrEqual(MAX_WORKTREES);
    expect(resourceLimitErrors.length).toBeGreaterThanOrEqual(CONCURRENT_REQUESTS - MAX_WORKTREES);
  });

  it('concurrent acquireWorktree with immediate softRelease still respects limit during acquisition', async () => {
    const MAX_WORKTREES = 6;
    const CONCURRENT_REQUESTS = 25;

    pool = new RepoPool({
      cacheDir: tmpDir,
      maxWorktrees: MAX_WORKTREES,
      worktreeBaseDir,
    });

    let maxSimultaneous = 0;
    let currentCount = 0;
    const countLock = { locked: false };

    const trackingAcquire = async (i: number) => {
      const acquired = await pool.acquireWorktree(
        localRepoUrl,
        `branch-soft-${i}`,
        undefined,
        `session-soft-${i}`
      );
      while (countLock.locked) await new Promise((r) => setTimeout(r, 1));
      countLock.locked = true;
      currentCount++;
      if (currentCount > maxSimultaneous) {
        maxSimultaneous = currentCount;
      }
      countLock.locked = false;
      acquired.softRelease();
      while (countLock.locked) await new Promise((r) => setTimeout(r, 1));
      countLock.locked = true;
      currentCount--;
      countLock.locked = false;
      return acquired;
    };

    const results = await Promise.allSettled(
      Array.from({ length: CONCURRENT_REQUESTS }, (_, i) => trackingAcquire(i))
    );

    const succeeded = results.filter((r) => r.status === 'fulfilled');

    expect(maxSimultaneous).toBeLessThanOrEqual(MAX_WORKTREES);
  });
});
