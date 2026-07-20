import { describe, expect, it, vi } from 'vitest';
import { createTaskState, type TaskState } from '@invoker/workflow-core';
import type { PersistenceAdapter } from '@invoker/data-store';
import { preserveCrashedInFlightTasks } from '../crash-preserved-tasks.js';

function makeTask(id: string, status: TaskState['status'], execution: Partial<TaskState['execution']> = {}): TaskState {
  return {
    ...createTaskState(id, id, []),
    status,
    execution: {
      generation: 0,
      ...execution,
    },
  };
}

describe('preserveCrashedInFlightTasks', () => {
  it('marks only in-flight tasks and leaves terminal ones unchanged', () => {
    const updateTask = vi.fn();
    const logEvent = vi.fn();
    const persistence = {
      updateTask,
      logEvent,
    } as unknown as PersistenceAdapter;
    const preservedAt = new Date('2026-07-13T01:02:03.000Z');

    const preserved = preserveCrashedInFlightTasks(
      persistence,
      [
        makeTask('running-task', 'running', { phase: 'executing' }),
        makeTask('launching-task', 'pending', { phase: 'launching' }),
        makeTask('done-task', 'completed'),
      ],
      { pid: 46301, diagnostic: null },
      preservedAt,
    );

    expect(preserved).toEqual(['running-task', 'launching-task']);
    expect(updateTask).toHaveBeenCalledTimes(2);
    expect(updateTask).toHaveBeenNthCalledWith(1, 'running-task', {
      execution: expect.objectContaining({
        crashPreservedAt: preservedAt,
        crashPreservedOwnerPid: 46301,
      }),
    });
    expect(logEvent).toHaveBeenCalledWith('running-task', 'task.crash_preserved', expect.objectContaining({
      previousOwnerPid: 46301,
    }));
  });

  it('does not overwrite an already preserved task on later boots', () => {
    const updateTask = vi.fn();
    const persistence = {
      updateTask,
      logEvent: vi.fn(),
    } as unknown as PersistenceAdapter;

    const preserved = preserveCrashedInFlightTasks(
      persistence,
      [makeTask('running-task', 'running', {
        phase: 'executing',
        crashPreservedAt: new Date('2026-07-13T00:00:00.000Z'),
      })],
      { pid: 46301, diagnostic: null },
      new Date('2026-07-13T01:02:03.000Z'),
    );

    expect(preserved).toEqual([]);
    expect(updateTask).not.toHaveBeenCalled();
  });
});
