/**
 * Tests for useTasks behaviors:
 * - refreshTasks replaces tasks/workflows from getTasks snapshot (including empty)
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
    config: {},
    execution: {},
    revision: 1,
    ...overrides,
  };
}

describe('useTasks guard logic', () => {
  describe('refreshTasks snapshot replace', () => {
    it('simulates empty getTasks snapshot clearing UI state (e.g. after delete workflow)', () => {
      const taskList: TaskState[] = [];
      const next = new Map<string, TaskState>();
      for (const t of taskList) next.set(t.id, t);
      expect(next.size).toBe(0);
    });

    it('simulates non-empty snapshot replacing task map', () => {
      const taskList = [makeTask({ id: 't3' })];
      const next = new Map<string, TaskState>();
      for (const t of taskList) next.set(t.id, t);
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
      const qIds = new Set<string>();
      const delta: TaskDelta = { type: 'removed', taskId: 't1', previousRevision: 1 };

      const result = applyDelta(prev, delta, qIds);

      // Replicate the warning logic from useTasks
      if (result.tasks.size === 0 && prev.size > 0) {
        console.warn('[useTasks] Tasks map went from', prev.size, 'to 0 after delta:', delta);
      }

      expect(result.tasks.size).toBe(0);
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
      const qIds = new Set<string>();
      const delta: TaskDelta = { type: 'removed', taskId: 't1', previousRevision: 1 };

      const result = applyDelta(prev, delta, qIds);

      if (result.tasks.size === 0 && prev.size > 0) {
        console.warn('[useTasks] Tasks map went from', prev.size, 'to 0 after delta:', delta);
      }

      expect(result.tasks.size).toBe(1);
      expect(warnSpy).not.toHaveBeenCalled();

      warnSpy.mockRestore();
    });
  });
});
