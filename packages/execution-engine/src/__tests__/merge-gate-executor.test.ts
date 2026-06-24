import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkRequest } from '@invoker/contracts';
import type { TaskState } from '@invoker/workflow-core';
import { MergeGateExecutor } from '../merge-gate-executor.js';

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function makeMergeTask(): TaskState {
  return {
    id: '__merge__wf-1782192502908-14',
    description: 'Review gate',
    status: 'pending',
    dependencies: ['wf-1782192502908-14/implement-crabbox-target-resolver'],
    createdAt: new Date('2026-06-23T06:02:15.000Z'),
    config: {
      isMergeNode: true,
      runnerKind: 'merge',
      workflowId: 'wf-1782192502908-14',
    },
    execution: {
      selectedAttemptId: '__merge__wf-1782192502908-14-adfcaf2a6',
      generation: 1,
      phase: 'launching',
    },
  } as TaskState;
}

function makeRequest(task: TaskState): WorkRequest {
  return {
    requestId: 'req-merge-start',
    actionId: task.id,
    attemptId: task.execution.selectedAttemptId,
    executionGeneration: task.execution.generation ?? 0,
    actionType: 'merge_gate',
    inputs: {
      description: task.description,
      baseBranch: 'master',
    },
    callbackUrl: '',
    timestamps: { createdAt: '2026-06-23T06:02:15.000Z' },
  } as WorkRequest;
}

describe('MergeGateExecutor', () => {
  const tempDirs: string[] = [];
  const originalInvokerDbDir = process.env.INVOKER_DB_DIR;

  afterEach(() => {
    if (originalInvokerDbDir === undefined) {
      delete process.env.INVOKER_DB_DIR;
    } else {
      process.env.INVOKER_DB_DIR = originalInvokerDbDir;
    }
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns a launch handle before creating the managed merge worktree', async () => {
    const invokerHome = mkdtempSync(join(tmpdir(), 'invoker-merge-start-test-'));
    tempDirs.push(invokerHome);
    process.env.INVOKER_DB_DIR = invokerHome;

    const task = makeMergeTask();
    const blockedClone = createDeferred<string>();
    const updateTask = vi.fn();
    const createMergeWorktree = vi.fn(() => blockedClone.promise);
    const executor = new MergeGateExecutor({
      cwd: '/tmp/host-repo',
      defaultBranch: 'master',
      persistence: {
        loadWorkflow: vi.fn(() => ({
          id: 'wf-1782192502908-14',
          baseBranch: 'plan/crabbox-ssh-step-1-config-and-metadata',
          featureBranch: 'plan/crabbox-ssh-step-2-resolver',
          repoUrl: 'https://github.com/Neko-Catpital-Labs/Invoker',
          onFinish: 'pull_request',
          mergeMode: 'external_review',
        })),
        updateTask,
      },
      orchestrator: {
        getTask: vi.fn(() => task),
        getAllTasks: vi.fn(() => [task]),
      },
      createMergeWorktree,
      detectDefaultBranch: vi.fn(async () => 'master'),
      buildMergeSummary: vi.fn(async () => 'summary'),
      callbacks: {},
    } as any);

    try {
      const started = await Promise.race([
        executor.start(makeRequest(task)).then((handle) => ({ kind: 'started' as const, handle })),
        new Promise<{ kind: 'blocked' }>((resolve) => setTimeout(() => resolve({ kind: 'blocked' }), 25)),
      ]);

      expect(started.kind).toBe('started');
      if (started.kind !== 'started') return;
      expect(started.handle.workspacePath).toContain('merge-launches');
      expect(existsSync(started.handle.workspacePath!)).toBe(true);

      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(createMergeWorktree).toHaveBeenCalled();
      expect(updateTask).not.toHaveBeenCalledWith(
        task.id,
        expect.objectContaining({
          execution: expect.objectContaining({
            workspacePath: expect.stringContaining('gate-__merge__wf-1782192502908-14'),
          }),
        }),
      );
    } finally {
      await executor.destroyAll();
    }
  });
});
