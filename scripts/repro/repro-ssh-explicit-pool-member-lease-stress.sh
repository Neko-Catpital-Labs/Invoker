#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ITERATIONS="${ITERATIONS:-1000}"
EXPECT="fixed"

usage() {
  echo "usage: $0 [--iterations N] [--expect broken|fixed]" >&2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --iterations)
      ITERATIONS="${2:-}"
      if [[ -z "$ITERATIONS" ]]; then
        usage
        exit 2
      fi
      shift 2
      ;;
    --iterations=*)
      ITERATIONS="${1#--iterations=}"
      shift
      ;;
    --expect)
      EXPECT="${2:-}"
      if [[ -z "$EXPECT" ]]; then
        usage
        exit 2
      fi
      shift 2
      ;;
    --expect=*)
      EXPECT="${1#--expect=}"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage
      exit 2
      ;;
  esac
done

if ! [[ "$ITERATIONS" =~ ^[0-9]+$ ]] || [[ "$ITERATIONS" -lt 1 ]]; then
  echo "--iterations must be a positive integer" >&2
  exit 2
fi

if [[ "$EXPECT" != "broken" && "$EXPECT" != "fixed" ]]; then
  echo "--expect must be broken or fixed" >&2
  exit 2
fi

TEST_BASENAME="ssh-explicit-pool-member-lease-stress.$$.repro.test.ts"
TEST_FILE="$ROOT/packages/execution-engine/src/__tests__/$TEST_BASENAME"

cleanup() {
  rm -f "$TEST_FILE"
}
trap cleanup EXIT

cat > "$TEST_FILE" <<'TS'
import { describe, expect, it, vi } from 'vitest';
import { TaskRunner } from '../task-runner.js';
import { SQLiteAdapter } from '@invoker/data-store';
import type { TaskState } from '@invoker/workflow-core';

const iterations = Number(process.env.INVOKER_REPRO_ITERATIONS ?? '1000');
const expectFixed = process.env.INVOKER_REPRO_EXPECT === 'fixed';

function makeTask(id: string): TaskState {
  return {
    id,
    description: id,
    status: 'pending',
    dependencies: [],
    createdAt: new Date(),
    config: {
      command: 'echo hi',
      runnerKind: 'ssh',
      poolId: 'ssh-pool',
      poolMemberId: 'remote-a',
    },
    execution: { selectedAttemptId: `${id}-attempt`, generation: 0 },
  } as TaskState;
}

function makeExecutor(workspacePath: string) {
  let complete: ((response: any) => void) | undefined;
  const executor = {
    type: 'ssh',
    start: vi.fn(async (request: any) => ({
      executionId: `exec-${request.actionId}`,
      taskId: request.actionId,
      workspacePath,
    })),
    onComplete: vi.fn((_handle: any, cb: any) => { complete = cb; }),
    onOutput: vi.fn(),
    onHeartbeat: vi.fn(),
    kill: vi.fn(),
    destroyAll: vi.fn(),
  };
  return {
    executor,
    complete(response: any) {
      complete?.(response);
    },
  };
}

function makeRunner(input: {
  adapter: SQLiteAdapter;
  task: TaskState;
  executor: any;
  deferTask: any;
}): TaskRunner {
  return new TaskRunner({
    orchestrator: {
      getTask: () => input.task,
      getAllTasks: () => [input.task],
      markTaskRunningAfterLaunch: () => true,
      handleWorkerResponse: () => [],
      deferTask: input.deferTask,
    } as any,
    persistence: {
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

async function completeRun(run: Promise<void>, task: TaskState, complete: (response: any) => void): Promise<void> {
  complete({
    requestId: 'req',
    actionId: task.id,
    attemptId: task.execution.selectedAttemptId,
    status: 'completed',
    outputs: { exitCode: 0 },
  });
  await run;
}

describe('explicit SSH pool member lease stress repro', () => {
  it(`keeps explicit poolMemberId executions exclusive for ${iterations} iteration(s)`, async () => {
    const failures: string[] = [];

    for (let i = 0; i < iterations; i += 1) {
      const adapter = await SQLiteAdapter.create(':memory:');
      try {
        const firstTask = makeTask(`wf-${i}-a/task`);
        const secondTask = makeTask(`wf-${i}-b/task`);
        const first = makeExecutor(`/remote/${i}/task-a`);
        const second = makeExecutor(`/remote/${i}/task-b`);
        const firstRunner = makeRunner({
          adapter,
          task: firstTask,
          executor: first.executor,
          deferTask: vi.fn(),
        });
        const deferTask = vi.fn();
        const secondRunner = makeRunner({
          adapter,
          task: secondTask,
          executor: second.executor,
          deferTask,
        });

        const firstRun = firstRunner.executeTask(firstTask);
        await vi.waitFor(() => expect(first.executor.start).toHaveBeenCalledTimes(1));

        const secondRun = secondRunner.executeTask(secondTask);
        await vi.waitFor(() => {
          expect(second.executor.start.mock.calls.length + deferTask.mock.calls.length).toBeGreaterThan(0);
        });

        const secondStarted = second.executor.start.mock.calls.length > 0;
        const secondDeferred = deferTask.mock.calls.length > 0;
        const activeLeases = adapter.listExecutionResourceLeases();

        if (expectFixed) {
          if (secondStarted || !secondDeferred) {
            failures.push(
              `iteration=${i} secondStarted=${secondStarted} secondDeferred=${secondDeferred} activeLeases=${activeLeases.length}`,
            );
          }
        } else if (!secondStarted || secondDeferred) {
          failures.push(
            `iteration=${i} expected broken behavior but got secondStarted=${secondStarted} secondDeferred=${secondDeferred}`,
          );
        }

        await completeRun(firstRun, firstTask, first.complete);
        if (secondStarted) {
          await completeRun(secondRun, secondTask, second.complete);
        } else {
          await secondRun;
        }
      } finally {
        adapter.close();
      }
    }

    expect(failures).toEqual([]);
  }, Math.max(20_000, iterations * 100));
});
TS

cd "$ROOT"
echo "repro: explicit SSH poolMemberId lease stress iterations=$ITERATIONS expect=$EXPECT"
INVOKER_REPRO_ITERATIONS="$ITERATIONS" \
INVOKER_REPRO_EXPECT="$EXPECT" \
  pnpm --filter @invoker/execution-engine exec vitest run "src/__tests__/$TEST_BASENAME"
