#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TEST_FILE="$ROOT/packages/execution-engine/src/__tests__/ssh-pool-member-persistence.repro.test.ts"

cleanup() {
  rm -f "$TEST_FILE"
}
trap cleanup EXIT

cat > "$TEST_FILE" <<'TS'
import { describe, expect, it, vi } from 'vitest';
import { TaskRunner } from '../task-runner.js';
import type { TaskState } from '@invoker/workflow-core';
import type { WorkResponse } from '@invoker/contracts';

function makeTask(): TaskState {
  return {
    id: 'pool-task',
    description: 'Pool-routed SSH task',
    status: 'pending',
    dependencies: [],
    createdAt: new Date(),
    config: { command: 'echo hi', runnerKind: 'ssh', poolId: 'ci-pool' },
    execution: { selectedAttemptId: 'attempt-pool-task' },
  } as TaskState;
}

describe('ssh pool member persistence repro', () => {
  it('persists the concrete pool member selected for a pool-routed SSH start', async () => {
    const task = makeTask();
    let complete: ((response: WorkResponse) => void) | undefined;
    const sshExecutor = {
      type: 'ssh',
      start: vi.fn(async (request: any) => ({
        executionId: `exec-${request.actionId}`,
        taskId: request.actionId,
        workspacePath: '/remote/worktrees/pool-task',
        branch: 'experiment/pool-task',
      })),
      onComplete: vi.fn((_handle: any, cb: (response: WorkResponse) => void) => {
        complete = cb;
      }),
      onOutput: vi.fn(),
      onHeartbeat: vi.fn(),
      kill: vi.fn(),
      destroyAll: vi.fn(),
    };
    const updateTask = vi.fn();
    const logEvent = vi.fn();
    const runner = new TaskRunner({
      orchestrator: {
        getTask: () => task,
        getAllTasks: () => [task],
        markTaskRunningAfterLaunch: () => true,
        handleWorkerResponse: vi.fn(),
      } as any,
      persistence: {
        updateTask,
        updateAttempt: vi.fn(),
        logEvent,
      } as any,
      executorRegistry: {
        getDefault: () => sshExecutor,
        get: (type: string) => type === 'ssh' ? sshExecutor : null,
        getAll: () => [sshExecutor],
      } as any,
      cwd: '/tmp',
      executionPoolsProvider: () => ({
        'ci-pool': {
          selectionStrategy: 'leastLoaded',
          members: [{ type: 'ssh', id: 'remote-a' }],
        },
      }),
      remoteTargetsProvider: () => ({
        'remote-a': {
          host: 'ci.example.com',
          user: 'runner',
          sshKeyPath: '/tmp/fake-key',
        },
      }),
    });

    const run = runner.executeTask(task);
    await vi.waitFor(() => expect(complete).toBeDefined());
    complete?.({
      requestId: 'req-1',
      actionId: task.id,
      attemptId: 'attempt-pool-task',
      status: 'completed',
      outputs: { exitCode: 0 },
    });
    await run;

    const selected = logEvent.mock.calls.find((call) => call[1] === 'task.executor.selected')?.[2];
    expect(selected).toEqual(expect.objectContaining({ poolMemberId: 'remote-a' }));

    const metadataWrite = updateTask.mock.calls.find((call) => (
      call[0] === 'pool-task'
      && call[1]?.execution?.workspacePath === '/remote/worktrees/pool-task'
    ))?.[1];
    if (metadataWrite?.config?.poolMemberId !== 'remote-a') {
      throw new Error(
        `pool member not persisted: selected=${selected?.poolMemberId ?? 'missing'} ` +
        `persisted=${metadataWrite?.config?.poolMemberId ?? 'missing'}`,
      );
    }
  });
});
TS

cd "$ROOT"
pnpm --filter @invoker/execution-engine exec vitest run "$TEST_FILE"
