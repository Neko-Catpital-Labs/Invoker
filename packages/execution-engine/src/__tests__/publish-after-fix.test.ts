import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync, execFileSync } from 'node:child_process';
import type { TaskState } from '@invoker/workflow-core';
import { publishAfterFixImpl, type MergeRunnerHost } from '../merge-runner.js';

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

function makeHost(hostDir: string, gateDir: string, allTasks: TaskState[]): MergeRunnerHost {
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

  it('uses fixedIntegrationSha anchor when present instead of current gate HEAD', async () => {
    const sandbox = createSandbox();
    root = sandbox.root;

    const anchoredFixCommit = git('rev-parse HEAD', sandbox.gateDir);
    writeFileSync(join(sandbox.gateDir, 'late-change.txt'), 'new gate head after anchor');
    git('add -A', sandbox.gateDir);
    git('commit -m "late gate change"', sandbox.gateDir);

    const mergeTask: TaskState = {
      id: '__merge__wf-int',
      description: 'Merge gate',
      status: 'running',
      dependencies: ['t1'],
      createdAt: new Date(),
      config: { isMergeNode: true, workflowId: 'wf-int' } as any,
      execution: { fixedIntegrationSha: anchoredFixCommit } as any,
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

    git('fetch origin', sandbox.hostDir);
    git('checkout plan/feature', sandbox.hostDir);
    expect(existsSync(join(sandbox.hostDir, 'fix.txt'))).toBe(true);
    expect(existsSync(join(sandbox.hostDir, 'late-change.txt'))).toBe(false);
    expect(host.orchestrator.setTaskAwaitingApproval).toHaveBeenCalledWith(
      '__merge__wf-int',
      expect.objectContaining({
        execution: expect.objectContaining({
          fixedIntegrationSha: undefined,
          fixedIntegrationRecordedAt: undefined,
          fixedIntegrationSource: undefined,
        }),
      }),
    );
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

  it('merges pre-pushed plan/feature tip in one step when present (avoids re-merging task branches)', async () => {
    const sandbox = createSandbox();
    root = sandbox.root;

    // Simulate consolidateAndMerge: feature branch already on origin before the gate fix path.
    git('checkout -b plan/feature', sandbox.hostDir);
    gitExec(['merge', '--no-ff', '-m', 'Merge invoker/t1', 'invoker/t1'], sandbox.hostDir);
    git('push -u origin plan/feature', sandbox.hostDir);
    git('checkout master', sandbox.hostDir);

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

    expect(host.orchestrator.handleWorkerResponse).not.toHaveBeenCalled();

    git('fetch origin', sandbox.hostDir);
    // Gate force-pushed plan/feature; reset local branch to match origin (avoid stale pre-push tip).
    gitExec(['checkout', '-B', 'plan/feature', 'origin/plan/feature'], sandbox.hostDir);
    expect(existsSync(join(sandbox.hostDir, 't1.txt'))).toBe(true);
    expect(existsSync(join(sandbox.hostDir, 'fix.txt'))).toBe(true);

    const featureSha = git('rev-parse plan/feature', sandbox.hostDir);
    const isAncestor = gitSilent(`merge-base --is-ancestor ${fixCommit} ${featureSha}`, sandbox.hostDir);
    expect(isAncestor).toBe('');
  });

  /**
   * Regression coverage for deleted repro repro-post-fix-merge-conflict (scenario 14):
   * After Claude resolves a merge conflict by merging the task branch into the gate,
   * the post-fix consolidate loop must NOT try to re-merge that task branch (which
   * would either be a no-op or, worse, fail with a synthetic conflict). The ancestor
   * check at merge-executor.ts:737 is what guards this — if the task branch is already
   * an ancestor of HEAD, skip it.
   */
  it('skips task branches already merged into HEAD by the AI fix (no re-merge)', async () => {
    const sandbox = createSandbox();
    root = sandbox.root;

    // Simulate Claude's fix: merge invoker/t1 into the gate clone's master,
    // then add the actual fix commit on top. After this, invoker/t1 IS an
    // ancestor of HEAD, so publishAfterFixImpl must skip it.
    git('fetch origin invoker/t1:invoker/t1', sandbox.gateDir);
    gitExec(['merge', '--no-ff', '-m', 'Merge invoker/t1 (claude resolution)', 'invoker/t1'], sandbox.gateDir);
    writeFileSync(join(sandbox.gateDir, 'extra-fix.txt'), 'additional claude tweak');
    git('add -A', sandbox.gateDir);
    git('commit -m "claude post-merge tweak"', sandbox.gateDir);

    // Sanity: invoker/t1 is now an ancestor of gate HEAD.
    expect(() => git('merge-base --is-ancestor invoker/t1 HEAD', sandbox.gateDir)).not.toThrow();

    const headBeforePublish = git('rev-parse HEAD', sandbox.gateDir);

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

    // Should NOT have failed (no error response).
    expect(host.orchestrator.handleWorkerResponse).not.toHaveBeenCalled();

    // Feature branch on origin must contain both Claude's tweak and the task branch's file.
    git('fetch origin', sandbox.hostDir);
    git('checkout plan/feature', sandbox.hostDir);
    expect(existsSync(join(sandbox.hostDir, 't1.txt'))).toBe(true);
    expect(existsSync(join(sandbox.hostDir, 'extra-fix.txt'))).toBe(true);

    // The published feature branch must reach the gate's pre-publish HEAD,
    // proving the AI fix's resolution was preserved (and not re-merged on top).
    const featureSha = git('rev-parse plan/feature', sandbox.hostDir);
    const isAncestor = gitSilent(`merge-base --is-ancestor ${headBeforePublish} ${featureSha}`, sandbox.hostDir);
    expect(isAncestor).toBe('');

    // The merge gate must reach awaiting_approval state.
    expect(host.orchestrator.setTaskAwaitingApproval).toHaveBeenCalledWith(
      '__merge__wf-int',
      expect.objectContaining({
        execution: expect.objectContaining({ branch: 'plan/feature' }),
      }),
    );
  });
});
