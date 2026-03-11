import { describe, it, expect, beforeEach } from 'vitest';
import { TaskStateMachine } from '../state-machine.js';

describe('TaskStateMachine', () => {
  let sm: TaskStateMachine;

  beforeEach(() => {
    sm = new TaskStateMachine();
  });

  // ── createTask ────────────────────────────────────────

  describe('createTask', () => {
    it('creates a pending task with correct defaults', () => {
      const { task, delta } = sm.createTask('t1', 'Test task', []);
      expect(task.id).toBe('t1');
      expect(task.description).toBe('Test task');
      expect(task.status).toBe('pending');
      expect(task.dependencies).toEqual([]);
      expect(task.createdAt).toBeInstanceOf(Date);
      expect(delta.type).toBe('created');
    });

    it('creates a blocked task when a dependency already failed', () => {
      sm.createTask('dep1', 'Dep', []);
      const startResult = sm.startTask('dep1');
      expect('task' in startResult).toBe(true);
      sm.failTask('dep1', 1, 'oops');

      const { task } = sm.createTask('t2', 'Depends on failed', ['dep1']);
      expect(task.status).toBe('blocked');
      expect(task.blockedBy).toBe('dep1');
    });
  });

  // ── startTask ─────────────────────────────────────────

  describe('startTask', () => {
    it('transitions pending -> running and returns delta', () => {
      sm.createTask('t1', 'Task', []);
      const result = sm.startTask('t1');

      expect('task' in result).toBe(true);
      if ('task' in result) {
        expect(result.task.status).toBe('running');
        expect(result.task.startedAt).toBeInstanceOf(Date);
        expect(result.transition.from).toBe('pending');
        expect(result.transition.to).toBe('running');
        expect(result.delta.type).toBe('updated');
      }
    });

    it('returns error for non-pending task', () => {
      sm.createTask('t1', 'Task', []);
      sm.startTask('t1'); // now running
      const result = sm.startTask('t1');
      expect('error' in result).toBe(true);
    });
  });

  // ── completeTask ──────────────────────────────────────

  describe('completeTask', () => {
    it('transitions running -> completed and returns newly ready dependents', () => {
      sm.createTask('t1', 'First', []);
      sm.createTask('t2', 'Second', ['t1']);
      sm.startTask('t1');

      const result = sm.completeTask('t1', 0);
      expect('task' in result).toBe(true);
      if ('task' in result) {
        expect(result.task.status).toBe('completed');
        expect(result.task.exitCode).toBe(0);
        expect(result.task.completedAt).toBeInstanceOf(Date);

        const readyEffect = result.sideEffects.find((e) => e.type === 'tasks_ready');
        expect(readyEffect).toBeDefined();
        if (readyEffect?.type === 'tasks_ready') {
          expect(readyEffect.taskIds).toContain('t2');
        }
      }
    });

    it('stores claudeSessionId when provided', () => {
      sm.createTask('t1', 'Claude task', []);
      sm.startTask('t1');

      const result = sm.completeTask('t1', 0, undefined, undefined, 'sess-123');
      expect('task' in result).toBe(true);
      if ('task' in result) {
        expect(result.task.claudeSessionId).toBe('sess-123');
      }

      expect(sm.getTask('t1')?.claudeSessionId).toBe('sess-123');
    });
  });

  // ── failTask ──────────────────────────────────────────

  describe('failTask', () => {
    it('transitions running -> failed and cascades to block transitive dependents', () => {
      sm.createTask('t1', 'First', []);
      sm.createTask('t2', 'Second', ['t1']);
      sm.createTask('t3', 'Third', ['t2']);
      sm.startTask('t1');

      const result = sm.failTask('t1', 1, 'boom');
      expect('task' in result).toBe(true);
      if ('task' in result) {
        expect(result.task.status).toBe('failed');
        expect(result.task.error).toBe('boom');

        const blockedEffect = result.sideEffects.find((e) => e.type === 'tasks_blocked');
        expect(blockedEffect).toBeDefined();
        if (blockedEffect?.type === 'tasks_blocked') {
          expect(blockedEffect.taskIds).toContain('t2');
          expect(blockedEffect.taskIds).toContain('t3');
          expect(blockedEffect.blockedBy).toBe('t1');
        }
      }
    });

    it('blocks transitive dependents: A fails -> B blocked -> C blocked', () => {
      sm.createTask('a', 'A', []);
      sm.createTask('b', 'B', ['a']);
      sm.createTask('c', 'C', ['b']);
      sm.startTask('a');

      const result = sm.failTask('a', 1);
      expect('task' in result).toBe(true);
      if ('task' in result) {
        expect(sm.getTask('b')?.status).toBe('blocked');
        expect(sm.getTask('b')?.blockedBy).toBe('a');
        expect(sm.getTask('c')?.status).toBe('blocked');
        expect(sm.getTask('c')?.blockedBy).toBe('a');
      }
    });
  });

  // ── pauseForInput / resumeWithInput ───────────────────

  describe('pauseForInput', () => {
    it('transitions running -> needs_input with prompt', () => {
      sm.createTask('t1', 'Task', []);
      sm.startTask('t1');

      const result = sm.pauseForInput('t1', 'Enter your name');
      expect('task' in result).toBe(true);
      if ('task' in result) {
        expect(result.task.status).toBe('needs_input');
        expect(result.task.inputPrompt).toBe('Enter your name');
      }
    });
  });

  describe('resumeWithInput', () => {
    it('transitions needs_input -> running', () => {
      sm.createTask('t1', 'Task', []);
      sm.startTask('t1');
      sm.pauseForInput('t1', 'Waiting...');

      const result = sm.resumeWithInput('t1');
      expect('task' in result).toBe(true);
      if ('task' in result) {
        expect(result.task.status).toBe('running');
        expect(result.task.inputPrompt).toBeUndefined();
      }
    });
  });

  // ── requestApproval / approveTask / rejectTask ────────

  describe('requestApproval', () => {
    it('transitions running -> awaiting_approval', () => {
      sm.createTask('t1', 'Task', []);
      sm.startTask('t1');

      const result = sm.requestApproval('t1');
      expect('task' in result).toBe(true);
      if ('task' in result) {
        expect(result.task.status).toBe('awaiting_approval');
      }
    });
  });

  describe('approveTask', () => {
    it('transitions awaiting_approval -> completed and unblocks dependents', () => {
      sm.createTask('t1', 'Task', []);
      sm.createTask('t2', 'Depends', ['t1']);
      sm.startTask('t1');
      sm.requestApproval('t1');

      const result = sm.approveTask('t1');
      expect('task' in result).toBe(true);
      if ('task' in result) {
        expect(result.task.status).toBe('completed');
        const readyEffect = result.sideEffects.find((e) => e.type === 'tasks_ready');
        expect(readyEffect).toBeDefined();
        if (readyEffect?.type === 'tasks_ready') {
          expect(readyEffect.taskIds).toContain('t2');
        }
      }
    });
  });

  describe('rejectTask', () => {
    it('transitions awaiting_approval -> failed and blocks dependents', () => {
      sm.createTask('t1', 'Task', []);
      sm.createTask('t2', 'Depends', ['t1']);
      sm.startTask('t1');
      sm.requestApproval('t1');

      const result = sm.rejectTask('t1', 'Not good enough');
      expect('task' in result).toBe(true);
      if ('task' in result) {
        expect(result.task.status).toBe('failed');
        expect(result.task.error).toBe('Not good enough');

        const blockedEffect = result.sideEffects.find((e) => e.type === 'tasks_blocked');
        expect(blockedEffect).toBeDefined();
        if (blockedEffect?.type === 'tasks_blocked') {
          expect(blockedEffect.taskIds).toContain('t2');
        }
      }
    });
  });

  // ── Reconciliation ────────────────────────────────────

  describe('triggerReconciliation', () => {
    it('sets experimentResults and transitions to needs_input', () => {
      sm.createTask('recon', 'Reconciliation', [], { isReconciliation: true });
      sm.startTask('recon');
      // triggerReconciliation works on pending reconciliation tasks — simulate by going back
      // Actually: reconciliation tasks can be in 'pending' initially, let's recreate
      sm.clear();
      sm.createTask('recon', 'Reconciliation', [], { isReconciliation: true });

      const results = [
        { id: 'exp1', status: 'completed' as const, summary: 'Good', exitCode: 0 },
        { id: 'exp2', status: 'failed' as const, exitCode: 1 },
      ];

      const result = sm.triggerReconciliation('recon', results);
      expect('task' in result).toBe(true);
      if ('task' in result) {
        expect(result.task.status).toBe('needs_input');
        expect(result.task.experimentResults).toEqual(results);
      }
    });
  });

  describe('completeReconciliation', () => {
    it('transitions needs_input -> completed with selectedExperiment', () => {
      sm.createTask('recon', 'Reconciliation', [], { isReconciliation: true });
      sm.createTask('downstream', 'Next', ['recon']);

      const results = [{ id: 'exp1', status: 'completed' as const, exitCode: 0 }];
      sm.triggerReconciliation('recon', results);

      const result = sm.completeReconciliation('recon', 'exp1');
      expect('task' in result).toBe(true);
      if ('task' in result) {
        expect(result.task.status).toBe('completed');
        expect(result.task.selectedExperiment).toBe('exp1');

        const readyEffect = result.sideEffects.find((e) => e.type === 'tasks_ready');
        expect(readyEffect).toBeDefined();
      }
    });
  });

  // ── rewriteDependency ─────────────────────────────────

  describe('rewriteDependency', () => {
    it('updates downstream tasks, skips experiment children', () => {
      sm.createTask('pivot', 'Pivot', []);
      sm.createTask('downstream', 'Down', ['pivot']);
      sm.createTask('exp-child', 'Experiment', ['pivot'], { parentTask: 'pivot' });

      const deltas = sm.rewriteDependency('pivot', 'recon-1');

      // downstream should be rewritten
      expect(sm.getTask('downstream')?.dependencies).toEqual(['recon-1']);
      // experiment child should NOT be rewritten
      expect(sm.getTask('exp-child')?.dependencies).toEqual(['pivot']);

      expect(deltas).toHaveLength(1);
      expect(deltas[0].taskId).toBe('downstream');
    });
  });

  // ── getReadyTasks ─────────────────────────────────────

  describe('getReadyTasks', () => {
    it('returns only pending tasks with all deps completed', () => {
      sm.createTask('t1', 'First', []);
      sm.createTask('t2', 'Second', ['t1']);
      sm.createTask('t3', 'Third', []);

      // Initially: t1 and t3 are ready (no deps), t2 is not (dep pending)
      let ready = sm.getReadyTasks();
      expect(ready.map((t) => t.id).sort()).toEqual(['t1', 't3']);

      // Complete t1 -> t2 becomes ready
      sm.startTask('t1');
      sm.completeTask('t1');
      ready = sm.getReadyTasks();
      expect(ready.map((t) => t.id).sort()).toEqual(['t2', 't3']);
    });
  });

  // ── updateTaskFields ───────────────────────────────────

  describe('updateTaskFields', () => {
    it('updates command on a pending task', () => {
      sm.createTask('t1', 'Task', [], { command: 'ls -la' });
      const result = sm.updateTaskFields('t1', { command: 'ls -la /tmp' });

      expect('task' in result).toBe(true);
      if ('task' in result) {
        expect(result.task.command).toBe('ls -la /tmp');
        expect(result.task.status).toBe('pending');
        expect(result.delta.type).toBe('updated');
        if (result.delta.type === 'updated') {
          expect(result.delta.changes).toEqual({ command: 'ls -la /tmp' });
        }
      }
    });

    it('updates command on a failed task', () => {
      sm.createTask('t1', 'Task', [], { command: 'bad-cmd' });
      sm.startTask('t1');
      sm.failTask('t1', 1, 'not found');
      const result = sm.updateTaskFields('t1', { command: 'good-cmd' });

      expect('task' in result).toBe(true);
      if ('task' in result) {
        expect(result.task.command).toBe('good-cmd');
        expect(result.task.status).toBe('failed');
      }
    });

    it('returns error when task is running', () => {
      sm.createTask('t1', 'Task', [], { command: 'sleep 10' });
      sm.startTask('t1');
      const result = sm.updateTaskFields('t1', { command: 'echo hi' });

      expect('error' in result).toBe(true);
    });

    it('returns error for non-existent task', () => {
      const result = sm.updateTaskFields('nope', { command: 'echo hi' });
      expect('error' in result).toBe(true);
    });

    it('persists the update in the graph', () => {
      sm.createTask('t1', 'Task', [], { command: 'old' });
      sm.updateTaskFields('t1', { command: 'new' });
      expect(sm.getTask('t1')?.command).toBe('new');
    });
  });

  // ── Immutability ──────────────────────────────────────

  describe('immutability', () => {
    it('transitions produce a new object, original is not mutated', () => {
      sm.createTask('t1', 'Task', []);
      const before = sm.getTask('t1')!;
      sm.startTask('t1');
      const after = sm.getTask('t1')!;

      expect(before.status).toBe('pending');
      expect(after.status).toBe('running');
      expect(before).not.toBe(after);
    });
  });
});
