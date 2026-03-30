import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { RepoPool } from '../repo-pool.js';
import { cleanupManagedWorktrees } from '../managed-worktree-cleanup.js';

function createTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cleanup-test-repo-'));
  execSync('git init', { cwd: dir });
  execSync('git config user.email "t@test.com"', { cwd: dir });
  execSync('git config user.name "T"', { cwd: dir });
  execSync('bash -c "echo a > f && git add f && git commit -m init"', { cwd: dir });
  return dir;
}

describe('cleanupManagedWorktrees', () => {
  let tmpRoot: string;
  let repoUrl: string;

  afterEach(() => {
    if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
    if (repoUrl) rmSync(repoUrl, { recursive: true, force: true });
  });

  it('removes external-layout worktrees via git worktree remove', async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'cleanup-mw-'));
    repoUrl = createTempRepo();
    const cacheDir = join(tmpRoot, 'repos');
    const worktreeBaseDir = join(tmpRoot, 'worktrees');
    const pool = new RepoPool({ cacheDir, worktreeBaseDir });
    const wt = await pool.acquireWorktree(repoUrl, 'experiment/cleanup-smoke');
    expect(existsSync(wt.worktreePath)).toBe(true);
    await pool.destroyAll();

    const { removed, errors } = await cleanupManagedWorktrees({ cacheDir, worktreeBaseDir });
    expect(removed).toContain(wt.worktreePath);
    expect(errors.length).toBe(0);
    expect(existsSync(wt.worktreePath)).toBe(false);
  });
});
