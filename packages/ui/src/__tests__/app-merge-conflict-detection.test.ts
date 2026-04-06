import { describe, it, expect } from 'vitest';
import type { TaskState } from '../types.js';
import { hasMergeConflictExecution } from '../App.js';

function makeTask(overrides: Partial<TaskState> = {}): TaskState {
  return {
    id: 'wf-1/task-a',
    description: 'task',
    status: 'failed',
    dependencies: [],
    createdAt: new Date(),
    config: {},
    execution: {},
    ...overrides,
  };
}

describe('hasMergeConflictExecution', () => {
  it('returns true when execution.mergeConflict exists', () => {
    const task = makeTask({
      execution: { mergeConflict: { failedBranch: 'exp/a', conflictFiles: ['a.txt'] } },
    });
    expect(hasMergeConflictExecution(task)).toBe(true);
  });

  it('returns true when execution.error is merge_conflict JSON', () => {
    const task = makeTask({
      execution: {
        error: JSON.stringify({
          type: 'merge_conflict',
          failedBranch: 'exp/b',
          conflictFiles: ['b.txt'],
        }),
      },
    });
    expect(hasMergeConflictExecution(task)).toBe(true);
  });

  it('returns false for non-JSON or non-merge errors', () => {
    expect(hasMergeConflictExecution(makeTask({ execution: { error: 'plain failure' } }))).toBe(false);
    expect(hasMergeConflictExecution(makeTask({ execution: { error: '{"type":"other"}' } }))).toBe(false);
  });
});
