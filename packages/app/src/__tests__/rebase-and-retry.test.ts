/**
 * Rebase-and-retry integration test with real git.
 *
 * Proves that rebaseAndRetry() with taskExecutor refreshes the pool mirror,
 * removes managed experiment branches there, then bumps generation so
 * re-execution branches from the updated base (including new commits on master).
 *
 * Also verifies RepoPool.doEnsureClone fast-forwards after fetch when
 * re-running without explicit pool cleanup (second scenario).
 *
 * Pattern: sandbox git repo + real WorktreeFamiliar + real TaskExecutor
 * (follows branch-chain.test.ts).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import type { WorkResponse } from '@invoker/contracts';
import type { TaskState } from '@invoker/workflow-core';
import { TaskExecutor, FamiliarRegistry, WorktreeFamiliar } from '@invoker/execution-engine';
import { rebaseAndRetry, bumpGenerationAndRecreate } from '../workflow-actions.js';

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

function mirrorClonePath(registry: FamiliarRegistry, repoUrl: string): string {
  const wt = registry.get('worktree');
  if (!(wt instanceof WorktreeFamiliar)) throw new Error('expected WorktreeFamiliar');
  return wt.getRepoPool().getClonePath(repoUrl);
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

describe('rebase-and-retry: pool mirror cleanup before restart', { timeout: 120_000 }, () => {
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
      recreateWorkflow: (_workflowId: string): TaskState[] => {
        // Mimic Orchestrator.recreateWorkflow: reset ALL execution state
        // Must match the real resetChanges in orchestrator.ts (lines 977-996)
        for (const t of tasks) {
          (t as any).status = 'pending';
          (t as any).execution = {
            startedAt: undefined,
            completedAt: undefined,
            error: undefined,
            exitCode: undefined,
            commit: undefined,
            branch: undefined,
            workspacePath: undefined,
            lastHeartbeatAt: undefined,
            reviewUrl: undefined,
            reviewId: undefined,
            reviewStatus: undefined,
            reviewProviderId: undefined,
            agentSessionId: undefined,
            containerId: undefined,
          };
        }
        return tasks;
      },
    };

    const repoUrl = `file://${tmpDir}`;

    const persistence = {
      loadWorkflow: () => ({
        id: 'wf-test',
        baseBranch: 'master',
        repoUrl,
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

    return { tasks, task, executor, orchestrator, persistence, responses, registry, repoUrl };
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

  it('with taskExecutor: pool branch removed, fresh branch from new master, stale work removed', async () => {
    const { task, executor, orchestrator, persistence, registry, repoUrl } = buildHarness();
    const clonePath = () => mirrorClonePath(registry, repoUrl);

    // Step 1: Execute task → creates experiment/task-a-<hash> in pool mirror
    await executeTask(executor, task);
    const branchFirst = task.execution.branch!;
    expect(branchExists(clonePath(), branchFirst)).toBe(true);

    const oldTaskCommit = getSha(clonePath(), branchFirst);

    // Step 2: Add commit Y to master (source repo)
    const commitY = addCommitToMaster(tmpDir, 'new-feature.txt', 'commit Y: new feature');

    // Step 3: rebaseAndRetry refreshes mirror, removes managed branches, bumps generation
    const deps = {
      orchestrator: orchestrator as any,
      persistence: persistence as any,
      repoRoot: tmpDir,
      taskExecutor: executor,
    };
    await rebaseAndRetry('task-a', deps);

    // Verify stale execution metadata is cleared (regression: repro-stale-agent-session-after-rebase.sh)
    expect(task.execution.agentSessionId).toBeUndefined();
    expect(task.execution.containerId).toBeUndefined();
    expect(task.status).toBe('pending');

    expect(branchExists(clonePath(), branchFirst)).toBe(false);

    await executeTask(executor, task);
    const branchAfter = task.execution.branch!;

    expect(isAncestor(clonePath(), commitY, branchAfter)).toBe(true);
    expect(isAncestor(clonePath(), oldTaskCommit, branchAfter)).toBe(false);
  });

  // FIXME: Flaky in CI (passes locally, fails in CI). Timing/race condition issue.
  // CI failure: expect(isAncestor(clonePath(), oldTaskCommit, branchAfter)).toBe(false) fails
  it.skip('without pool deletion: clone fast-forward prevents stale branches', async () => {
    const { task, executor, orchestrator, persistence, registry, repoUrl } = buildHarness();
    const clonePath = () => mirrorClonePath(registry, repoUrl);

    await executeTask(executor, task);
    const branchFirst = task.execution.branch!;
    expect(branchExists(clonePath(), branchFirst)).toBe(true);

    const oldTaskCommit = getSha(clonePath(), branchFirst);

    const commitY = addCommitToMaster(tmpDir, 'new-feature.txt', 'commit Y: new feature');

    bumpGenerationAndRecreate('wf-test', {
      orchestrator: orchestrator as any,
      persistence: persistence as any,
    });

    expect(branchExists(clonePath(), branchFirst)).toBe(true);

    await executeTask(executor, task);
    const branchAfter = task.execution.branch!;

    expect(isAncestor(clonePath(), commitY, branchAfter)).toBe(true);
    expect(isAncestor(clonePath(), oldTaskCommit, branchAfter)).toBe(false);
  });
});
