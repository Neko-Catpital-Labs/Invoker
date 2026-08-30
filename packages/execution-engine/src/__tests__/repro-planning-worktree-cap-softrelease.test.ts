/**
 * Repro: Planning worktrees exceed maxWorktrees cap after softRelease
 *
 * Symptom: 25 parallel planning-chat-create with maxWorktrees=6 produced:
 * - 9 unique sessions created (not 6)
 * - 16+ invoker/planning worktrees on disk (not capped at 6)
 *
 * Root cause: softRelease() drops the in-memory held count without removing
 * the worktree from disk, so later creates see <maxWorktrees and keep minting
 * new directories/sessions.
 *
 * Fix applied:
 * - RepoPool now counts on-disk planning worktrees when enforcing maxWorktrees
 * - For branches starting with invoker/planning/, the limit is checked against
 *   the git worktree list, not just in-memory activeWorktrees
 * - Tests now pass because on-disk count stays <= maxWorktrees
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RepoPool, ResourceLimitError } from '../repo-pool.js';
import { parseGitWorktreePorcelain } from '../worktree-discovery.js';

function createTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'planning-worktree-cap-'));
  execSync('git init', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' });
  writeFileSync(join(dir, 'README.md'), '# Test Repo\n');
  execSync('git add -A && git commit -m "initial"', { cwd: dir, stdio: 'pipe' });
  execSync('git branch -M master', { cwd: dir, stdio: 'pipe' });
  return dir;
}

function countPlanningWorktrees(clonePath: string): number {
  try {
    const porcelain = execSync('git worktree list --porcelain', {
      cwd: clonePath,
      encoding: 'utf8',
    });
    const entries = parseGitWorktreePorcelain(porcelain);
    return entries.filter((e) => e.branch?.startsWith('invoker/planning/')).length;
  } catch {
    return 0;
  }
}

function resolvePlanningWorktreeBranch(sessionId: string): string {
  return `invoker/planning/${sessionId}`;
}

describe('planning worktree cap with softRelease', () => {
  let tmpDir: string;
  let worktreeBaseDir: string;
  let localRepoUrl: string;
  let pool: RepoPool;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'planning-worktree-cap-cache-'));
    worktreeBaseDir = join(tmpDir, 'worktrees');
    localRepoUrl = createTempRepo();
  });

  afterEach(async () => {
    await pool?.destroyAll();
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(localRepoUrl, { recursive: true, force: true });
  });

  it('sequential acquire+softRelease should not exceed maxWorktrees on disk', async () => {
    const MAX_WORKTREES = 6;
    const SESSIONS_TO_CREATE = 15;

    pool = new RepoPool({
      cacheDir: tmpDir,
      maxWorktrees: MAX_WORKTREES,
      worktreeBaseDir,
    });

    const clonePath = await pool.ensureCloneThroughRepoQueue(localRepoUrl);
    let succeeded = 0;
    let rejected = 0;

    for (let i = 0; i < SESSIONS_TO_CREATE; i++) {
      const sessionId = `session-${i}`;
      const branch = resolvePlanningWorktreeBranch(sessionId);
      try {
        const acquired = await pool.acquireWorktree(localRepoUrl, branch, undefined, sessionId);
        acquired.softRelease();
        succeeded++;
      } catch (err) {
        if (err instanceof ResourceLimitError) {
          rejected++;
        } else {
          throw err;
        }
      }
    }

    const onDiskCount = countPlanningWorktrees(clonePath);

    expect(onDiskCount).toBeLessThanOrEqual(MAX_WORKTREES);
    expect(succeeded).toBe(MAX_WORKTREES);
    expect(rejected).toBe(SESSIONS_TO_CREATE - MAX_WORKTREES);
  });

  it('concurrent acquire+softRelease should not exceed maxWorktrees on disk', async () => {
    const MAX_WORKTREES = 6;
    const CONCURRENT_SESSIONS = 25;

    pool = new RepoPool({
      cacheDir: tmpDir,
      maxWorktrees: MAX_WORKTREES,
      worktreeBaseDir,
    });

    const clonePath = await pool.ensureCloneThroughRepoQueue(localRepoUrl);

    const acquireAndSoftRelease = async (i: number) => {
      const sessionId = `concurrent-session-${i}`;
      const branch = resolvePlanningWorktreeBranch(sessionId);
      const acquired = await pool.acquireWorktree(localRepoUrl, branch, undefined, sessionId);
      acquired.softRelease();
      return acquired;
    };

    const results = await Promise.allSettled(
      Array.from({ length: CONCURRENT_SESSIONS }, (_, i) => acquireAndSoftRelease(i))
    );

    const succeeded = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter(
      (r) => r.status === 'rejected' && r.reason instanceof ResourceLimitError
    );
    const onDiskCount = countPlanningWorktrees(clonePath);

    expect(onDiskCount).toBeLessThanOrEqual(MAX_WORKTREES);
    expect(succeeded.length).toBeLessThanOrEqual(MAX_WORKTREES);
    expect(rejected.length).toBeGreaterThanOrEqual(CONCURRENT_SESSIONS - MAX_WORKTREES);
  });

  it('live planning worktree count should not exceed maxWorktrees', async () => {
    const MAX_WORKTREES = 6;
    const SESSIONS_TO_CREATE = 20;

    pool = new RepoPool({
      cacheDir: tmpDir,
      maxWorktrees: MAX_WORKTREES,
      worktreeBaseDir,
    });

    const clonePath = await pool.ensureCloneThroughRepoQueue(localRepoUrl);
    let maxOnDiskObserved = 0;

    for (let i = 0; i < SESSIONS_TO_CREATE; i++) {
      const sessionId = `tracked-session-${i}`;
      const branch = resolvePlanningWorktreeBranch(sessionId);
      try {
        const acquired = await pool.acquireWorktree(localRepoUrl, branch, undefined, sessionId);
        acquired.softRelease();
      } catch (err) {
        if (!(err instanceof ResourceLimitError)) {
          throw err;
        }
      }

      const currentOnDisk = countPlanningWorktrees(clonePath);
      if (currentOnDisk > maxOnDiskObserved) {
        maxOnDiskObserved = currentOnDisk;
      }
    }

    expect(maxOnDiskObserved).toBeLessThanOrEqual(MAX_WORKTREES);
  });
});
