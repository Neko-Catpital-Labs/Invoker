#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TEST_FILE="$ROOT_DIR/packages/execution-engine/src/__tests__/slow-start-stale-generation-guard.repro.test.ts"
EXPECTATION=""

usage() {
  cat <<'EOF'
Usage:
  bash scripts/repro/repro-slow-start-stale-generation-guard.sh --expect bug|fixed

What it proves:
  A slow executor.start() (remote provisioning can take minutes) can resolve
  AFTER recreate-task has advanced the live task to a newer generation while
  keeping the same selectedAttemptId. Without the post-start generation guard,
  that stale launch persists workspace/branch/session metadata and registers an
  active execution over the live attempt now at N+1. The guard validates the
  launch-time generation, so a stale generation is never marked running: the
  spawned handle is killed, no metadata is written, and a
  `task.executor.stale_post_start` diagnostic is logged.

Exit codes:
  0  observed behavior matches --expect
  1  observed behavior does not match --expect
  2  repro setup or assertion was invalid / unexpected
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --expect)
      EXPECTATION="${2:-}"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "repro: unknown arg: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ "$EXPECTATION" != "bug" && "$EXPECTATION" != "fixed" ]]; then
  echo "repro: --expect requires bug|fixed" >&2
  usage >&2
  exit 2
fi

cleanup() {
  rm -f "$TEST_FILE"
}
trap cleanup EXIT

cat > "$TEST_FILE" <<'TS'
import { describe, expect, it, vi } from 'vitest';
import { TaskRunner } from '../task-runner.js';
import type { TaskState } from '@invoker/workflow-core';

// Models a slow startup: executor.start() returns a promise that does NOT
// resolve until the test calls resolveStart(), standing in for minutes-long
// remote/SSH provisioning. While that start is in flight, recreate-task
// advances the live task's generation (N -> N+1) while keeping the same
// selectedAttemptId.
describe('slow-start stale-generation post-start guard repro', () => {
  it('never marks a slow start running once the generation has advanced', async () => {
    const handle = {
      executionId: 'exec-slow-start',
      taskId: 'slow-task',
      workspacePath: '/remote/worktrees/slow-task',
      branch: 'experiment/slow-task',
      agentSessionId: 'sess-slow-start',
      containerId: 'container-slow-start',
    };

    let resolveStart: (() => void) | undefined;
    const executor = {
      type: 'worktree',
      start: vi.fn(() => new Promise((res) => { resolveStart = () => res(handle); })),
      onComplete: vi.fn(),
      onOutput: vi.fn(),
      onHeartbeat: vi.fn(),
      kill: vi.fn().mockResolvedValue(undefined),
      destroyAll: vi.fn(),
    };

    // The live task the orchestrator sees; its generation is mutated mid-start.
    const liveTask: TaskState = {
      id: 'slow-task',
      description: 'Slow startup task',
      status: 'running',
      dependencies: [],
      createdAt: new Date(),
      config: { command: 'echo hi', runnerKind: 'worktree' },
      execution: { selectedAttemptId: 'attempt-1', generation: 1 },
    } as TaskState;

    const markTaskRunningAfterLaunch = vi.fn(() => true);
    const handleWorkerResponse = vi.fn(() => []);
    const updateTask = vi.fn();
    const updateAttempt = vi.fn();
    const logEvent = vi.fn();
    const onSpawned = vi.fn();

    const runner = new TaskRunner({
      orchestrator: {
        getTask: () => liveTask,
        getAllTasks: () => [liveTask],
        markTaskRunningAfterLaunch,
        handleWorkerResponse,
      } as any,
      persistence: {
        updateTask,
        updateAttempt,
        logEvent,
        loadAttempts: () => [],
        appendTaskOutput: vi.fn(),
      } as any,
      executorRegistry: {
        getDefault: () => executor,
        get: () => executor,
        getAll: () => [executor],
      } as any,
      cwd: '/tmp',
      callbacks: { onSpawned },
    });

    // Launch is accepted at generation 1.
    const launchTask: TaskState = {
      id: 'slow-task',
      description: 'Slow startup task',
      status: 'running',
      dependencies: [],
      createdAt: new Date(),
      config: { command: 'echo hi', runnerKind: 'worktree' },
      execution: { selectedAttemptId: 'attempt-1', generation: 1 },
    } as TaskState;

    const run = runner.executeTask(launchTask);
    // Don't surface a rejection if the launch is torn down; we assert on the
    // observable side effects, not on how the promise settles.
    run.catch(() => {});
    await vi.waitFor(() => expect(executor.start).toHaveBeenCalledTimes(1));

    // recreate-task advances the generation while the slow start is in flight.
    liveTask.execution.generation = 2;

    // Slow provisioning finally returns its handle, at the stale generation.
    resolveStart?.();

    // Wait until the post-start path settles in EITHER outcome: the fix kills
    // the handle and returns; the bug marks the launch running. Never await
    // `run` — in the bug case the accepted launch leaves it pending on a
    // completion that never fires (a 20s timeout instead of a fast assertion).
    await vi.waitFor(() => {
      const settled =
        executor.kill.mock.calls.length > 0 || markTaskRunningAfterLaunch.mock.calls.length > 0;
      expect(settled).toBe(true);
    });

    // A stale generation must never be marked running.
    expect(markTaskRunningAfterLaunch).not.toHaveBeenCalled();
    // The spawned handle is killed.
    expect(executor.kill).toHaveBeenCalledWith(handle);
    // No stale workspace metadata is persisted to the task or attempt row.
    expect(updateTask).not.toHaveBeenCalledWith(
      'slow-task',
      expect.objectContaining({
        execution: expect.objectContaining({ workspacePath: '/remote/worktrees/slow-task' }),
      }),
    );
    expect(updateAttempt).not.toHaveBeenCalledWith(
      'attempt-1',
      expect.objectContaining({ workspacePath: '/remote/worktrees/slow-task' }),
    );
    // No active execution is registered and no completion is processed.
    expect((runner as any).activeExecutions.size).toBe(0);
    expect(onSpawned).not.toHaveBeenCalled();
    expect(handleWorkerResponse).not.toHaveBeenCalled();
    // A diagnostic records the stale launch-time vs live generation.
    expect(logEvent).toHaveBeenCalledWith(
      'slow-task',
      'task.executor.stale_post_start',
      expect.objectContaining({ startGeneration: 1, currentGeneration: 2 }),
    );
  });
});
TS

cd "$ROOT_DIR"

set +e
pnpm --filter @invoker/execution-engine exec vitest run \
  --reporter verbose \
  "$TEST_FILE"
STATUS=$?
set -e

if [[ "$STATUS" -eq 0 ]]; then
  OBSERVED="fixed"
else
  OBSERVED="bug"
fi

echo "slow_start_stale_generation_exit     : $STATUS"
echo "slow_start_stale_generation_observed : $OBSERVED"
echo "expected                             : $EXPECTATION"

if [[ "$OBSERVED" != "$EXPECTATION" ]]; then
  exit 1
fi

echo "==> repro matched expectation"
