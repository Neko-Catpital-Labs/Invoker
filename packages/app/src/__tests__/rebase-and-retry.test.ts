/**
 * Rebase-and-retry integration test with real git.
 *
 * Proves that rebaseAndRetry() from workflow-actions.ts deletes old task
 * branches before restarting, so setupTaskBranch creates fresh branches
 * from current HEAD (including new commits).
 *
 * Additionally verifies that RepoPool.doEnsureClone fast-forwards local
 * branches after fetch, so even without explicit branch deletion the
 * worktree gets a fresh base (stale work no longer carries over).
 *
 * Pattern: sandbox git repo + real WorktreeFamiliar + real TaskExecutor
 * (follows branch-chain.test.ts).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import type { WorkResponse } from '@invoker/protocol';
import type { TaskState } from '@invoker/core';
import { TaskExecutor, FamiliarRegistry, WorktreeFamiliar } from '@invoker/executors';
import { rebaseAndRetry, bumpGenerationAndRestart } from '../workflow-actions.js';

function createTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rebase-retry-'));
  execSync('git init', { cwd: dir });
  execSync('git config user.email "test@test.com"', { cwd: dir });
  execSync('git config user.name "Test"', { cwd: dir });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'rebase-retry-test', version: '1.0.0', private: true }, null, 2));
  execSync('pnpm install', { cwd: dir, stdio: 'pipe' });
  writeFileSync(join(dir, 'initial.txt'), 'initial');
  execSync('git add -A && git commit -m "initial commit X"', { cwd: dir });
  return dir;
}

function isAncestor(cwd: string, ancestor: string, descendant: string): boolean {
  try {
    execSync(`git merge-base --is-ancestor ${ancestor} ${descendant}`, { cwd });
    return true;
  } catch {
    return false;
  }
}

function branchExists(cwd: string, branch: string): boolean {
  try {
    execSync(`git rev-parse --verify ${branch}`, { cwd });
    return true;
  } catch {
    return false;
  }
}

function getSha(cwd: string, ref: string): string {
  return execSync(`git rev-parse ${ref}`, { cwd }).toString().trim();
}

function makeTaskState(overrides: {
  id: string;
  description?: string;
  status?: string;
  dependencies?: string[];
  config?: Partial<TaskState['config']>;
  execution?: Partial<TaskState['execution']>;
}): TaskState {
  return {
    id: overrides.id,
    description: overrides.description ?? overrides.id,
    status: overrides.status ?? 'pending',
    dependencies: overrides.dependencies ?? [],
    createdAt: new Date(),
    config: { ...overrides.config },
    execution: { ...overrides.execution },
  } as TaskState;
}

describe('rebase-and-retry: branch deletion before restart', { timeout: 120_000 }, () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTempRepo();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function buildHarness() {
    const task = makeTaskState({
      id: 'task-a',
      description: 'Test task',
      config: {
        command: 'echo hello',
        familiarType: 'worktree',
        workflowId: 'wf-test',
      },
    });

    const tasks = [task];
    const responses = new Map<string, WorkResponse>();

    let generation = 0;

    const orchestrator = {
      getTask: (id: string) => tasks.find(t => t.id === id),
      getAllTasks: () => tasks,
      handleWorkerResponse: (response: WorkResponse) => {
        responses.set(response.actionId, response);
        const t = tasks.find(t => t.id === response.actionId);
        if (t) {
          (t as any).status = response.status;
        }
        return [];
      },
      setTaskAwaitingApproval: () => {},
      restartWorkflow: (_workflowId: string): TaskState[] => {
        // Mimic Orchestrator.restartWorkflow: reset execution state
        for (const t of tasks) {
          (t as any).status = 'pending';
          (t as any).execution = {
            ...t.execution,
            startedAt: undefined,
            completedAt: undefined,
            error: undefined,
            exitCode: undefined,
            commit: undefined,
            branch: undefined,
            workspacePath: undefined,
          };
        }
        return tasks;
      },
    };

    const persistence = {
      loadWorkflow: () => ({
        id: 'wf-test',
        baseBranch: 'master',
        repoUrl: `file://${tmpDir}`,
        generation,
      }),
      updateWorkflow: (_id: string, changes: any) => {
        if (changes.generation !== undefined) {
          generation = changes.generation;
        }
      },
      updateTask: (id: string, changes: any) => {
        const t = tasks.find(t => t.id === id);
        if (t && changes.execution) {
          Object.assign(t.execution, changes.execution);
        }
        if (t && changes.config) {
          Object.assign(t.config, changes.config);
        }
      },
    };

    const registry = new FamiliarRegistry();
    registry.register(
      'worktree',
      new WorktreeFamiliar({
        cacheDir: join(tmpDir, 'rebase-retry-cache'),
        worktreeBaseDir: join(tmpDir, 'rebase-retry-wt'),
        claudeCommand: '/bin/echo',
      }),
    );

    const executor = new TaskExecutor({
      orchestrator: orchestrator as any,
      persistence: persistence as any,
      familiarRegistry: registry,
      cwd: tmpDir,
      defaultBranch: 'master',
    });

    return { tasks, task, executor, orchestrator, persistence, responses };
  }

  async function executeTask(
    executor: TaskExecutor,
    task: TaskState,
  ): Promise<void> {
    (task as any).status = 'running';
    await (executor as any).executeTaskInner(task);
  }

  function addCommitToMaster(cwd: string, filename: string, message: string): string {
    execSync('git checkout master', { cwd });
    writeFileSync(join(cwd, filename), `content of ${filename}`);
    execSync(`git add -A && git commit -m "${message}"`, { cwd });
    return getSha(cwd, 'HEAD');
  }

  it('with branch deletion (fix): fresh branch from new HEAD, stale work removed', async () => {
    const { task, executor, orchestrator, persistence } = buildHarness();

    // Step 1: Execute task → creates experiment/task-a-<hash> with a task commit
    await executeTask(executor, task);
    const branchFirst = task.execution.branch!;
    expect(branchExists(tmpDir, branchFirst)).toBe(true);

    const oldTaskCommit = getSha(tmpDir, branchFirst);

    // Step 2: Add commit Y to master
    const commitY = addCommitToMaster(tmpDir, 'new-feature.txt', 'commit Y: new feature');

    // Step 3: Call rebaseAndRetry (the fix) — deletes old branch, then restarts
    const deps = {
      orchestrator: orchestrator as any,
      persistence: persistence as any,
      repoRoot: tmpDir,
    };
    await rebaseAndRetry('task-a', deps);

    // Branch should have been deleted by rebaseAndRetry
    expect(branchExists(tmpDir, branchFirst)).toBe(false);

    // Step 4: Re-execute the task (simulates TaskExecutor running the restarted task)
    await executeTask(executor, task);
    const branchAfter = task.execution.branch!;

    // Assertions:
    // (a) commit Y IS an ancestor of the new branch (new master is included)
    expect(isAncestor(tmpDir, commitY, branchAfter)).toBe(true);

    // (b) old task commit SHA is NOT an ancestor of the new branch (stale work removed)
    expect(isAncestor(tmpDir, oldTaskCommit, branchAfter)).toBe(false);
  });

  it('without branch deletion: clone fast-forward prevents stale branches', async () => {
    const { task, executor, orchestrator, persistence } = buildHarness();

    // Step 1: Execute task → creates experiment/task-a-* with a task commit
    await executeTask(executor, task);
    const branchFirst = task.execution.branch!;
    expect(branchExists(tmpDir, branchFirst)).toBe(true);

    const oldTaskCommit = getSha(tmpDir, branchFirst);

    // Step 2: Add commit Y to master
    const commitY = addCommitToMaster(tmpDir, 'new-feature.txt', 'commit Y: new feature');

    // Step 3: Restart WITHOUT deleting branches
    bumpGenerationAndRestart('wf-test', {
      orchestrator: orchestrator as any,
      persistence: persistence as any,
    });

    // Branch still exists (not deleted)
    expect(branchExists(tmpDir, branchFirst)).toBe(true);

    // Step 4: Re-execute — RepoPool.doEnsureClone now fast-forwards the clone's
    // local master after fetch, so bashPreserveOrReset resets the worktree branch
    // to the fresh base. Stale work no longer carries over.
    await executeTask(executor, task);
    const branchAfter = task.execution.branch!;

    // commit Y IS an ancestor (fresh base includes it)
    expect(isAncestor(tmpDir, commitY, branchAfter)).toBe(true);

    // OLD task commit is NOT an ancestor (branch was recreated from fresh base)
    expect(isAncestor(tmpDir, oldTaskCommit, branchAfter)).toBe(false);
  });
});
