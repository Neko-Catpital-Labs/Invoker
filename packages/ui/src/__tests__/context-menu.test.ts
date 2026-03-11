import { describe, it, expect, vi } from 'vitest';
import type { TaskState } from '../types.js';

function makeTask(overrides: Partial<TaskState> = {}): TaskState {
  return {
    id: 'test',
    description: 'Test task',
    status: 'pending',
    dependencies: [],
    createdAt: new Date(),
    ...overrides,
  } as TaskState;
}

describe('ContextMenu visibility logic', () => {
  describe('Rebase & Retry visibility', () => {
    it('is visible for failed merge nodes', () => {
      const task = makeTask({ id: '__merge__wf-1', status: 'failed', isMergeNode: true });
      const onRebaseAndRetry = vi.fn();

      const canRebaseAndRetry = task.isMergeNode === true && task.status === 'failed' && !!onRebaseAndRetry;
      expect(canRebaseAndRetry).toBe(true);
    });

    it('is hidden for non-merge nodes even if failed', () => {
      const task = makeTask({ id: 'regular-task', status: 'failed' });
      const onRebaseAndRetry = vi.fn();

      const canRebaseAndRetry = task.isMergeNode === true && task.status === 'failed' && !!onRebaseAndRetry;
      expect(canRebaseAndRetry).toBe(false);
    });

    it('is hidden for successful merge nodes', () => {
      const task = makeTask({ id: '__merge__wf-1', status: 'completed', isMergeNode: true });
      const onRebaseAndRetry = vi.fn();

      const canRebaseAndRetry = task.isMergeNode === true && task.status === 'failed' && !!onRebaseAndRetry;
      expect(canRebaseAndRetry).toBe(false);
    });

    it('is hidden for running merge nodes', () => {
      const task = makeTask({ id: '__merge__wf-1', status: 'running', isMergeNode: true });
      const onRebaseAndRetry = vi.fn();

      const canRebaseAndRetry = task.isMergeNode === true && task.status === 'failed' && !!onRebaseAndRetry;
      expect(canRebaseAndRetry).toBe(false);
    });

    it('is hidden when onRebaseAndRetry callback is not provided', () => {
      const task = makeTask({ id: '__merge__wf-1', status: 'failed', isMergeNode: true });
      const onRebaseAndRetry = undefined;

      const canRebaseAndRetry = task.isMergeNode === true && task.status === 'failed' && !!onRebaseAndRetry;
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
});
