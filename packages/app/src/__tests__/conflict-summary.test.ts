import { describe, it, expect } from 'vitest';
import { formatTaskStatus, serializeTask } from '../formatter.js';
import type { TaskState } from '@invoker/workflow-core';

function makeTask(overrides: Partial<TaskState> = {}): TaskState {
  return {
    id: 'wf-1/task-a',
    description: 'Merge upstream',
    status: 'failed',
    dependencies: [],
    createdAt: new Date('2024-01-01T00:00:00Z'),
    config: { workflowId: 'wf-1', executorType: 'worktree' } as any,
    execution: {},
    ...overrides,
  } as TaskState;
}

describe('conflict summary in task output', () => {
  describe('formatTaskStatus', () => {
    it('shows conflicting files when mergeConflict is present', () => {
      const task = makeTask({
        execution: {
          mergeConflict: {
            failedBranch: 'invoker/task-a',
            conflictFiles: ['src/config.ts', 'src/main.ts'],
          },
        } as any,
      });
      const output = formatTaskStatus(task);
      expect(output).toContain('src/config.ts');
      expect(output).toContain('src/main.ts');
    });

    it('omits conflict suffix when no mergeConflict', () => {
      const task = makeTask({ execution: {} as any });
      const output = formatTaskStatus(task);
      expect(output).not.toContain('conflict');
    });

    it('shows all conflicting files joined by comma', () => {
      const task = makeTask({
        execution: {
          mergeConflict: {
            failedBranch: 'invoker/task-a',
            conflictFiles: ['a.ts', 'b.ts', 'c.ts'],
          },
        } as any,
      });
      const output = formatTaskStatus(task);
      expect(output).toContain('a.ts, b.ts, c.ts');
    });
  });

  describe('serializeTask', () => {
    it('includes mergeConflict in execution when present', () => {
      const task = makeTask({
        execution: {
          mergeConflict: {
            failedBranch: 'invoker/task-a',
            conflictFiles: ['src/config.ts'],
          },
        } as any,
      });
      const result = serializeTask(task);
      const exec = result.execution as Record<string, unknown>;
      expect(exec.mergeConflict).toEqual({
        failedBranch: 'invoker/task-a',
        conflictFiles: ['src/config.ts'],
      });
    });

    it('omits mergeConflict from execution when not present', () => {
      const task = makeTask({ execution: {} as any });
      const result = serializeTask(task);
      const exec = result.execution as Record<string, unknown>;
      expect(exec.mergeConflict).toBeUndefined();
    });

    it('serializes conflictFiles as a plain array', () => {
      const task = makeTask({
        execution: {
          mergeConflict: {
            failedBranch: 'invoker/task-a',
            conflictFiles: ['x.ts', 'y.ts'],
          },
        } as any,
      });
      const result = serializeTask(task);
      const exec = result.execution as Record<string, unknown>;
      const mc = exec.mergeConflict as Record<string, unknown>;
      expect(Array.isArray(mc.conflictFiles)).toBe(true);
      expect(mc.conflictFiles).toEqual(['x.ts', 'y.ts']);
    });
  });
});
