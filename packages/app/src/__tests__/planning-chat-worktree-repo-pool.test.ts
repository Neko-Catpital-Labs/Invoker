import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { RepoPool } from '@invoker/execution-engine';
import {
  ensurePlanningWorktreeReady,
  provisionPlanningWorktree,
  resolvePlanningWorktreeBranch,
} from '../planning-chat-worktree.js';

function createTempRemoteRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'planning-worktree-remote-'));
  execSync('git init', { cwd: dir });
  execSync('git config user.email "test@test.com"', { cwd: dir });
  execSync('git config user.name "Test"', { cwd: dir });
  writeFileSync(join(dir, 'README.md'), '# Planning worktree test repo\n');
  execSync('git add -A && git commit -m "initial"', { cwd: dir });
  execSync('git branch -M main', { cwd: dir });
  return realpathSync(dir);
}

describe('planning-chat-worktree against a real RepoPool', () => {
  let cacheDir: string;
  let worktreeBaseDir: string;
  let remoteRepoUrl: string;
  let pool: RepoPool;

  beforeEach(() => {
    cacheDir = realpathSync(mkdtempSync(join(tmpdir(), 'planning-worktree-cache-')));
    worktreeBaseDir = realpathSync(mkdtempSync(join(tmpdir(), 'planning-worktree-base-')));
    remoteRepoUrl = createTempRemoteRepo();
    pool = new RepoPool({ cacheDir, worktreeBaseDir });
  });

  afterEach(async () => {
    await pool.destroyAll();
    rmSync(cacheDir, { recursive: true, force: true });
    rmSync(worktreeBaseDir, { recursive: true, force: true });
    rmSync(remoteRepoUrl, { recursive: true, force: true });
  });

  it('provisions a real worktree at the resolved HEAD commit, then recreates it after a disk-headroom-style wipe of both the clone cache and the worktree dir', async () => {
    const sessionId = 'integration-session-1';
    const branch = resolvePlanningWorktreeBranch(sessionId);

    const provisioned = await provisionPlanningWorktree(pool, {
      repoUrl: remoteRepoUrl,
      baseBranch: 'main',
      sessionId,
    });

    expect(provisioned.branch).toBe(branch);
    expect(existsSync(provisioned.worktreePath)).toBe(true);
    const headAfterProvision = execSync('git rev-parse HEAD', { cwd: provisioned.worktreePath }).toString().trim();
    expect(headAfterProvision).toBe(provisioned.baseCommit);
    const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: provisioned.worktreePath }).toString().trim();
    expect(currentBranch).toBe(branch);

    const expectedPath = pool.externalWorktreePath(remoteRepoUrl, branch);
    expect(realpathSync(provisioned.worktreePath)).toBe(realpathSync(expectedPath));

    // Mirrors disk-headroom-reclaim.ts, which wholesale-wipes both the "repos"
    // clone-cache dir and the "worktrees" dir together under disk pressure.
    rmSync(pool.getClonePath(remoteRepoUrl), { recursive: true, force: true });
    rmSync(provisioned.worktreePath, { recursive: true, force: true });
    expect(existsSync(provisioned.worktreePath)).toBe(false);

    const readyAfterWipe = await ensurePlanningWorktreeReady(pool, {
      repoUrl: remoteRepoUrl,
      baseCommit: provisioned.baseCommit,
      sessionId,
    });
    expect(readyAfterWipe.recreated).toBe(true);
    expect(realpathSync(readyAfterWipe.worktreePath)).toBe(realpathSync(expectedPath));
    expect(existsSync(readyAfterWipe.worktreePath)).toBe(true);
    const headAfterRecreate = execSync('git rev-parse HEAD', { cwd: readyAfterWipe.worktreePath }).toString().trim();
    expect(headAfterRecreate).toBe(provisioned.baseCommit);
    const branchAfterRecreate = execSync('git rev-parse --abbrev-ref HEAD', { cwd: readyAfterWipe.worktreePath }).toString().trim();
    expect(branchAfterRecreate).toBe(branch);

    const readyWhenPresent = await ensurePlanningWorktreeReady(pool, {
      repoUrl: remoteRepoUrl,
      baseCommit: provisioned.baseCommit,
      sessionId,
    });
    expect(readyWhenPresent.recreated).toBe(false);
    expect(realpathSync(readyWhenPresent.worktreePath)).toBe(realpathSync(expectedPath));
  }, 30_000);

  it('recreates at the original stored commit even if the remote branch has since advanced', async () => {
    const sessionId = 'integration-session-2';
    const branch = resolvePlanningWorktreeBranch(sessionId);

    const provisioned = await provisionPlanningWorktree(pool, {
      repoUrl: remoteRepoUrl,
      baseBranch: 'main',
      sessionId,
    });
    const originalCommit = provisioned.baseCommit;

    writeFileSync(join(remoteRepoUrl, 'CHANGED.md'), 'advanced\n');
    execSync('git add -A && git commit -m "advance main"', { cwd: remoteRepoUrl });
    const advancedCommit = execSync('git rev-parse HEAD', { cwd: remoteRepoUrl }).toString().trim();
    expect(advancedCommit).not.toBe(originalCommit);

    rmSync(pool.getClonePath(remoteRepoUrl), { recursive: true, force: true });
    rmSync(provisioned.worktreePath, { recursive: true, force: true });

    const ready = await ensurePlanningWorktreeReady(pool, {
      repoUrl: remoteRepoUrl,
      baseCommit: originalCommit,
      sessionId,
    });
    expect(ready.recreated).toBe(true);
    const headAfterRecreate = execSync('git rev-parse HEAD', { cwd: ready.worktreePath }).toString().trim();
    expect(headAfterRecreate).toBe(originalCommit);
    expect(headAfterRecreate).not.toBe(advancedCommit);
    const branchName = execSync('git rev-parse --abbrev-ref HEAD', { cwd: ready.worktreePath }).toString().trim();
    expect(branchName).toBe(branch);
  }, 30_000);
});
