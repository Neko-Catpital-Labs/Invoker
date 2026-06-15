import { describe, expect, it, vi } from 'vitest';
import { TaskRunner } from '../task-runner.js';
import type { TaskState } from '@invoker/workflow-core';

function makeTask(overrides: any = {}): TaskState {
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

describe('scratch stale repro', () => {
  it('attempt advances to attempt-2 while attempt-1 SSH start is in flight', async () => {
    const ownerPath = '/home/invoker/.invoker/worktrees/049de5b865cc/old-attempt-1';
    const oldBranch = 'experiment/wf-1/test-execution-engine-attempt1';

    // Live task: starts on attempt-1, then advances to attempt-2 mid-flight.
    const liveTask = makeTask({
      id: 'wf-1/test-execution-engine',
      status: 'running',
      config: { command: 'pnpm test', runnerKind: 'ssh' },
      execution: { selectedAttemptId: 'attempt-1', generation: 0 },
    });

    const failingExecutor = {
      type: 'ssh',
      start: vi.fn().mockImplementation(async () => {
        // Simulate the task advancing to attempt-2 during the slow SSH start.
        liveTask.execution.selectedAttemptId = 'attempt-2';
        liveTask.execution.generation = 1;
        throw Object.assign(
          new Error(
            'SSH remote script failed (exit=128)\n' +
              `fatal: '${oldBranch}' is already used by worktree at '${ownerPath}'\n`,
          ),
          { workspacePath: ownerPath, branch: oldBranch },
        );
      }),
      onComplete: vi.fn(),
      onOutput: vi.fn(),
      onHeartbeat: vi.fn(),
      kill: vi.fn(),
      destroyAll: vi.fn(),
    };

    const updateSpy = vi.fn();
    const handleResponseSpy = vi.fn().mockReturnValue([]);

    const runner = new TaskRunner({
      orchestrator: {
        getTask: () => liveTask,
        getAllTasks: () => [liveTask],
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

    // Launch captures attempt-1 lineage.
    const launchTask = makeTask({
      id: 'wf-1/test-execution-engine',
      status: 'running',
      config: { command: 'pnpm test', runnerKind: 'ssh' },
      execution: { selectedAttemptId: 'attempt-1', generation: 0 },
    });

    await runner.executeTask(launchTask);

    // Did we write stale metadata onto the live (now attempt-2) task row?
    const metadataWrites = updateSpy.mock.calls.filter(
      (c) => c[1]?.execution?.workspacePath === ownerPath || c[1]?.execution?.branch === oldBranch,
    );
    console.log('STALE METADATA WRITES:', JSON.stringify(metadataWrites));

    // Did we emit a failed worker response against the newer attempt?
    const failedResponses = handleResponseSpy.mock.calls.filter(
      (c) => c[0]?.status === 'failed',
    );
    console.log('FAILED RESPONSES:', JSON.stringify(failedResponses));

    expect(metadataWrites.length).toBe(0);
    expect(failedResponses.length).toBe(0);
  });
});
