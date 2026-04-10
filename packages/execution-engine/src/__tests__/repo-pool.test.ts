import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { RepoPool, ResourceLimitError } from '../repo-pool.js';
import { remoteFetchForPool } from '../remote-fetch-policy.js';

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
  execSync('git branch -M master', { cwd: dir });
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
    remoteFetchForPool.enabled = true;
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
    // Verify the thrown error is a ResourceLimitError
    try {
      await limitedPool.acquireWorktree(localRepoUrl, 'branch-3');
    } catch (err) {
      expect(err).toBeInstanceOf(ResourceLimitError);
      expect((err as ResourceLimitError).name).toBe('ResourceLimitError');
    }
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

  describe('fetch resilience (concurrent ref-lock race)', () => {
    afterEach(() => { vi.restoreAllMocks(); });

    function spyFetchToFail(target: RepoPool) {
      const orig = (target as any).execGit.bind(target);
      vi.spyOn(target as any, 'execGit').mockImplementation(
        (...params: unknown[]) => {
          const args = params[0] as string[];
          const cwd = params[1] as string;
          if (args[0] === 'fetch' && args.includes('--all')) {
            return Promise.reject(new Error('cannot lock ref: is at X but expected Y'));
          }
          return orig(args, cwd);
        },
      );
    }

    it('ensureClone succeeds when fetch --all fails', async () => {
      await pool.ensureClone(localRepoUrl);
      spyFetchToFail(pool);

      const path = await pool.ensureClone(localRepoUrl);
      expect(path).toBeDefined();
      expect(existsSync(path)).toBe(true);
    });

    it('refreshMirrorForRebase succeeds when fetch --all fails', async () => {
      await pool.ensureClone(localRepoUrl);
      spyFetchToFail(pool);

      const dir = await pool.refreshMirrorForRebase(localRepoUrl, 'master');
      expect(dir).toBeDefined();
      expect(existsSync(dir)).toBe(true);
    });

    it('concurrent fetches from separate pools sharing cacheDir both succeed', async () => {
      // Setup: bare repo so multiple clones can fetch concurrently
      const bareDir = mkdtempSync(join(tmpdir(), 'repo-pool-bare-'));
      const sourceDir = mkdtempSync(join(tmpdir(), 'repo-pool-src-'));
      try {
        execSync('git init --bare -b master', { cwd: bareDir });
        execSync(`git clone ${bareDir} .`, { cwd: sourceDir });
        execSync('git config user.email "t@t.com" && git config user.name "T"', { cwd: sourceDir });
        execSync('git commit --allow-empty -m "init"', { cwd: sourceDir });
        execSync('git branch -M master', { cwd: sourceDir });
        execSync('git push -u origin master', { cwd: sourceDir });
        for (let i = 0; i < 15; i++) {
          execSync(`git checkout -b experiment/b-${i} master`, { cwd: sourceDir });
          execSync(`git commit --allow-empty -m "b${i}" && git push origin experiment/b-${i}`, { cwd: sourceDir });
        }
        execSync('git checkout master', { cwd: sourceDir });

        // Initial clone via pool
        await pool.ensureClone(bareDir);

        // Force-push all branches to create stale tracking refs
        for (let i = 0; i < 15; i++) {
          execSync(`git checkout experiment/b-${i}`, { cwd: sourceDir });
          execSync(`git commit --allow-empty -m "rewrite ${i}" && git push --force origin experiment/b-${i}`, { cwd: sourceDir });
        }

        // Two separate pools share cacheDir — their fetches race on the same .git dir
        const pool2 = new RepoPool({ cacheDir: tmpDir });
        const pool3 = new RepoPool({ cacheDir: tmpDir });

        const [r1, r2] = await Promise.all([
          pool2.ensureClone(bareDir),
          pool3.ensureClone(bareDir),
        ]);

        expect(r1).toBe(r2);
        const sha = execSync('git rev-parse origin/master', { cwd: r1 }).toString().trim();
        expect(sha).toBeTruthy();

        await pool2.destroyAll();
        await pool3.destroyAll();
      } finally {
        rmSync(bareDir, { recursive: true, force: true });
        rmSync(sourceDir, { recursive: true, force: true });
      }
    });
  });

  it('ensureClone skips network refresh when remoteFetchForPool.enabled is false', async () => {
    await pool.ensureClone(localRepoUrl);
    const clonePath = pool.getClonePath(localRepoUrl);
    const shaBefore = execSync('git rev-parse origin/master', { cwd: clonePath }).toString().trim();

    writeFileSync(join(localRepoUrl, 'extra.md'), 'more');
    execSync('git add -A && git commit -m "upstream advance"', { cwd: localRepoUrl });

    remoteFetchForPool.enabled = false;
    await pool.ensureClone(localRepoUrl);
    const shaSkipped = execSync('git rev-parse origin/master', { cwd: clonePath }).toString().trim();
    expect(shaSkipped).toBe(shaBefore);

    remoteFetchForPool.enabled = true;
    await pool.ensureClone(localRepoUrl);
    const shaFresh = execSync('git rev-parse origin/master', { cwd: clonePath }).toString().trim();
    expect(shaFresh).not.toBe(shaBefore);
  });
});
