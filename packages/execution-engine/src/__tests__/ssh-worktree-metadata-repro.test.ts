import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskRunner } from '../task-runner.js';
import type { TaskState } from '@invoker/workflow-core';

function git(cmd: string, cwd: string): string {
  return execSync(cmd, {
    cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function makeTask(overrides: {
  id?: string;
  status?: string;
  config?: Partial<TaskState['config']>;
  execution?: Partial<TaskState['execution']>;
} = {}): TaskState {
  return {
    id: overrides.id ?? 'wf-1/test-execution-engine',
    description: 'repro task',
    status: overrides.status ?? 'pending',
    dependencies: [],
    createdAt: new Date(),
    config: { ...overrides.config },
    execution: { ...overrides.execution },
  } as TaskState;
}

describe('SSH worktree metadata repro', () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();
      if (root) rmSync(root, { recursive: true, force: true });
    }
  });

  it('proves a reused old worktree would attach a new branch to the old worktree path', () => {
    const root = mkdtempSync(join(tmpdir(), 'ssh-worktree-repro-'));
    tempRoots.push(root);

    const repoDir = join(root, 'repo');
    const oldPath = join(root, 'experiment-wf-1-test-execution-engine-bc7a0b71');
    const canonicalNewPath = join(root, 'experiment-wf-1-test-execution-engine-b68b146f');
    const oldBranch = 'experiment/wf-1/test-execution-engine-bc7a0b71';
    const newBranch = 'experiment/wf-1/test-execution-engine-b68b146f';

    execSync(`mkdir -p ${JSON.stringify(repoDir)}`);
    git('git init -b master', repoDir);
    git('git config user.email "test@example.com"', repoDir);
    git('git config user.name "Test User"', repoDir);
    writeFileSync(join(repoDir, 'README.md'), 'seed\n');
    git('git add README.md', repoDir);
    git('git commit -m "seed"', repoDir);

    git(`git worktree add ${JSON.stringify(oldPath)} -b ${JSON.stringify(oldBranch)} master`, repoDir);
    git(`git -C ${JSON.stringify(oldPath)} branch -m ${JSON.stringify(oldBranch)} ${JSON.stringify(newBranch)}`, repoDir);

    const porcelain = git('git worktree list --porcelain', repoDir);
    expect(porcelain).toContain(`worktree ${realpathSync(oldPath)}`);
    expect(porcelain).toContain(`branch refs/heads/${newBranch}`);
    expect(existsSync(oldPath)).toBe(true);
    expect(existsSync(canonicalNewPath)).toBe(false);

    expect(() => {
      git(`git worktree add ${JSON.stringify(canonicalNewPath)} ${JSON.stringify(newBranch)}`, repoDir);
    }).toThrow(/already (used by worktree|checked out) at '.*experiment-wf-1-test-execution-engine-bc7a0b71'/);
  });

  it('blocks stale SSH startup-failure metadata from overwriting the live task row', async () => {
    const ownerPath = '/home/invoker/.invoker/worktrees/049de5b865cc/experiment-wf-1-test-execution-engine-bc7a0b71';
    const branch = 'experiment/wf-1/test-execution-engine-b68b146f';
    const staleAttemptId = 'attempt-1';
    const currentTask = makeTask({
      id: 'wf-1/test-execution-engine',
      status: 'pending',
      config: { command: 'pnpm test', runnerKind: 'ssh' },
      execution: {
        selectedAttemptId: 'attempt-2',
        generation: 2,
        workspacePath: '/home/invoker/.invoker/worktrees/049de5b865cc/experiment-wf-1-test-execution-engine-current',
        branch: 'experiment/wf-1/test-execution-engine-current',
      },
    });

    const failingExecutor = {
      type: 'ssh',
      start: vi.fn().mockRejectedValue(Object.assign(
        new Error(
          'SSH remote script failed (exit=128)\n' +
            `STDERR:\nPreparing worktree (checking out '${branch}')\n` +
            `fatal: '${branch}' is already used by worktree at '${ownerPath}'\n`,
        ),
        {
          workspacePath: ownerPath,
          branch,
        },
      )),
      onComplete: vi.fn(),
      onOutput: vi.fn(),
      onHeartbeat: vi.fn(),
      kill: vi.fn(),
      destroyAll: vi.fn(),
    };

    const staleTask = makeTask({
      id: 'wf-1/test-execution-engine',
      status: 'pending',
      config: { command: 'pnpm test', runnerKind: 'ssh' },
      execution: {
        selectedAttemptId: staleAttemptId,
        generation: 1,
      },
    });

    const updateTaskSpy = vi.fn();
    const updateAttemptSpy = vi.fn();
    const handleResponseSpy = vi.fn();

    const runner = new TaskRunner({
      orchestrator: {
        getTask: () => currentTask,
        getAllTasks: () => [currentTask],
        handleWorkerResponse: handleResponseSpy,
      } as any,
      persistence: {
        updateTask: updateTaskSpy,
        updateAttempt: updateAttemptSpy,
        appendTaskOutput: vi.fn(),
      } as any,
      executorRegistry: {
        getDefault: () => failingExecutor,
        get: () => failingExecutor,
        getAll: () => [failingExecutor],
      } as any,
        cwd: '/tmp',
    });

    await runner.executeTask(staleTask);

    expect(updateAttemptSpy).toHaveBeenCalledWith(staleAttemptId, {
      workspacePath: ownerPath,
      branch,
    });
    expect(updateTaskSpy).not.toHaveBeenCalledWith('wf-1/test-execution-engine', expect.objectContaining({
      execution: expect.objectContaining({
        workspacePath: ownerPath,
        branch,
      }),
    }));
    expect(handleResponseSpy).not.toHaveBeenCalled();
  });
});
