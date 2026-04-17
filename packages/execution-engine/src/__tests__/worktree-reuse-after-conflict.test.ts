/**
 * Integration test: worktree reuse by actionId after conflict resolution.
 *
 * Proves that when a task's branch hash changes (e.g. baseHead moved),
 * the pool reuses the existing worktree (renaming the branch) instead of
 * creating a fresh one — preserving merge resolution commits.
 *
 * Uses a real git sandbox (mkdtempSync + git init).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { RepoPool } from '../repo-pool.js';

function git(cwd: string, args: string): string {
  return execSync(`git ${args}`, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
}

describe('worktree reuse after conflict resolution (real git)', { timeout: 30_000 }, () => {
  let root: string;
  let pool: RepoPool;

  afterEach(async () => {
    if (pool) await pool.destroyAll();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('reuses worktree by actionId when branch hash changes, preserving resolution commit', async () => {
    root = mkdtempSync(join(tmpdir(), 'wt-reuse-conflict-'));

    // --- Setup bare remote ---
    const bare = join(root, 'bare.git');
    execSync(`git init --bare -b master ${bare}`);

    // --- Setup host clone with base commit ---
    const host = join(root, 'host');
    execSync(`git clone ${bare} ${host}`);
    git(host, 'config user.email "test@test.com"');
    git(host, 'config user.name "Test"');
    writeFileSync(join(host, 'shared.txt'), 'base content\n');
    git(host, 'add -A');
    git(host, 'commit -m "base commit"');
    git(host, 'branch -M master');
    git(host, 'push origin master');

    // --- Create upstream branch that conflicts on shared.txt ---
    git(host, 'checkout -b upstream/feature');
    writeFileSync(join(host, 'shared.txt'), 'upstream change\n');
    git(host, 'add -A');
    git(host, 'commit -m "upstream: modify shared.txt"');
    git(host, 'push origin upstream/feature');
    git(host, 'checkout master');

    const baseSha = git(host, 'rev-parse master');

    // --- Pool setup ---
    const cacheDir = join(root, 'cache');
    const worktreeBaseDir = join(root, 'worktrees');
    pool = new RepoPool({ cacheDir, maxWorktrees: 5, worktreeBaseDir });

    const actionId = 'wf-test/verify-conflict';

    // --- First acquire with hash1 ---
    const branch1 = `experiment/${actionId}-aabb1122`;
    const acquired1 = await pool.acquireWorktree(bare, branch1, baseSha, actionId);

    // Configure git user in worktree
    git(acquired1.worktreePath, 'config user.email "test@test.com"');
    git(acquired1.worktreePath, 'config user.name "Test"');

    // Make a conflicting change on the experiment branch so merge will conflict
    writeFileSync(join(acquired1.worktreePath, 'shared.txt'), 'experiment change\n');
    git(acquired1.worktreePath, 'add shared.txt');
    git(acquired1.worktreePath, 'commit -m "experiment: modify shared.txt"');

    // Simulate merge conflict + manual resolution
    // Fetch upstream so the ref is available
    git(acquired1.worktreePath, 'fetch origin upstream/feature');
    try {
      git(acquired1.worktreePath, 'merge --no-edit origin/upstream/feature');
      // If merge succeeds unexpectedly, fail the test
      expect.fail('Expected merge conflict');
    } catch (err: any) {
      if (err.message?.includes('Expected merge conflict')) throw err;
      // Expected merge conflict — resolve it
      writeFileSync(join(acquired1.worktreePath, 'shared.txt'), 'resolved content\n');
      git(acquired1.worktreePath, 'add shared.txt');
      git(acquired1.worktreePath, 'commit --no-edit -m "resolve conflict"');
    }

    // Verify resolution commit exists
    const resolveLog = git(acquired1.worktreePath, 'log --oneline -3');
    expect(resolveLog).toContain('resolve conflict');

    // Record resolution commit SHA for later assertion
    const resolutionSha = git(acquired1.worktreePath, 'rev-parse HEAD');

    // Soft-release the pool slot (simulates task completing but keeping worktree)
    acquired1.softRelease();

    // --- Re-acquire with hash2 (same actionId, different hash) ---
    const branch2 = `experiment/${actionId}-ccdd3344`;
    const acquired2 = await pool.acquireWorktree(bare, branch2, baseSha, actionId);

    // Assert: reused the same worktree path
    expect(acquired2.worktreePath).toBe(acquired1.worktreePath);

    // Assert: resolution commit is preserved
    const headAfterReuse = git(acquired2.worktreePath, 'rev-parse HEAD');
    expect(headAfterReuse).toBe(resolutionSha);

    // Assert: branch was renamed
    const currentBranch = git(acquired2.worktreePath, 'rev-parse --abbrev-ref HEAD');
    expect(currentBranch).toBe(branch2);

    // Assert: resolved content is preserved
    const resolvedContent = readFileSync(join(acquired2.worktreePath, 'shared.txt'), 'utf-8');
    expect(resolvedContent).toBe('resolved content\n');

    // Assert: upstream is already merged (merge-base --is-ancestor succeeds)
    const upstreamSha = git(acquired2.worktreePath, 'rev-parse origin/upstream/feature');
    const isAncestor = (() => {
      try {
        git(acquired2.worktreePath, `merge-base --is-ancestor ${upstreamSha} HEAD`);
        return true;
      } catch {
        return false;
      }
    })();
    expect(isAncestor).toBe(true);

    acquired2.softRelease();
  });

  it('creates a fresh worktree for recreate-style reacquire, dropping preserved conflict state', async () => {
    root = mkdtempSync(join(tmpdir(), 'wt-recreate-fresh-'));

    const bare = join(root, 'bare.git');
    execSync(`git init --bare -b master ${bare}`);

    const host = join(root, 'host');
    execSync(`git clone ${bare} ${host}`);
    git(host, 'config user.email "test@test.com"');
    git(host, 'config user.name "Test"');
    writeFileSync(join(host, 'shared.txt'), 'base content\n');
    git(host, 'add -A');
    git(host, 'commit -m "base commit"');
    git(host, 'branch -M master');
    git(host, 'push origin master');

    git(host, 'checkout -b upstream/feature');
    writeFileSync(join(host, 'shared.txt'), 'upstream change\n');
    git(host, 'add -A');
    git(host, 'commit -m "upstream: modify shared.txt"');
    git(host, 'push origin upstream/feature');
    git(host, 'checkout master');

    const baseSha = git(host, 'rev-parse master');

    const cacheDir = join(root, 'cache');
    const worktreeBaseDir = join(root, 'worktrees');
    pool = new RepoPool({ cacheDir, maxWorktrees: 5, worktreeBaseDir });

    const actionId = 'wf-test/recreate-conflict';
    const branch1 = `experiment/${actionId}-aabb1122`;
    const acquired1 = await pool.acquireWorktree(bare, branch1, baseSha, actionId);

    git(acquired1.worktreePath, 'config user.email "test@test.com"');
    git(acquired1.worktreePath, 'config user.name "Test"');

    writeFileSync(join(acquired1.worktreePath, 'shared.txt'), 'experiment change\n');
    git(acquired1.worktreePath, 'add shared.txt');
    git(acquired1.worktreePath, 'commit -m "experiment: modify shared.txt"');
    git(acquired1.worktreePath, 'fetch origin upstream/feature');
    try {
      git(acquired1.worktreePath, 'merge --no-edit origin/upstream/feature');
      expect.fail('Expected merge conflict');
    } catch (err: any) {
      if (err.message?.includes('Expected merge conflict')) throw err;
      writeFileSync(join(acquired1.worktreePath, 'shared.txt'), 'resolved content\n');
      git(acquired1.worktreePath, 'add shared.txt');
      git(acquired1.worktreePath, 'commit --no-edit -m "resolve conflict"');
    }

    const resolutionSha = git(acquired1.worktreePath, 'rev-parse HEAD');
    acquired1.softRelease();

    const branch2 = `experiment/${actionId}-ccdd3344`;
    const acquired2 = await pool.acquireWorktree(bare, branch2, baseSha, actionId, { forceFresh: true });

    expect(acquired2.worktreePath).not.toBe(acquired1.worktreePath);
    expect(git(acquired2.worktreePath, 'rev-parse HEAD')).not.toBe(resolutionSha);
    expect(git(acquired2.worktreePath, 'rev-parse --abbrev-ref HEAD')).toBe(branch2);
    expect(readFileSync(join(acquired2.worktreePath, 'shared.txt'), 'utf-8')).toBe('base content\n');

    acquired2.softRelease();
  });

  it('falls back to fresh worktree when actionId has no existing match', async () => {
    root = mkdtempSync(join(tmpdir(), 'wt-reuse-noop-'));

    const bare = join(root, 'bare.git');
    execSync(`git init --bare -b master ${bare}`);

    const host = join(root, 'host');
    execSync(`git clone ${bare} ${host}`);
    git(host, 'config user.email "test@test.com"');
    git(host, 'config user.name "Test"');
    writeFileSync(join(host, 'init.txt'), 'init');
    git(host, 'add -A');
    git(host, 'commit -m "initial"');
    git(host, 'branch -M master');
    git(host, 'push origin master');

    const baseSha = git(host, 'rev-parse master');

    const cacheDir = join(root, 'cache');
    const worktreeBaseDir = join(root, 'worktrees');
    pool = new RepoPool({ cacheDir, maxWorktrees: 5, worktreeBaseDir });

    // No prior worktree exists for this actionId — should create fresh
    const branch = 'experiment/fresh-task-11223344';
    const acquired = await pool.acquireWorktree(bare, branch, baseSha, 'fresh-task');

    const currentBranch = git(acquired.worktreePath, 'rev-parse --abbrev-ref HEAD');
    expect(currentBranch).toBe(branch);

    acquired.softRelease();
  });
});
