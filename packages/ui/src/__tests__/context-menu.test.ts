import { describe, it, expect, vi } from 'vitest';
import type { TaskState } from '../types.js';

function makeTask(overrides: Partial<TaskState> & { workflowId?: string; isMergeNode?: boolean } = {}): TaskState {
  const { workflowId, isMergeNode, ...rest } = overrides;
  return {
    id: 'test',
    description: 'Test task',
    status: 'pending',
    dependencies: [],
    createdAt: new Date(),
    config: { workflowId, isMergeNode },
    execution: {},
    ...rest,
  } as TaskState;
}

describe('ContextMenu visibility logic', () => {
  describe('Rebase & Retry visibility', () => {
    it('is visible for any task with a workflowId when callback provided', () => {
      const task = makeTask({ id: 'regular-task', status: 'failed', workflowId: 'wf-1' });
      const onRebaseAndRetry = vi.fn();

      const canRebaseAndRetry = !!task.config.workflowId && !!onRebaseAndRetry;
      expect(canRebaseAndRetry).toBe(true);
    });

    it('is visible for merge nodes with a workflowId', () => {
      const task = makeTask({ id: '__merge__wf-1', status: 'failed', isMergeNode: true, workflowId: 'wf-1' });
      const onRebaseAndRetry = vi.fn();

      const canRebaseAndRetry = !!task.config.workflowId && !!onRebaseAndRetry;
      expect(canRebaseAndRetry).toBe(true);
    });

    it('is visible regardless of task status', () => {
      const onRebaseAndRetry = vi.fn();

      for (const status of ['pending', 'running', 'completed', 'failed'] as const) {
        const task = makeTask({ id: 'task-1', status, workflowId: 'wf-1' });
        const canRebaseAndRetry = !!task.config.workflowId && !!onRebaseAndRetry;
        expect(canRebaseAndRetry).toBe(true);
      }
    });

    it('is hidden for tasks without a workflowId', () => {
      const task = makeTask({ id: 'orphan-task', status: 'failed' });
      const onRebaseAndRetry = vi.fn();

      const canRebaseAndRetry = !!task.config.workflowId && !!onRebaseAndRetry;
      expect(canRebaseAndRetry).toBe(false);
    });

    it('is hidden when onRebaseAndRetry callback is not provided', () => {
      const task = makeTask({ id: 'task-1', status: 'failed', workflowId: 'wf-1' });
      const onRebaseAndRetry = undefined;

      const canRebaseAndRetry = !!task.config.workflowId && !!onRebaseAndRetry;
      expect(canRebaseAndRetry).toBe(false);
    });
  });

  describe('Restart visibility', () => {
    it('allows restart for non-running tasks', () => {
      const task = makeTask({ status: 'failed' });
      const canRestart = task.status !== 'running';
      expect(canRestart).toBe(true);
    });

    it('disables restart for running tasks', () => {
      const task = makeTask({ status: 'running' });
      const canRestart = task.status !== 'running';
      expect(canRestart).toBe(false);
    });
  });

  describe('Replace visibility', () => {
    it('allows replace for failed tasks', () => {
      const task = makeTask({ status: 'failed' });
      const canReplace = task.status === 'failed' || task.status === 'blocked';
      expect(canReplace).toBe(true);
    });

    it('allows replace for blocked tasks', () => {
      const task = makeTask({ status: 'blocked' });
      const canReplace = task.status === 'failed' || task.status === 'blocked';
      expect(canReplace).toBe(true);
    });

    it('disallows replace for running tasks', () => {
      const task = makeTask({ status: 'running' });
      const canReplace = task.status === 'failed' || task.status === 'blocked';
      expect(canReplace).toBe(false);
    });
  });

  describe('Restart Workflow visibility', () => {
    it('is visible for any node with a workflowId', () => {
      const task = makeTask({ id: 'regular-task', workflowId: 'wf-1' });
      const onRestartWorkflow = vi.fn();

      const canRestartWorkflow = !!task.config.workflowId && !!onRestartWorkflow;
      expect(canRestartWorkflow).toBe(true);
    });

    it('is visible for merge nodes with a workflowId', () => {
      const task = makeTask({ id: '__merge__wf-1', isMergeNode: true, workflowId: 'wf-1' });
      const onRestartWorkflow = vi.fn();

      const canRestartWorkflow = !!task.config.workflowId && !!onRestartWorkflow;
      expect(canRestartWorkflow).toBe(true);
    });

    it('is hidden when task has no workflowId', () => {
      const task = makeTask({ id: 'orphan-task' });
      const onRestartWorkflow = vi.fn();

      const canRestartWorkflow = !!task.config.workflowId && !!onRestartWorkflow;
      expect(canRestartWorkflow).toBe(false);
    });

    it('is hidden when onRestartWorkflow callback is not provided', () => {
      const task = makeTask({ id: 'task-1', workflowId: 'wf-1' });
      const onRestartWorkflow = undefined;

      const canRestartWorkflow = !!task.config.workflowId && !!onRestartWorkflow;
      expect(canRestartWorkflow).toBe(false);
    });

    it('is visible regardless of task status', () => {
      const onRestartWorkflow = vi.fn();

      for (const status of ['pending', 'running', 'completed', 'failed'] as const) {
        const task = makeTask({ id: 'task-1', status, workflowId: 'wf-1' });
        const canRestartWorkflow = !!task.config.workflowId && !!onRestartWorkflow;
        expect(canRestartWorkflow).toBe(true);
      }
    });
  });

  describe('Fix with Claude visibility', () => {
    it('is visible for failed task with command and callback', () => {
      const task = makeTask({ status: 'failed' }) as TaskState;
      (task as any).config.command = 'npm test';
      const onFixWithClaude = vi.fn();
      const hasMergeConflict = task.status === 'failed' && !!task.execution.mergeConflict;
      const canFixWithClaude = task.status === 'failed' && !hasMergeConflict && !!onFixWithClaude;
      expect(canFixWithClaude).toBe(true);
    });

    it('is visible for failed prompt-only task (no command)', () => {
      const task = makeTask({ status: 'failed' });
      const onFixWithClaude = vi.fn();
      const hasMergeConflict = task.status === 'failed' && !!task.execution.mergeConflict;
      const canFixWithClaude = task.status === 'failed' && !hasMergeConflict && !!onFixWithClaude;
      expect(canFixWithClaude).toBe(true);
    });

    it('is visible for failed merge gate node', () => {
      const task = makeTask({ status: 'failed', isMergeNode: true, workflowId: 'wf-1' });
      const onFixWithClaude = vi.fn();
      const hasMergeConflict = task.status === 'failed' && !!task.execution.mergeConflict;
      const canFixWithClaude = task.status === 'failed' && !hasMergeConflict && !!onFixWithClaude;
      expect(canFixWithClaude).toBe(true);
    });

    it('is hidden when task has merge conflict', () => {
      const task = makeTask({ status: 'failed', execution: { mergeConflict: { failedBranch: 'b', conflictFiles: ['f'] } } } as any);
      (task as any).config.command = 'npm test';
      const onFixWithClaude = vi.fn();
      const hasMergeConflict = task.status === 'failed' && !!task.execution.mergeConflict;
      const canFixWithClaude = task.status === 'failed' && !hasMergeConflict && !!onFixWithClaude;
      expect(canFixWithClaude).toBe(false);
    });

    it('is hidden for non-failed statuses', () => {
      const onFixWithClaude = vi.fn();
      for (const status of ['pending', 'running', 'completed', 'blocked'] as const) {
        const task = makeTask({ status });
        (task as any).config.command = 'npm test';
        const hasMergeConflict = task.status === 'failed' && !!task.execution.mergeConflict;
        const canFixWithClaude = task.status === 'failed' && !hasMergeConflict && !!onFixWithClaude;
        expect(canFixWithClaude).toBe(false);
      }
    });

    it('is hidden when onFixWithClaude callback is not provided', () => {
      const task = makeTask({ status: 'failed' });
      (task as any).config.command = 'npm test';
      const onFixWithClaude = undefined;
      const hasMergeConflict = task.status === 'failed' && !!task.execution.mergeConflict;
      const canFixWithClaude = task.status === 'failed' && !hasMergeConflict && !!onFixWithClaude;
      expect(canFixWithClaude).toBe(false);
    });
  });

  describe('Delete Workflow visibility', () => {
    it('is visible for any node with a workflowId', () => {
      const task = makeTask({ id: 'regular-task', workflowId: 'wf-1' });
      const onDeleteWorkflow = vi.fn();

      const canDeleteWorkflow = !!task.config.workflowId && !!onDeleteWorkflow;
      expect(canDeleteWorkflow).toBe(true);
    });

    it('is visible for merge nodes with a workflowId', () => {
      const task = makeTask({ id: '__merge__wf-1', isMergeNode: true, workflowId: 'wf-1' });
      const onDeleteWorkflow = vi.fn();

      const canDeleteWorkflow = !!task.config.workflowId && !!onDeleteWorkflow;
      expect(canDeleteWorkflow).toBe(true);
    });

    it('is hidden when task has no workflowId', () => {
      const task = makeTask({ id: 'orphan-task' });
      const onDeleteWorkflow = vi.fn();

      const canDeleteWorkflow = !!task.config.workflowId && !!onDeleteWorkflow;
      expect(canDeleteWorkflow).toBe(false);
    });

    it('is hidden when onDeleteWorkflow callback is not provided', () => {
      const task = makeTask({ id: 'task-1', workflowId: 'wf-1' });
      const onDeleteWorkflow = undefined;

      const canDeleteWorkflow = !!task.config.workflowId && !!onDeleteWorkflow;
      expect(canDeleteWorkflow).toBe(false);
    });

    it('is visible regardless of task status', () => {
      const onDeleteWorkflow = vi.fn();

      for (const status of ['pending', 'running', 'completed', 'failed'] as const) {
        const task = makeTask({ id: 'task-1', status, workflowId: 'wf-1' });
        const canDeleteWorkflow = !!task.config.workflowId && !!onDeleteWorkflow;
        expect(canDeleteWorkflow).toBe(true);
      }
    });
  });
});
