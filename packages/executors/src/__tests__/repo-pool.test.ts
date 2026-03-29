import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { RepoPool } from '../repo-pool.js';

/**
 * Creates a temp git repo with an initial commit.
 * Returns the path to the repo.
 */
function createTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'repo-pool-test-'));
  execSync('git init', { cwd: dir });
  execSync('git config user.email "test@test.com"', { cwd: dir });
  execSync('git config user.name "Test"', { cwd: dir });
  writeFileSync(join(dir, 'README.md'), '# Test Repo\n');
  execSync('git add -A && git commit -m "initial"', { cwd: dir });
  return dir;
}

describe('RepoPool', () => {
  let tmpDir: string;
  let localRepoUrl: string;
  let pool: RepoPool;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'repo-pool-cache-'));
    localRepoUrl = createTempRepo();
    pool = new RepoPool({ cacheDir: tmpDir });
  });

  afterEach(async () => {
    await pool.destroyAll();
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(localRepoUrl, { recursive: true, force: true });
  });

  it('ensureClone: clones repo on first call', async () => {
    const path = await pool.ensureClone(localRepoUrl);
    expect(path).toBeDefined();
    // Verify it's a git repo
    const result = execSync('git rev-parse --is-inside-work-tree', { cwd: path }).toString().trim();
    expect(result).toBe('true');
  });

  it('ensureClone: returns cached path on second call', async () => {
    const p1 = await pool.ensureClone(localRepoUrl);
    const p2 = await pool.ensureClone(localRepoUrl);
    expect(p1).toBe(p2);
  });

  it('acquireWorktree: creates worktree with feature branch', async () => {
    const acquired = await pool.acquireWorktree(localRepoUrl, 'experiment/v1');
    expect(acquired.worktreePath).toBeDefined();
    expect(acquired.branch).toBe('experiment/v1');
    expect(acquired.worktreePath).not.toBe(acquired.clonePath);

    // Verify the branch exists in the worktree
    const branch = execSync('git branch --show-current', { cwd: acquired.worktreePath }).toString().trim();
    expect(branch).toBe('experiment/v1');
  });

  it('acquireWorktree: respects maxWorktrees limit', async () => {
    const limitedPool = new RepoPool({ cacheDir: tmpDir, maxWorktrees: 2 });
    await limitedPool.acquireWorktree(localRepoUrl, 'branch-1');
    await limitedPool.acquireWorktree(localRepoUrl, 'branch-2');
    await expect(limitedPool.acquireWorktree(localRepoUrl, 'branch-3')).rejects.toThrow('Worktree limit reached');
    await limitedPool.destroyAll();
  });

  it('release: removes worktree and allows new acquisition', async () => {
    const limitedPool = new RepoPool({ cacheDir: tmpDir, maxWorktrees: 1 });
    const wt = await limitedPool.acquireWorktree(localRepoUrl, 'branch-1');
    await wt.release();
    // Should succeed now
    const wt2 = await limitedPool.acquireWorktree(localRepoUrl, 'branch-2');
    expect(wt2.worktreePath).toBeDefined();
    await limitedPool.destroyAll();
  });

  it('destroyAll: removes all worktrees but preserves cache', async () => {
    const clonePath = await pool.ensureClone(localRepoUrl);
    await pool.acquireWorktree(localRepoUrl, 'b1');
    await pool.acquireWorktree(localRepoUrl, 'b2');
    await pool.destroyAll();

    // Clone should still exist
    const result = execSync('git rev-parse --is-inside-work-tree', { cwd: clonePath }).toString().trim();
    expect(result).toBe('true');
  });

  it('preserves commits on re-acquire when branch has commits ahead', async () => {
    // First acquire
    const wt1 = await pool.acquireWorktree(localRepoUrl, 'experiment/preserve-test');

    // Make a commit in the worktree (simulates cherry-pick/fix)
    writeFileSync(join(wt1.worktreePath, 'fix.txt'), 'cherry-picked fix');
    execSync('git add -A && git commit -m "cherry-pick fix"', { cwd: wt1.worktreePath });

    // Release the worktree
    await wt1.release();

    // Re-acquire the same branch — the fix commit should survive
    const wt2 = await pool.acquireWorktree(localRepoUrl, 'experiment/preserve-test');
    // The fix file should be present in the worktree
    expect(execSync('cat fix.txt', { cwd: wt2.worktreePath }).toString()).toBe('cherry-picked fix');

    await wt2.release();
  });

  it('acquireWorktree: succeeds when stale path+registration left from abandoned pool (simulated restart)', async () => {
    const wt = await pool.acquireWorktree(localRepoUrl, 'stale-restart-branch');
    expect(existsSync(wt.worktreePath)).toBe(true);
    // No wt.release() — same as crash or new process with empty in-memory active set
    const pool2 = new RepoPool({ cacheDir: tmpDir });
    const wt2 = await pool2.acquireWorktree(localRepoUrl, 'stale-restart-branch');
    expect(wt2.worktreePath).toBe(wt.worktreePath);
    const branch = execSync('git branch --show-current', { cwd: wt2.worktreePath }).toString().trim();
    expect(branch).toBe('stale-restart-branch');
    await pool2.destroyAll();
  });

  it('softRelease: frees slot without removing worktree from disk', async () => {
    const limitedPool = new RepoPool({ cacheDir: tmpDir, maxWorktrees: 1 });
    const wt1 = await limitedPool.acquireWorktree(localRepoUrl, 'branch-soft');
    const worktreePath = wt1.worktreePath;

    // Soft-release frees the slot but keeps the directory
    wt1.softRelease();
    expect(existsSync(worktreePath)).toBe(true);

    // Can acquire again — slot was freed
    const wt2 = await limitedPool.acquireWorktree(localRepoUrl, 'branch-soft');
    expect(wt2.worktreePath).toBe(worktreePath); // Reused existing worktree
    await limitedPool.destroyAll();
  });

  it('softRelease then full release: both work in sequence', async () => {
    const limitedPool = new RepoPool({ cacheDir: tmpDir, maxWorktrees: 1 });
    const wt1 = await limitedPool.acquireWorktree(localRepoUrl, 'branch-both');
    const worktreePath = wt1.worktreePath;

    // Soft-release frees slot
    wt1.softRelease();

    // Full release removes from disk (and is idempotent on the slot)
    await wt1.release();
    expect(existsSync(worktreePath)).toBe(false);

    // Can acquire again after full release
    const wt2 = await limitedPool.acquireWorktree(localRepoUrl, 'branch-both');
    expect(wt2.worktreePath).toBeDefined();
    await limitedPool.destroyAll();
  });

  it('resets branch on re-acquire when no extra commits exist', async () => {
    // First acquire (no extra commits)
    const wt1 = await pool.acquireWorktree(localRepoUrl, 'experiment/clean-test');
    const head1 = execSync('git rev-parse HEAD', { cwd: wt1.worktreePath }).toString().trim();
    await wt1.release();

    // Re-acquire — should be a clean reset to HEAD
    const wt2 = await pool.acquireWorktree(localRepoUrl, 'experiment/clean-test');
    const head2 = execSync('git rev-parse HEAD', { cwd: wt2.worktreePath }).toString().trim();
    expect(head2).toBe(head1);  // Same HEAD, no extra commits

    await wt2.release();
  });
});
