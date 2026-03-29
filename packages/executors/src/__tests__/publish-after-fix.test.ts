import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync, execFileSync } from 'node:child_process';
import type { TaskState } from '@invoker/core';
import { publishAfterFixImpl, type MergeExecutorHost } from '../merge-executor.js';

/** Shell-based git for simple setup commands (no special chars in args). */
function git(args: string, cwd: string): string {
  return execSync(`git ${args}`, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

/** Array-based git (avoids shell word-splitting — safe for merge messages with special chars). */
function gitExec(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function gitSilent(args: string, cwd: string): string {
  try { return git(args, cwd); } catch { return ''; }
}

/**
 * Build a three-repo sandbox:
 *   origin  — bare repo (simulates GitHub remote)
 *   hostDir — clone of origin (simulates host.cwd / the user's repo)
 *   gateDir — clone of origin (simulates the gate clone created by createMergeWorktree)
 *
 * Initial state:
 *   master has one commit ("initial")
 *   task branch "invoker/t1" with a unique file, pushed to origin
 *   gateDir has an extra commit on master (simulates Claude's fix)
 */
function createSandbox() {
  const root = mkdtempSync(join(tmpdir(), 'pub-fix-'));
  const originDir = join(root, 'origin.git');
  const hostDir = join(root, 'host');
  const gateDir = join(root, 'gate');

  // Bare origin
  execSync(`git init --bare -b master "${originDir}"`, { stdio: 'pipe' });

  // Host clone
  execSync(`git clone "${originDir}" "${hostDir}"`, { stdio: 'pipe' });
  git('config user.email "test@test.com"', hostDir);
  git('config user.name "Test"', hostDir);
  writeFileSync(join(hostDir, 'initial.txt'), 'initial');
  git('add -A', hostDir);
  git('commit -m "initial"', hostDir);
  git('push origin master', hostDir);

  // Task branch with a commit
  git('checkout -b invoker/t1', hostDir);
  writeFileSync(join(hostDir, 't1.txt'), 'task 1 work');
  git('add -A', hostDir);
  git('commit -m "task 1"', hostDir);
  git('push origin invoker/t1', hostDir);
  git('checkout master', hostDir);

  // Gate clone (simulates createMergeWorktree — a separate clone from origin)
  execSync(`git clone "${originDir}" "${gateDir}"`, { stdio: 'pipe' });
  git('config user.email "test@test.com"', gateDir);
  git('config user.name "Test"', gateDir);

  // Claude's fix: an extra commit on gate's master
  writeFileSync(join(gateDir, 'fix.txt'), 'claude fix');
  git('add -A', gateDir);
  git('commit -m "claude fix"', gateDir);

  return { root, originDir, hostDir, gateDir };
}

function makeHost(hostDir: string, gateDir: string, allTasks: TaskState[]): MergeExecutorHost {
  return {
    cwd: hostDir,
    defaultBranch: 'master',
    persistence: {
      loadWorkflow: () => ({
        id: 'wf-int',
        onFinish: 'none',
        mergeMode: 'manual',
        baseBranch: 'master',
        featureBranch: 'plan/feature',
        name: 'Integration Test',
      }),
      updateTask: vi.fn(),
      getWorkspacePath: () => gateDir,
    } as any,
    orchestrator: {
      getTask: (id: string) => allTasks.find((t) => t.id === id),
      getAllTasks: () => allTasks,
      handleWorkerResponse: vi.fn(),
      setTaskAwaitingApproval: vi.fn(),
    } as any,
    callbacks: {} as any,
    async execGitReadonly(args: string[]) {
      return gitExec(args, hostDir);
    },
    async execGitIn(args: string[], dir: string) {
      return gitExec(args, dir);
    },
    async createMergeWorktree() { return gateDir; },
    async removeMergeWorktree() {},
    async execGh() { return ''; },
    async execPr() { return ''; },
    async detectDefaultBranch() { return 'master'; },
    async gitLogMessage() { return ''; },
    async gitDiffStat() { return ''; },
    startPrPolling: vi.fn(),
    async executeTasks() {},
    async buildMergeSummary() { return '## Summary'; },
    async consolidateAndMerge() { return undefined; },
  };
}

describe('publishAfterFixImpl integration (real git)', () => {
  let root: string;

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('detaches HEAD, fetches, consolidates task branches, and pushes feature branch', async () => {
    const sandbox = createSandbox();
    root = sandbox.root;

    const fixCommit = git('rev-parse HEAD', sandbox.gateDir);

    const mergeTask: TaskState = {
      id: '__merge__wf-int',
      description: 'Merge gate',
      status: 'running',
      dependencies: ['t1'],
      createdAt: new Date(),
      config: { isMergeNode: true, workflowId: 'wf-int' } as any,
      execution: {} as any,
    };

    const taskT1: TaskState = {
      id: 't1',
      description: 'Task 1',
      status: 'completed',
      dependencies: [],
      createdAt: new Date(),
      config: { workflowId: 'wf-int' } as any,
      execution: { branch: 'invoker/t1' } as any,
    };

    const host = makeHost(sandbox.hostDir, sandbox.gateDir, [mergeTask, taskT1]);
    await publishAfterFixImpl(host, mergeTask);

    // Should have succeeded (no error response)
    expect(host.orchestrator.handleWorkerResponse).not.toHaveBeenCalled();

    // Feature branch should exist in the origin
    const originBranches = git('branch', sandbox.originDir);
    expect(originBranches).toContain('plan/feature');

    // Feature branch in origin should contain Claude's fix commit
    const featureSha = git('rev-parse plan/feature', sandbox.originDir);
    const isAncestor = gitSilent(`merge-base --is-ancestor ${fixCommit} ${featureSha}`, sandbox.originDir);
    expect(isAncestor).toBe('');

    // Feature branch should contain the task branch's file
    // (hostDir must fetch first — the new code pushes directly from gateDir to origin,
    // so hostDir's remote tracking refs are stale.)
    git('fetch origin', sandbox.hostDir);
    git('checkout plan/feature', sandbox.hostDir);
    expect(existsSync(join(sandbox.hostDir, 't1.txt'))).toBe(true);

    // Feature branch should contain Claude's fix file
    expect(existsSync(join(sandbox.hostDir, 'fix.txt'))).toBe(true);

    // orchestrator.setTaskAwaitingApproval should have been called
    expect(host.orchestrator.setTaskAwaitingApproval).toHaveBeenCalledWith('__merge__wf-int', expect.objectContaining({
      execution: expect.objectContaining({ branch: 'plan/feature' }),
    }));
  });

  it('fails without detach (regression proof): fetch into checked-out branch is rejected by git', async () => {
    const sandbox = createSandbox();
    root = sandbox.root;

    // Prove the bug: try to fetch +refs/heads/* while master is checked out
    const currentBranch = git('branch --show-current', sandbox.gateDir);
    expect(currentBranch).toBe('master');

    expect(() => {
      git('fetch origin +refs/heads/*:refs/heads/*', sandbox.gateDir);
    }).toThrow(/refusing to fetch into branch.*checked out/);
  });

  it('succeeds with detach (the fix): fetch after detaching HEAD works', async () => {
    const sandbox = createSandbox();
    root = sandbox.root;

    const headSha = git('rev-parse HEAD', sandbox.gateDir);
    git(`checkout --detach ${headSha}`, sandbox.gateDir);

    // This should now succeed
    expect(() => {
      git('fetch origin +refs/heads/*:refs/heads/*', sandbox.gateDir);
    }).not.toThrow();
  });
});
