#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
EXPECT="fixed"

case "${1:-}" in
  --expect)
    EXPECT="${2:-}"
    ;;
  --expect=*)
    EXPECT="${1#--expect=}"
    ;;
  "")
    ;;
  *)
    echo "usage: $0 [--expect broken|fixed]" >&2
    exit 2
    ;;
esac

if [[ "$EXPECT" != "broken" && "$EXPECT" != "fixed" ]]; then
  echo "usage: $0 [--expect broken|fixed]" >&2
  exit 2
fi

TEST_FILE="$ROOT/packages/execution-engine/src/__tests__/ssh-pool-member-overcommit.$$.repro.test.ts"

cleanup() {
  rm -f "$TEST_FILE"
}
trap cleanup EXIT

cat > "$TEST_FILE" <<'TS'
import { describe, expect, it, vi } from 'vitest';
import { TaskRunner } from '../task-runner.js';
import { SQLiteAdapter } from '@invoker/data-store';
import type { TaskState } from '@invoker/workflow-core';

const expectFixed = process.env.INVOKER_REPRO_EXPECT === 'fixed';

function makeTask(id: string): TaskState {
  return {
    id,
    description: id,
    status: 'pending',
    dependencies: [],
    createdAt: new Date(),
    config: { runnerKind: 'ssh', poolId: 'ssh-pool' },
    execution: {},
  } as TaskState;
}

function makeRunner(): TaskRunner {
  const sshExecutor = {
    type: 'ssh',
    start: vi.fn(),
    onComplete: vi.fn(),
    onOutput: vi.fn(),
    onHeartbeat: vi.fn(),
    kill: vi.fn(),
    destroyAll: vi.fn(),
  };

  return new TaskRunner({
    orchestrator: { getTask: () => null, getAllTasks: () => [] } as any,
    persistence: {} as any,
    executorRegistry: {
      getDefault: () => sshExecutor,
      get: (type: string) => type === 'ssh' ? sshExecutor : null,
      getAll: () => [sshExecutor],
      register: vi.fn(),
    } as any,
    cwd: '/tmp',
    remoteTargetsProvider: () => ({
      'remote-a': {
        host: 'remote-a.example.com',
        user: 'invoker',
        sshKeyPath: '/tmp/fake-key',
        managedWorkspaces: true,
      },
    }),
    executionPoolsProvider: () => ({
      'ssh-pool': {
        selectionStrategy: 'leastLoaded',
        maxConcurrentTasksPerMember: 1,
        members: [{ id: 'remote-a', type: 'ssh' as const, maxConcurrentTasks: 1 }],
      },
    }),
  });
}

describe('ssh pool member overcommit repro', () => {
  it('does not admit a second task onto a maxConcurrentTasks=1 SSH member', () => {
    const runner = makeRunner();
    const first = makeTask('wf-1/task-a');
    const second = makeTask('wf-2/task-b');

    runner.selectExecutor(first);
    const firstSelection = (runner as any).pendingPoolSelections.get(first.id);
    expect(firstSelection?.member.id).toBe('remote-a');

    if (expectFixed) {
      expect(() => runner.selectExecutor(second)).toThrow(/no member capacity/);
    } else {
      runner.selectExecutor(second);
      const secondSelection = (runner as any).pendingPoolSelections.get(second.id);
      expect(secondSelection?.member.id).toBe('remote-a');
    }
  });

  it('uses a durable lease to make separate owners defer instead of starting on the same SSH member', async () => {
    const adapter = await SQLiteAdapter.create(':memory:');
    try {
      const firstTask = makeTask('wf-1/task-a');
      const secondTask = makeTask('wf-2/task-b');
      let firstComplete: ((response: any) => void) | undefined;
      const firstExecutor = {
        type: 'ssh',
        start: vi.fn(async (request: any) => ({
          executionId: `exec-${request.actionId}`,
          taskId: request.actionId,
          workspacePath: '/remote/task-a',
        })),
        onComplete: vi.fn((_handle: any, cb: any) => { firstComplete = cb; }),
        onOutput: vi.fn(),
        onHeartbeat: vi.fn(),
        kill: vi.fn(),
        destroyAll: vi.fn(),
      };
      const secondExecutor = {
        type: 'ssh',
        start: vi.fn(async (request: any) => ({
          executionId: `exec-${request.actionId}`,
          taskId: request.actionId,
          workspacePath: '/remote/task-b',
        })),
        onComplete: vi.fn(),
        onOutput: vi.fn(),
        onHeartbeat: vi.fn(),
        kill: vi.fn(),
        destroyAll: vi.fn(),
      };
      const runnerA = makeRunnerWith({ adapter, task: firstTask, executor: firstExecutor, deferTask: vi.fn() });
      const deferTask = vi.fn();
      const runnerB = makeRunnerWith({ adapter, task: secondTask, executor: secondExecutor, deferTask });

      const firstRun = runnerA.executeTask(firstTask);
      await vi.waitFor(() => expect(firstExecutor.start).toHaveBeenCalledTimes(1));
      await runnerB.executeTask(secondTask);

      if (expectFixed) {
        expect(secondExecutor.start).not.toHaveBeenCalled();
        expect(deferTask).toHaveBeenCalledWith(secondTask.id);
      } else {
        expect(secondExecutor.start).toHaveBeenCalledTimes(1);
      }

      firstComplete?.({
        requestId: 'req',
        actionId: firstTask.id,
        attemptId: firstTask.execution.selectedAttemptId,
        status: 'completed',
        outputs: { exitCode: 0 },
      });
      await firstRun;
    } finally {
      adapter.close();
    }
  });
});

function makeRunnerWith(input: { adapter: SQLiteAdapter; task: TaskState; executor: any; deferTask: any }): TaskRunner {
  return new TaskRunner({
    orchestrator: {
      getTask: () => input.task,
      getAllTasks: () => [input.task],
      markTaskRunningAfterLaunch: () => true,
      handleWorkerResponse: () => [],
      deferTask: input.deferTask,
    } as any,
    persistence: {
      ...input.adapter,
      updateTask: vi.fn(),
      updateAttempt: vi.fn(),
      appendTaskOutput: vi.fn(),
      logEvent: vi.fn(),
      claimExecutionResourceLease: input.adapter.claimExecutionResourceLease.bind(input.adapter),
      renewExecutionResourceLease: input.adapter.renewExecutionResourceLease.bind(input.adapter),
      releaseExecutionResourceLease: input.adapter.releaseExecutionResourceLease.bind(input.adapter),
    } as any,
    executorRegistry: {
      getDefault: () => input.executor,
      get: (type: string) => type === 'ssh' ? input.executor : null,
      getAll: () => [input.executor],
      register: vi.fn(),
    } as any,
    cwd: '/tmp',
    remoteTargetsProvider: () => ({
      'remote-a': {
        host: 'remote-a.example.com',
        user: 'invoker',
        sshKeyPath: '/tmp/fake-key',
        managedWorkspaces: true,
      },
    }),
    executionPoolsProvider: () => ({
      'ssh-pool': {
        selectionStrategy: 'leastLoaded',
        maxConcurrentTasksPerMember: 1,
        members: [{ id: 'remote-a', type: 'ssh' as const, maxConcurrentTasks: 1 }],
      },
    }),
  });
}
TS

cd "$ROOT"
echo "repro: running SSH pool overcommit repro with --expect $EXPECT"
INVOKER_REPRO_EXPECT="$EXPECT" pnpm --filter @invoker/execution-engine exec vitest run "$TEST_FILE"
