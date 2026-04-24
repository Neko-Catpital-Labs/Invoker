import { describe, it, expect, beforeEach } from 'vitest';
import { TaskStateMachine } from '../state-machine.js';
import type { TaskState, TaskConfig, TaskExecution } from '../task-types.js';

function makeTask(
  id: string,
  deps: string[] = [],
  status: TaskState['status'] = 'pending',
  extra: { config?: Partial<TaskConfig>; execution?: Partial<TaskExecution> } = {},
): TaskState {
  return {
    id,
    description: `Task ${id}`,
    status,
    dependencies: deps,
    createdAt: new Date(),
    config: { ...extra.config },
    execution: { ...extra.execution },
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
      expect(typeof sm.restoreTask).toBe('function');
      expect(typeof sm.clear).toBe('function');
    });

    it('does not expose mutation methods', () => {
      expect((sm as any).startTask).toBeUndefined();
      expect((sm as any).completeTask).toBeUndefined();
      expect((sm as any).failTask).toBeUndefined();
      expect((sm as any).createTask).toBeUndefined();
      expect((sm as any).updateTaskFields).toBeUndefined();
      expect((sm as any).retryTask).toBeUndefined();
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

    it('treats failed deps as settled for reconciliation tasks', () => {
      sm.restoreTask(makeTask('exp1', [], 'failed'));
      sm.restoreTask(makeTask('exp2', [], 'completed'));
      sm.restoreTask(
        makeTask('recon', ['exp1', 'exp2'], 'pending', {
          config: { isReconciliation: true },
        }),
      );

      expect(sm.findNewlyReadyTasks('exp2')).toEqual(['recon']);
    });

    it('does not unblock normal tasks when a dependency failed', () => {
      sm.restoreTask(makeTask('exp1', [], 'failed'));
      sm.restoreTask(makeTask('exp2', [], 'completed'));
      sm.restoreTask(makeTask('downstream', ['exp1', 'exp2'], 'pending'));

      expect(sm.findNewlyReadyTasks('exp2')).toEqual([]);
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
