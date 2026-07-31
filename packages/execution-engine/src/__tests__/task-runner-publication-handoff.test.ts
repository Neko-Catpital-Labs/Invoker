import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { WorkResponse } from '@invoker/contracts';
import type { TaskState } from '@invoker/workflow-core';

import type { Executor, ExecutorHandle } from '../executor.js';
import { wireCompletion } from '../task-runner-finalize.js';

const tempDirs: string[] = [];

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
  };
}

function makeTask(): TaskState {
  return {
    id: 'wf-1/repair',
    description: 'repair upstream',
    status: 'running',
    dependencies: [],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    config: {
      workflowId: 'wf-1',
      command: 'pnpm test',
    },
    execution: {
      generation: 0,
    },
  } as TaskState;
}

function makeExecutor(response: WorkResponse): Executor {
  return {
    type: 'ssh',
    start: vi.fn(),
    kill: vi.fn(),
    sendInput: vi.fn(),
    onOutput: vi.fn(() => () => {}),
    onComplete: vi.fn((_handle: ExecutorHandle, cb: (response: WorkResponse) => void) => {
      void cb(response);
      return () => {};
    }),
    onHeartbeat: vi.fn(() => () => {}),
    getTerminalSpec: vi.fn(() => null),
    getRestoredTerminalSpec: vi.fn(() => null),
    destroyAll: vi.fn(),
  } as unknown as Executor;
}

function makeHandoffRemote(): { remote: string; branch: string; remoteHead: string; unpublishedCommit: string } {
  const root = mkdtempSync(join(tmpdir(), 'invoker-handoff-repro-'));
  tempDirs.push(root);
  const remote = join(root, 'remote.git');
  const clone = join(root, 'clone');
  git(root, ['init', '--bare', remote]);
  git(root, ['clone', remote, clone]);
  git(clone, ['config', 'user.name', 'Invoker Test']);
  git(clone, ['config', 'user.email', 'invoker-test@example.com']);

  writeFileSync(join(clone, 'README.md'), 'seed\n');
  git(clone, ['add', 'README.md']);
  git(clone, ['commit', '-m', 'seed']);
  git(clone, ['branch', '-M', 'master']);
  git(clone, ['push', 'origin', 'master']);

  const branch = 'experiment/wf-1/repair/g0.t0.a-test';
  git(clone, ['checkout', '-b', branch]);
  writeFileSync(join(clone, 'repair.txt'), 'published\n');
  git(clone, ['add', 'repair.txt']);
  git(clone, ['commit', '-m', 'published repair']);
  git(clone, ['push', 'origin', `HEAD:${branch}`]);
  const remoteHead = git(clone, ['rev-parse', 'HEAD']);

  writeFileSync(join(clone, 'repair.txt'), 'unpublished\n');
  git(clone, ['add', 'repair.txt']);
  git(clone, ['commit', '-m', 'unpublished repair']);
  const unpublishedCommit = git(clone, ['rev-parse', 'HEAD']);

  return { remote, branch, remoteHead, unpublishedCommit };
}

describe('TaskRunner publication handoff', () => {
  afterEach(() => {
    vi.clearAllMocks();
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails a completed response before launching downstream when a fresh fetch cannot reach the recorded commit', async () => {
    const { remote, branch, remoteHead, unpublishedCommit } = makeHandoffRemote();
    const task = makeTask();
    const downstream = { ...makeTask(), id: 'wf-1/downstream', dependencies: [task.id] } as TaskState;
    const handleWorkerResponse = vi.fn((response: WorkResponse) =>
      response.status === 'completed' ? [downstream] : []
    );
    const executeNewlyStartedTasks = vi.fn();
    const logEvent = vi.fn();
    const host = {
      activeExecutions: new Map([['attempt-1', { leaseResourceKey: 'lease-1', leaseHolderId: 'holder-1' }]]),
      callbacks: { onComplete: vi.fn() },
      cleanupPerTaskDockerExecutor: vi.fn(),
      executeNewlyStartedTasks,
      isLaunchStale: vi.fn(() => false),
      logger: makeLogger(),
      orchestrator: { handleWorkerResponse },
      persistence: {
        loadWorkflow: vi.fn(() => ({ id: 'wf-1', repoUrl: remote, baseBranch: 'master' })),
        logEvent,
        releaseExecutionResourceLease: vi.fn(),
      },
      runSerializedCompletion: async (work: () => Promise<void>) => { await work(); },
    };
    const response: WorkResponse = {
      requestId: 'req-1',
      actionId: task.id,
      executionGeneration: 0,
      status: 'completed',
      outputs: {
        exitCode: 0,
        branch,
        commitHash: unpublishedCommit,
      },
    };

    await wireCompletion(host as any, {
      task,
      attemptId: 'attempt-1',
      executor: makeExecutor(response),
      handle: {
        executionId: 'exec-1',
        taskId: task.id,
        branch,
      },
    });

    expect(handleWorkerResponse).toHaveBeenCalledTimes(1);
    const handled = handleWorkerResponse.mock.calls[0]?.[0] as WorkResponse;
    expect(handled.status).toBe('failed');
    expect(handled.outputs.failureClass).toBe('ssh-invalid-reference');
    expect(handled.outputs.error).toContain(unpublishedCommit);
    expect(handled.outputs.error).toContain(remoteHead);
    expect(logEvent).toHaveBeenCalledWith(task.id, 'task.branch_publication_handoff_failed', expect.objectContaining({
      branch,
      commitHash: unpublishedCommit,
      remoteHead,
    }));
    expect(executeNewlyStartedTasks).toHaveBeenCalledWith([], undefined);
  });
});
