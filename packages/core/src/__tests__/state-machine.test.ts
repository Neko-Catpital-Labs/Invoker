import { describe, it, expect, beforeEach } from 'vitest';
import { TaskStateMachine } from '../state-machine.js';
import type { TaskState } from '../task-types.js';

function makeTask(
  id: string,
  deps: string[] = [],
  status: TaskState['status'] = 'pending',
  extra: Partial<TaskState> = {},
): TaskState {
  return {
    id,
    description: `Task ${id}`,
    status,
    dependencies: deps,
    createdAt: new Date(),
    ...extra,
  };
}

describe('TaskStateMachine', () => {
  let sm: TaskStateMachine;

  beforeEach(() => {
    sm = new TaskStateMachine();
  });

  // ── API surface guardrail ──────────────────────────────

  describe('API surface (read-only)', () => {
    it('exposes read queries and sync methods', () => {
      expect(typeof sm.getTask).toBe('function');
      expect(typeof sm.getAllTasks).toBe('function');
      expect(typeof sm.getReadyTasks).toBe('function');
      expect(typeof sm.getTaskCount).toBe('function');
      expect(typeof sm.findNewlyReadyTasks).toBe('function');
      expect(typeof sm.computeTasksToBlock).toBe('function');
      expect(typeof sm.computeTasksToUnblock).toBe('function');
      expect(typeof sm.restoreTask).toBe('function');
      expect(typeof sm.clear).toBe('function');
    });

    it('does not expose mutation methods', () => {
      expect((sm as any).startTask).toBeUndefined();
      expect((sm as any).completeTask).toBeUndefined();
      expect((sm as any).failTask).toBeUndefined();
      expect((sm as any).createTask).toBeUndefined();
      expect((sm as any).updateTaskFields).toBeUndefined();
      expect((sm as any).restartTask).toBeUndefined();
      expect((sm as any).markStale).toBeUndefined();
      expect((sm as any).approveTask).toBeUndefined();
      expect((sm as any).rejectTask).toBeUndefined();
      expect((sm as any).pauseForInput).toBeUndefined();
      expect((sm as any).resumeWithInput).toBeUndefined();
      expect((sm as any).requestApproval).toBeUndefined();
      expect((sm as any).triggerReconciliation).toBeUndefined();
      expect((sm as any).completeReconciliation).toBeUndefined();
      expect((sm as any).removeTask).toBeUndefined();
      expect((sm as any).rewriteDependency).toBeUndefined();
    });
  });

  // ── restoreTask + getTask ──────────────────────────────

  describe('restoreTask + getTask', () => {
    it('inserts and retrieves a task', () => {
      sm.restoreTask(makeTask('t1'));
      const task = sm.getTask('t1');
      expect(task).toBeDefined();
      expect(task!.id).toBe('t1');
    });

    it('returns undefined for missing task', () => {
      expect(sm.getTask('missing')).toBeUndefined();
    });
  });

  // ── getAllTasks ─────────────────────────────────────────

  describe('getAllTasks', () => {
    it('returns all restored tasks', () => {
      sm.restoreTask(makeTask('a'));
      sm.restoreTask(makeTask('b'));
      sm.restoreTask(makeTask('c'));
      expect(sm.getAllTasks()).toHaveLength(3);
    });

    it('returns empty for fresh state machine', () => {
      expect(sm.getAllTasks()).toEqual([]);
    });
  });

  // ── getReadyTasks ──────────────────────────────────────

  describe('getReadyTasks', () => {
    it('returns pending tasks with all deps completed', () => {
      sm.restoreTask(makeTask('a', [], 'completed'));
      sm.restoreTask(makeTask('b', ['a'], 'pending'));
      sm.restoreTask(makeTask('c', ['a'], 'running'));

      const ready = sm.getReadyTasks();
      expect(ready.map(t => t.id)).toEqual(['b']);
    });

    it('returns tasks with no dependencies', () => {
      sm.restoreTask(makeTask('x', [], 'pending'));
      sm.restoreTask(makeTask('y', [], 'pending'));

      const ready = sm.getReadyTasks();
      expect(ready).toHaveLength(2);
    });

    it('does not return tasks with incomplete deps', () => {
      sm.restoreTask(makeTask('a', [], 'running'));
      sm.restoreTask(makeTask('b', ['a'], 'pending'));

      expect(sm.getReadyTasks()).toEqual([]);
    });
  });

  // ── findNewlyReadyTasks ────────────────────────────────

  describe('findNewlyReadyTasks', () => {
    it('returns dependents of completed task whose all deps are completed', () => {
      sm.restoreTask(makeTask('a', [], 'completed'));
      sm.restoreTask(makeTask('b', [], 'completed'));
      sm.restoreTask(makeTask('c', ['a', 'b'], 'pending'));

      const ready = sm.findNewlyReadyTasks('b');
      expect(ready).toEqual(['c']);
    });

    it('does not return tasks with still-pending deps', () => {
      sm.restoreTask(makeTask('a', [], 'completed'));
      sm.restoreTask(makeTask('b', [], 'running'));
      sm.restoreTask(makeTask('c', ['a', 'b'], 'pending'));

      const ready = sm.findNewlyReadyTasks('a');
      expect(ready).toEqual([]);
    });

    it('returns empty when no dependents exist', () => {
      sm.restoreTask(makeTask('solo', [], 'completed'));
      expect(sm.findNewlyReadyTasks('solo')).toEqual([]);
    });

    it('skips non-pending tasks', () => {
      sm.restoreTask(makeTask('a', [], 'completed'));
      sm.restoreTask(makeTask('b', ['a'], 'running'));

      expect(sm.findNewlyReadyTasks('a')).toEqual([]);
    });
  });

  // ── computeTasksToBlock ────────────────────────────────

  describe('computeTasksToBlock', () => {
    it('returns direct dependents of failed task', () => {
      sm.restoreTask(makeTask('failed', [], 'failed'));
      sm.restoreTask(makeTask('child', ['failed'], 'pending'));

      const blocked = sm.computeTasksToBlock('failed');
      expect(blocked).toEqual(['child']);
    });

    it('returns transitive dependents via BFS', () => {
      sm.restoreTask(makeTask('root', [], 'failed'));
      sm.restoreTask(makeTask('mid', ['root'], 'pending'));
      sm.restoreTask(makeTask('leaf', ['mid'], 'pending'));

      const blocked = sm.computeTasksToBlock('root');
      expect(blocked).toContain('mid');
      expect(blocked).toContain('leaf');
      expect(blocked).toHaveLength(2);
    });

    it('skips running and completed tasks', () => {
      sm.restoreTask(makeTask('failed', [], 'failed'));
      sm.restoreTask(makeTask('running', ['failed'], 'running'));
      sm.restoreTask(makeTask('done', ['failed'], 'completed'));
      sm.restoreTask(makeTask('pending', ['failed'], 'pending'));

      const blocked = sm.computeTasksToBlock('failed');
      expect(blocked).toEqual(['pending']);
    });

    it('returns empty when no dependents', () => {
      sm.restoreTask(makeTask('isolated', [], 'failed'));
      expect(sm.computeTasksToBlock('isolated')).toEqual([]);
    });
  });

  // ── computeTasksToUnblock ──────────────────────────────

  describe('computeTasksToUnblock', () => {
    it('returns tasks blocked by the given task', () => {
      sm.restoreTask(makeTask('t1', [], 'pending'));
      sm.restoreTask(makeTask('t2', ['t1'], 'blocked', { blockedBy: 't1' }));
      sm.restoreTask(makeTask('t3', ['t1'], 'blocked', { blockedBy: 't1' }));

      const unblocked = sm.computeTasksToUnblock('t1');
      expect(unblocked.sort()).toEqual(['t2', 't3']);
    });

    it('does not return tasks blocked by a different task', () => {
      sm.restoreTask(makeTask('a', [], 'failed'));
      sm.restoreTask(makeTask('b', [], 'failed'));
      sm.restoreTask(makeTask('c', ['a'], 'blocked', { blockedBy: 'a' }));
      sm.restoreTask(makeTask('d', ['b'], 'blocked', { blockedBy: 'b' }));

      expect(sm.computeTasksToUnblock('a')).toEqual(['c']);
      expect(sm.computeTasksToUnblock('b')).toEqual(['d']);
    });

    it('returns empty when nothing is blocked', () => {
      sm.restoreTask(makeTask('t1', [], 'completed'));
      expect(sm.computeTasksToUnblock('t1')).toEqual([]);
    });
  });

  // ── clear ──────────────────────────────────────────────

  describe('clear', () => {
    it('removes all tasks', () => {
      sm.restoreTask(makeTask('a'));
      sm.restoreTask(makeTask('b'));
      sm.clear();
      expect(sm.getAllTasks()).toEqual([]);
      expect(sm.getTaskCount()).toBe(0);
    });
  });
});
