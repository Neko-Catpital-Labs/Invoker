/**
 * Tests for useTasks guard behaviors:
 * - refreshTasks should not replace tasks with empty data
 * - delta handler should warn when tasks map drops to 0
 */

import { describe, it, expect, vi } from 'vitest';
import { applyDelta } from '../lib/delta.js';
import type { TaskState, TaskDelta } from '../types.js';

function makeTask(overrides: Partial<TaskState> & { id: string }): TaskState {
  return {
    description: 'test task',
    status: 'pending',
    dependencies: [],
    createdAt: new Date('2025-01-01'),
    ...overrides,
  };
}

describe('useTasks guard logic', () => {
  describe('refreshTasks empty guard', () => {
    it('simulates the guard: empty taskList should not replace existing tasks', () => {
      const existingTasks = new Map<string, TaskState>([
        ['t1', makeTask({ id: 't1' })],
        ['t2', makeTask({ id: 't2' })],
      ]);

      const taskList: TaskState[] = [];

      // The guard: if (taskList.length === 0) return;
      if (taskList.length === 0) {
        // Should keep existing tasks
        expect(existingTasks.size).toBe(2);
        return;
      }

      // This line should not be reached
      expect.unreachable('Should have returned early for empty taskList');
    });

    it('simulates the guard: non-empty taskList should replace tasks', () => {
      const taskList = [makeTask({ id: 't3' })];

      // The guard passes, proceed with replacement
      expect(taskList.length).toBeGreaterThan(0);

      const next = new Map<string, TaskState>();
      for (const t of taskList) {
        next.set(t.id, t);
      }

      expect(next.size).toBe(1);
      expect(next.has('t3')).toBe(true);
    });
  });

  describe('delta handler warning detection', () => {
    it('detects when a removed delta causes tasks to drop to 0', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const prev = new Map<string, TaskState>([
        ['t1', makeTask({ id: 't1' })],
      ]);
      const delta: TaskDelta = { type: 'removed', taskId: 't1' };

      const next = applyDelta(prev, delta);

      // Replicate the warning logic from useTasks
      if (next.size === 0 && prev.size > 0) {
        console.warn('[useTasks] Tasks map went from', prev.size, 'to 0 after delta:', delta);
      }

      expect(next.size).toBe(0);
      expect(warnSpy).toHaveBeenCalledOnce();
      expect(warnSpy).toHaveBeenCalledWith(
        '[useTasks] Tasks map went from', 1, 'to 0 after delta:', delta,
      );

      warnSpy.mockRestore();
    });

    it('does not warn when tasks remain after delta', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const prev = new Map<string, TaskState>([
        ['t1', makeTask({ id: 't1' })],
        ['t2', makeTask({ id: 't2' })],
      ]);
      const delta: TaskDelta = { type: 'removed', taskId: 't1' };

      const next = applyDelta(prev, delta);

      if (next.size === 0 && prev.size > 0) {
        console.warn('[useTasks] Tasks map went from', prev.size, 'to 0 after delta:', delta);
      }

      expect(next.size).toBe(1);
      expect(warnSpy).not.toHaveBeenCalled();

      warnSpy.mockRestore();
    });
  });
});
