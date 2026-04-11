/**
 * Tests for the delta-merge helper extracted from main.ts.
 *
 * Covers the out-of-order delta scenario: an `updated` delta arrives
 * for a task that has no prior `created` entry in the state map.
 * The fix fetches the task from the orchestrator fallback so the
 * update is not silently dropped.
 */
import { describe, it, expect } from 'vitest';
import { applyDelta, type TaskLookup } from '../delta-merge.js';
import type { TaskState, TaskDelta } from '@invoker/workflow-core';

// ── Helpers ──────────────────────────────────────────────────

function makeTask(id: string, overrides: Partial<TaskState> = {}): TaskState {
  return {
    id,
    description: `Task ${id}`,
    status: 'running',
    dependencies: [],
    createdAt: new Date('2025-01-01'),
    config: { workflowId: 'wf-1', command: `echo ${id}`, executorType: 'worktree' as const },
    execution: {},
    ...overrides,
  } as TaskState;
}

function makeLookup(tasks: TaskState[]): TaskLookup {
  return { getAllTasks: () => tasks };
}

// ── Tests ────────────────────────────────────────────────────

describe('applyDelta', () => {
  describe('created delta', () => {
    it('stores the task snapshot', () => {
      const stateMap = new Map<string, string>();
      const task = makeTask('t1');
      const delta: TaskDelta = { type: 'created', task };

      applyDelta(delta, stateMap);

      expect(stateMap.has('t1')).toBe(true);
      const stored = JSON.parse(stateMap.get('t1')!);
      expect(stored.id).toBe('t1');
      expect(stored.status).toBe('running');
    });
  });

  describe('updated delta with prior created', () => {
    it('merges changes onto existing snapshot', () => {
      const stateMap = new Map<string, string>();
      const task = makeTask('t1');
      stateMap.set('t1', JSON.stringify(task));

      const delta: TaskDelta = {
        type: 'updated',
        taskId: 't1',
        changes: { status: 'completed', execution: { exitCode: 0 } },
      };

      applyDelta(delta, stateMap);

      const stored = JSON.parse(stateMap.get('t1')!);
      expect(stored.status).toBe('completed');
      expect(stored.execution.exitCode).toBe(0);
    });
  });

  describe('out-of-order: updated delta without prior created', () => {
    it('seeds the task from orchestrator fallback and applies the update', () => {
      const stateMap = new Map<string, string>();
      const knownTask = makeTask('t1', { status: 'running' });
      const lookup = makeLookup([knownTask]);

      // Simulate receiving an `updated` delta for t1 without a prior `created`.
      const delta: TaskDelta = {
        type: 'updated',
        taskId: 't1',
        changes: { status: 'completed', execution: { exitCode: 0 } },
      };

      applyDelta(delta, stateMap, lookup);

      // The task must be populated, not dropped.
      expect(stateMap.has('t1')).toBe(true);
      const stored = JSON.parse(stateMap.get('t1')!);
      expect(stored.id).toBe('t1');
      expect(stored.status).toBe('completed');
      expect(stored.execution.exitCode).toBe(0);
    });

    it('applies a second updated delta on top of the first', () => {
      const stateMap = new Map<string, string>();
      const knownTask = makeTask('t1', { status: 'running' });
      const lookup = makeLookup([knownTask]);

      // First update: seeds from orchestrator.
      const delta1: TaskDelta = {
        type: 'updated',
        taskId: 't1',
        changes: { status: 'completed', execution: { exitCode: 0 } },
      };
      applyDelta(delta1, stateMap, lookup);

      // Second update: merges on top of the first.
      const delta2: TaskDelta = {
        type: 'updated',
        taskId: 't1',
        changes: { execution: { error: 'test failure' } },
      };
      applyDelta(delta2, stateMap, lookup);

      const stored = JSON.parse(stateMap.get('t1')!);
      expect(stored.status).toBe('completed');
      expect(stored.execution.exitCode).toBe(0);
      expect(stored.execution.error).toBe('test failure');
    });

    it('drops the update when task is unknown and no fallback available', () => {
      const stateMap = new Map<string, string>();

      const delta: TaskDelta = {
        type: 'updated',
        taskId: 'unknown',
        changes: { status: 'completed' },
      };

      // No lookup provided — update should be silently dropped.
      applyDelta(delta, stateMap);

      expect(stateMap.has('unknown')).toBe(false);
    });

    it('drops the update when task is not in orchestrator either', () => {
      const stateMap = new Map<string, string>();
      const lookup = makeLookup([]); // empty orchestrator

      const delta: TaskDelta = {
        type: 'updated',
        taskId: 'ghost',
        changes: { status: 'completed' },
      };

      applyDelta(delta, stateMap, lookup);

      expect(stateMap.has('ghost')).toBe(false);
    });
  });

  describe('removed delta', () => {
    it('removes the task from the state map', () => {
      const stateMap = new Map<string, string>();
      stateMap.set('t1', JSON.stringify(makeTask('t1')));

      const delta: TaskDelta = { type: 'removed', taskId: 't1' };

      applyDelta(delta, stateMap);

      expect(stateMap.has('t1')).toBe(false);
    });
  });

  describe('config merging', () => {
    it('merges config changes without losing existing config fields', () => {
      const stateMap = new Map<string, string>();
      const task = makeTask('t1');
      stateMap.set('t1', JSON.stringify(task));

      const delta: TaskDelta = {
        type: 'updated',
        taskId: 't1',
        changes: { config: { command: 'echo updated' } },
      };

      applyDelta(delta, stateMap);

      const stored = JSON.parse(stateMap.get('t1')!);
      expect(stored.config.command).toBe('echo updated');
      expect(stored.config.workflowId).toBe('wf-1');
    });
  });
});
