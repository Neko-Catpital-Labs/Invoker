import { describe, expect, it } from 'vitest';
import type { TaskState } from '@invoker/workflow-core';

import {
  isTaskInFlightForForcedStop,
  resolveTaskForForcedStop,
  type ForcedStopTaskStore,
} from '../forced-stop.js';

function makeTask(overrides: Partial<TaskState> = {}): TaskState {
  return {
    id: 'task-1',
    description: 'test task',
    status: 'running',
    dependencies: [],
    createdAt: new Date(),
    config: {},
    execution: {},
    ...overrides,
  } as TaskState;
}

describe('forced-stop task guard', () => {
  it('treats running, fixing, and pending-launching tasks as in-flight', () => {
    expect(isTaskInFlightForForcedStop(makeTask({ status: 'running' }))).toBe(true);
    expect(isTaskInFlightForForcedStop(makeTask({ status: 'fixing_with_ai' }))).toBe(true);
    expect(isTaskInFlightForForcedStop(makeTask({
      status: 'pending',
      execution: { phase: 'launching' },
    }))).toBe(true);

    expect(isTaskInFlightForForcedStop(makeTask({ status: 'pending', execution: {} }))).toBe(false);
    expect(isTaskInFlightForForcedStop(makeTask({ status: 'completed' }))).toBe(false);
    expect(isTaskInFlightForForcedStop(makeTask({ status: 'failed' }))).toBe(false);
  });

  it('skips force-failing a stale running snapshot when the persisted task completed', () => {
    const staleSnapshot = makeTask({
      status: 'running',
      execution: { generation: 0, selectedAttemptId: 'attempt-1' },
    });
    const store: ForcedStopTaskStore = {
      loadTask: () => makeTask({
        status: 'completed',
        execution: {
          generation: 0,
          selectedAttemptId: 'attempt-1',
          exitCode: 0,
          completedAt: new Date(),
        },
      }),
    };

    expect(resolveTaskForForcedStop(staleSnapshot, store)).toBeUndefined();
  });

  it('uses the latest persisted in-flight lineage for the forced stop response', () => {
    const staleSnapshot = makeTask({
      status: 'running',
      execution: { generation: 0, selectedAttemptId: 'attempt-1' },
    });
    const latest = makeTask({
      status: 'running',
      execution: { generation: 2, selectedAttemptId: 'attempt-3' },
    });
    const store: ForcedStopTaskStore = {
      loadTask: () => latest,
    };

    expect(resolveTaskForForcedStop(staleSnapshot, store)).toBe(latest);
  });

  it('falls back to the snapshot when the latest task read fails', () => {
    const snapshot = makeTask({ status: 'running' });
    const store: ForcedStopTaskStore = {
      loadTask: () => {
        throw new Error('db unavailable');
      },
    };

    expect(resolveTaskForForcedStop(snapshot, store)).toBe(snapshot);
  });
});
