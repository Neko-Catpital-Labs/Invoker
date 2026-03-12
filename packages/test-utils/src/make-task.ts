import type { TaskState } from '@invoker/core';

/**
 * Create a TaskState with sensible defaults. Override any field.
 */
export function makeTask(overrides: Partial<TaskState> = {}): TaskState {
  return {
    id: 'task-1',
    description: 'Test task',
    status: 'pending',
    dependencies: [],
    createdAt: new Date(),
    config: {},
    execution: {},
    ...overrides,
  } as TaskState;
}
