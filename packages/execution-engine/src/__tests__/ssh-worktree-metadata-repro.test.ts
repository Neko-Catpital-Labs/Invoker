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

  it('proves TaskRunner should persist the owning worktree path on SSH startup failure', async () => {
    const ownerPath = '/home/invoker/.invoker/worktrees/049de5b865cc/experiment-wf-1-test-execution-engine-bc7a0b71';
    const branch = 'experiment/wf-1/test-execution-engine-b68b146f';

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

    const task = makeTask({
      id: 'wf-1/test-execution-engine',
      config: { command: 'pnpm test', runnerKind: 'ssh' },
    });

    const updateSpy = vi.fn();
    const handleResponseSpy = vi.fn();

    const runner = new TaskRunner({
      orchestrator: {
        getTask: () => task,
        getAllTasks: () => [task],
        handleWorkerResponse: handleResponseSpy,
      } as any,
      persistence: {
        updateTask: updateSpy,
        appendTaskOutput: vi.fn(),
      } as any,
      executorRegistry: {
        getDefault: () => failingExecutor,
        get: () => failingExecutor,
        getAll: () => [failingExecutor],
      } as any,
      cwd: '/tmp',
    });

    await runner.executeTask(task);

    expect(updateSpy).toHaveBeenCalledWith('wf-1/test-execution-engine', {
      config: { runnerKind: 'ssh' },
      execution: {
        workspacePath: ownerPath,
        branch,
      },
    });
    expect(updateSpy).not.toHaveBeenCalledWith('wf-1/test-execution-engine', expect.objectContaining({
      execution: expect.objectContaining({
        workspacePath: '/home/invoker/.invoker/worktrees/049de5b865cc/experiment-wf-1-test-execution-engine-b68b146f',
      }),
    }));
    expect(handleResponseSpy).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed',
      outputs: expect.objectContaining({
        error: expect.stringContaining('Executor startup failed (ssh)'),
      }),
    }));
  });

  it('blocks a stale SSH startup failure from writing old metadata or a failed response after the attempt advanced', async () => {
    // attempt-1's launch fails late with the realistic SSH worktree-owner
    // error, but by the time it returns the task has already advanced to
    // attempt-2.  The stale launch must not clobber the live task row.
    const ownerPath = '/home/invoker/.invoker/worktrees/049de5b865cc/experiment-wf-1-test-execution-engine-bc7a0b71';
    const branch = 'experiment/wf-1/test-execution-engine-b68b146f';

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

    // The task this launch was started for is pinned to attempt-1...
    const launchedTask = makeTask({
      id: 'wf-1/test-execution-engine',
      status: 'running',
      config: { command: 'pnpm test', runnerKind: 'ssh' },
      execution: { selectedAttemptId: 'wf-1/test-execution-engine-a1' },
    });
    // ...but the orchestrator now reports attempt-2 as the selected attempt.
    const advancedTask = makeTask({
      id: 'wf-1/test-execution-engine',
      status: 'running',
      config: { command: 'pnpm test', runnerKind: 'ssh' },
      execution: { selectedAttemptId: 'wf-1/test-execution-engine-a2' },
    });

    const updateSpy = vi.fn();
    const appendOutputSpy = vi.fn();
    const handleResponseSpy = vi.fn();

    const runner = new TaskRunner({
      orchestrator: {
        getTask: () => advancedTask,
        getAllTasks: () => [advancedTask],
        handleWorkerResponse: handleResponseSpy,
      } as any,
      persistence: {
        updateTask: updateSpy,
        appendTaskOutput: appendOutputSpy,
      } as any,
      executorRegistry: {
        getDefault: () => failingExecutor,
        get: () => failingExecutor,
        getAll: () => [failingExecutor],
      } as any,
      cwd: '/tmp',
    });

    await runner.executeTask(launchedTask);

    // Stale launch must not write the old worktree/branch onto the live row.
    expect(updateSpy).not.toHaveBeenCalledWith('wf-1/test-execution-engine', expect.objectContaining({
      execution: expect.objectContaining({ workspacePath: ownerPath }),
    }));
    expect(updateSpy).not.toHaveBeenCalledWith('wf-1/test-execution-engine', expect.objectContaining({
      execution: expect.objectContaining({ branch }),
    }));
    // Stale launch must not emit a failed response against the newer attempt.
    expect(handleResponseSpy).not.toHaveBeenCalled();
    // Diagnostics are still preserved through the append-only output path.
    expect(appendOutputSpy).toHaveBeenCalledWith(
      'wf-1/test-execution-engine',
      expect.stringContaining('Executor startup failed (ssh)'),
    );
  });
});
