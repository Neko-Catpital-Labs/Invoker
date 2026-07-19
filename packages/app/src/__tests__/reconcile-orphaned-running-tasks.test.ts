import { describe, expect, it, vi } from 'vitest';
import type { TaskState } from '@invoker/workflow-core';

import {
  isTaskInFlightForForcedStop,
  reconcileOrphanedInFlightTasksOnBoot,
} from '../reconcile-orphaned-running-tasks.js';

function makeTask(
  id: string,
  status: TaskState['status'],
  execution: TaskState['execution'] = {},
): TaskState {
  return {
    id,
    description: id,
    status,
    dependencies: [],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    config: { workflowId: 'wf-1' },
    execution: { generation: 3, selectedAttemptId: 'attempt-1', ...execution },
    taskStateVersion: 1,
  } as TaskState;
}

describe('reconcileOrphanedInFlightTasksOnBoot', () => {
  it('treats running, fixing_with_ai, and launching pending or queued tasks as in-flight', () => {
    expect(isTaskInFlightForForcedStop(makeTask('a', 'running'))).toBe(true);
    expect(isTaskInFlightForForcedStop(makeTask('b', 'fixing_with_ai'))).toBe(true);
    expect(isTaskInFlightForForcedStop(makeTask('c', 'pending', { phase: 'launching' }))).toBe(true);
    expect(isTaskInFlightForForcedStop(makeTask('d', 'queued' as TaskState['status'], { phase: 'launching' }))).toBe(true);
    expect(isTaskInFlightForForcedStop(makeTask('e', 'pending'))).toBe(false);
    expect(isTaskInFlightForForcedStop(makeTask('f', 'completed'))).toBe(false);
    expect(isTaskInFlightForForcedStop(makeTask('g', 'running', {
      crashPreservedAt: new Date('2026-07-13T01:02:03.000Z'),
    }))).toBe(false);
  });

  it('fails orphaned in-flight tasks with Application quit and writes a diagnostic', () => {
    const running = makeTask('wf-1/slow-task', 'running');
    const pending = makeTask('wf-1/ready', 'pending');
    const handleWorkerResponse = vi.fn();
    const appendTaskOutput = vi.fn();
    const getOutputTail = vi.fn(() => []);

    const failed = reconcileOrphanedInFlightTasksOnBoot({
      orchestrator: {
        getAllTasks: () => [running, pending],
        handleWorkerResponse,
      },
      persistence: { getOutputTail, appendTaskOutput },
    });

    expect(failed.map((task) => task.id)).toEqual(['wf-1/slow-task']);
    expect(handleWorkerResponse).toHaveBeenCalledTimes(1);
    expect(handleWorkerResponse).toHaveBeenCalledWith({
      requestId: 'boot-orphan-wf-1/slow-task',
      actionId: 'wf-1/slow-task',
      attemptId: 'attempt-1',
      executionGeneration: 3,
      status: 'failed',
      outputs: { exitCode: 1, error: 'Application quit' },
    });
    expect(appendTaskOutput).toHaveBeenCalledTimes(1);
    expect(String(appendTaskOutput.mock.calls[0]?.[1] ?? '')).toContain('Startup Orphan Diagnostic');
    expect(String(appendTaskOutput.mock.calls[0]?.[1] ?? '')).toContain('forcedStopReason=Application quit');
  });
});
