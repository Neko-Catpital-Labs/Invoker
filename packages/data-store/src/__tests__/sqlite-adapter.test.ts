import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, statSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SQLiteAdapter } from '../sqlite-adapter.js';
import type { Workflow, Conversation } from '../adapter.js';
import { createAttempt } from '@invoker/workflow-core';
import type { TaskState, TaskStateChanges } from '@invoker/workflow-core';

describe('SQLiteAdapter', () => {
  let adapter: SQLiteAdapter;

  beforeEach(async () => {
    adapter = await SQLiteAdapter.create(':memory:');
  });

  afterEach(() => {
    adapter.close();
  });

  const testWorkflow: Workflow = {
    id: 'wf-1',
    name: 'Test Workflow',
    status: 'running',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  function makeTask(id: string, overrides: Partial<TaskState> = {}): TaskState {
    return {
      id,
      description: `Task ${id}`,
      status: 'pending',
      dependencies: [],
      createdAt: new Date(),
      config: {},
      execution: {},
      ...overrides,
    };
  }

  describe('saveTask + loadTasks', () => {
    it('round-trips a task through save and load', () => {
      adapter.saveWorkflow(testWorkflow);
      const task = makeTask('t1', { dependencies: ['dep1'], config: { command: 'echo hello' } });
      adapter.saveTask('wf-1', task);

      const loaded = adapter.loadTasks('wf-1');
      expect(loaded).toHaveLength(1);
      expect(loaded[0].id).toBe('t1');
      expect(loaded[0].config.command).toBe('echo hello');
      expect(loaded[0].dependencies).toEqual(['dep1']);
      expect(loaded[0].status).toBe('pending');
    });
  });

  describe('updateTask', () => {
    it('persists partial changes', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t1'));

      adapter.updateTask('t1', { status: 'running', execution: { startedAt: new Date() } });

      const loaded = adapter.loadTasks('wf-1');
      expect(loaded[0].status).toBe('running');
      expect(loaded[0].execution.startedAt).toBeInstanceOf(Date);
    });
  });

  describe('saveWorkflow + loadWorkflow', () => {
    it('round-trips a workflow', () => {
      adapter.saveWorkflow(testWorkflow);
      const loaded = adapter.loadWorkflow('wf-1');
      expect(loaded).toBeDefined();
      expect(loaded!.name).toBe('Test Workflow');
      expect(loaded!.status).toBe('running');
    });
  });

  describe('updateWorkflow', () => {
    it('updates workflow status', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.updateWorkflow('wf-1', { status: 'completed' });

      const loaded = adapter.loadWorkflow('wf-1');
      expect(loaded!.status).toBe('completed');
    });

    it('updates workflow updatedAt', () => {
      adapter.saveWorkflow(testWorkflow);
      const newTime = '2099-01-01T00:00:00.000Z';
      adapter.updateWorkflow('wf-1', { status: 'failed', updatedAt: newTime });

      const loaded = adapter.loadWorkflow('wf-1');
      expect(loaded!.status).toBe('failed');
      expect(loaded!.updatedAt).toBe(newTime);
    });

    it('auto-sets updatedAt when not provided', () => {
      adapter.saveWorkflow(testWorkflow);
      const before = new Date().toISOString();
      adapter.updateWorkflow('wf-1', { status: 'completed' });

      const loaded = adapter.loadWorkflow('wf-1');
      expect(loaded!.updatedAt >= before).toBe(true);
    });
  });

  describe('logEvent + getEvents', () => {
    it('logs and retrieves events', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t1'));

      adapter.logEvent('t1', 'started', { attempt: 1 });
      adapter.logEvent('t1', 'completed', { exitCode: 0 });

      const events = adapter.getEvents('t1');
      expect(events).toHaveLength(2);
      expect(events[0].eventType).toBe('started');
      expect(events[1].eventType).toBe('completed');
      expect(JSON.parse(events[0].payload!)).toEqual({ attempt: 1 });
    });
  });

  describe('JSON fields', () => {
    it('handles dependencies and experimentVariants correctly', () => {
      adapter.saveWorkflow(testWorkflow);

      const task = makeTask('t1', {
        dependencies: ['a', 'b'],
        config: {
          experimentVariants: [{ id: 'v1', description: 'V1', prompt: 'Try 1' }],
        },
        execution: {
          experimentResults: [{ id: 'exp1', status: 'completed', exitCode: 0 }],
        },
      });
      adapter.saveTask('wf-1', task);

      const loaded = adapter.loadTasks('wf-1');
      expect(loaded[0].dependencies).toEqual(['a', 'b']);
      expect(loaded[0].config.experimentVariants).toEqual([{ id: 'v1', description: 'V1', prompt: 'Try 1' }]);
      expect(loaded[0].execution.experimentResults).toEqual([{ id: 'exp1', status: 'completed', exitCode: 0 }]);
    });
  });

  describe('listWorkflows', () => {
    it('returns saved workflows ordered by creation time descending', () => {
      adapter.saveWorkflow({
        ...testWorkflow,
        id: 'wf-1',
        name: 'First',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      });
      adapter.saveWorkflow({
        ...testWorkflow,
        id: 'wf-2',
        name: 'Second',
        createdAt: '2024-01-02T00:00:00.000Z',
        updatedAt: '2024-01-02T00:00:00.000Z',
      });

      const workflows = adapter.listWorkflows();
      expect(workflows).toHaveLength(2);
      expect(workflows[0].id).toBe('wf-2');
      expect(workflows[0].name).toBe('Second');
      expect(workflows[1].id).toBe('wf-1');
      expect(workflows[1].name).toBe('First');
    });

    it('returns empty array when no workflows exist', () => {
      const workflows = adapter.listWorkflows();
      expect(workflows).toHaveLength(0);
    });
  });

  describe('loadTasks returns tasks for a workflow', () => {
    it('returns only tasks belonging to the specified workflow', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveWorkflow({
        ...testWorkflow,
        id: 'wf-2',
        name: 'Other Workflow',
      });

      adapter.saveTask('wf-1', makeTask('t1'));
      adapter.saveTask('wf-1', makeTask('t2'));
      adapter.saveTask('wf-2', makeTask('t3'));

      const tasksWf1 = adapter.loadTasks('wf-1');
      expect(tasksWf1).toHaveLength(2);
      expect(tasksWf1.map((t) => t.id).sort()).toEqual(['t1', 't2']);

      const tasksWf2 = adapter.loadTasks('wf-2');
      expect(tasksWf2).toHaveLength(1);
      expect(tasksWf2[0].id).toBe('t3');
    });
  });

  describe('getSelectedExperiment', () => {
    it('returns selected experiment ID after update', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('recon-1', { config: { isReconciliation: true } }));
      adapter.updateTask('recon-1', { execution: { selectedExperiment: 'exp-winner' } });

      const result = adapter.getSelectedExperiment('recon-1');
      expect(result).toBe('exp-winner');
    });

    it('returns null when no experiment selected', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('recon-2'));

      const result = adapter.getSelectedExperiment('recon-2');
      expect(result).toBeNull();
    });

    it('returns null for non-existent task', () => {
      const result = adapter.getSelectedExperiment('nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('deleteAllTasks', () => {
    it('clears all tasks for a workflow', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t1'));
      adapter.saveTask('wf-1', makeTask('t2'));

      adapter.deleteAllTasks('wf-1');
      const loaded = adapter.loadTasks('wf-1');
      expect(loaded).toHaveLength(0);
    });
  });

  describe('agentSessionId persistence', () => {
    it('round-trips agentSessionId through save and load', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t1', { execution: { agentSessionId: 'sess-abc' } }));

      const loaded = adapter.loadTasks('wf-1');
      expect(loaded[0].execution.agentSessionId).toBe('sess-abc');
    });

    it('persists agentSessionId via updateTask', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t1'));

      adapter.updateTask('t1', { execution: { agentSessionId: 'sess-xyz' } });

      const loaded = adapter.loadTasks('wf-1');
      expect(loaded[0].execution.agentSessionId).toBe('sess-xyz');
    });

    it('returns undefined when agentSessionId is not set', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t1'));

      const loaded = adapter.loadTasks('wf-1');
      expect(loaded[0].execution.agentSessionId).toBeUndefined();
    });

    it('round-trips lastAgentSessionId and lastAgentName through save/load', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask(
        'wf-1',
        makeTask('t1', { execution: { lastAgentSessionId: 'sess-last-1', lastAgentName: 'codex' } }),
      );

      const loaded = adapter.loadTasks('wf-1');
      expect(loaded[0].execution.lastAgentSessionId).toBe('sess-last-1');
      expect(loaded[0].execution.lastAgentName).toBe('codex');
    });

    it('persists lastAgentSessionId and lastAgentName via updateTask', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t1'));

      adapter.updateTask('t1', { execution: { lastAgentSessionId: 'sess-last-2', lastAgentName: 'claude' } });

      const loaded = adapter.loadTasks('wf-1');
      expect(loaded[0].execution.lastAgentSessionId).toBe('sess-last-2');
      expect(loaded[0].execution.lastAgentName).toBe('claude');
    });
  });

  describe('agentName persistence', () => {
    it('round-trips agentName through save and load', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t1', { execution: { agentName: 'codex' } }));

      const loaded = adapter.loadTasks('wf-1');
      expect(loaded[0].execution.agentName).toBe('codex');
    });

    it('persists agentName via updateTask', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t1'));

      adapter.updateTask('t1', { execution: { agentName: 'codex' } });

      const loaded = adapter.loadTasks('wf-1');
      expect(loaded[0].execution.agentName).toBe('codex');
    });

    it('returns undefined when agentName is not set', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t1'));

      const loaded = adapter.loadTasks('wf-1');
      expect(loaded[0].execution.agentName).toBeUndefined();
    });
  });

  describe('saveTask null defaults', () => {
    it('stores SQL NULL (not string literals) for missing optional fields', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t1'));

      const loaded = adapter.loadTasks('wf-1');
      const task = loaded[0];

      expect(task.config.executorType).toBeUndefined();
      expect(task.execution.agentSessionId).toBeUndefined();
      expect(task.execution.workspacePath).toBeUndefined();
      expect(task.execution.containerId).toBeUndefined();
    });

    it('does not store string "pending" as default for executorType', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t1'));

      const loaded = adapter.loadTasks('wf-1');
      expect(loaded[0].config.executorType).not.toBe('pending');
    });

  });

  describe('pendingFixError persistence', () => {
    it('round-trips pendingFixError through save and load', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t1', { execution: { pendingFixError: 'build failed' } }));
      const loaded = adapter.loadTasks('wf-1');
      expect(loaded[0].execution.pendingFixError).toBe('build failed');
    });

    it('persists pendingFixError via updateTask', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t1'));
      adapter.updateTask('t1', { execution: { pendingFixError: 'test error' } });
      const loaded = adapter.loadTasks('wf-1');
      expect(loaded[0].execution.pendingFixError).toBe('test error');
    });

    it('clears pendingFixError via updateTask', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t1', { execution: { pendingFixError: 'error' } }));
      adapter.updateTask('t1', { execution: { pendingFixError: undefined } });
      const loaded = adapter.loadTasks('wf-1');
      expect(loaded[0].execution.pendingFixError).toBeUndefined();
    });

    it('returns undefined when pendingFixError is not set', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t1'));
      const loaded = adapter.loadTasks('wf-1');
      expect(loaded[0].execution.pendingFixError).toBeUndefined();
    });

    it('persists isFixingWithAI via updateTask', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t1'));
      adapter.updateTask('t1', { execution: { isFixingWithAI: true } } as any);
      const loaded = adapter.loadTasks('wf-1');
      expect(loaded[0].execution.isFixingWithAI).toBe(true);
    });

    it('clears isFixingWithAI via updateTask', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t1', { execution: { isFixingWithAI: true } }));
      adapter.updateTask('t1', { execution: { isFixingWithAI: undefined } } as any);
      const loaded = adapter.loadTasks('wf-1');
      expect(loaded[0].execution.isFixingWithAI).toBeFalsy();
    });

    it('normalizes legacy running + isFixingWithAI row to fixing_with_ai', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t1'));
      adapter.updateTask('t1', { status: 'running', execution: { isFixingWithAI: true } } as any);
      const loaded = adapter.loadTasks('wf-1');
      expect(loaded[0].status).toBe('fixing_with_ai');
      expect(loaded[0].execution.isFixingWithAI).toBeFalsy();
    });
  });

  describe('getAgentSessionId', () => {
    it('returns session ID for a task with one', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t1', { execution: { agentSessionId: 'sess-lookup' } }));

      expect(adapter.getAgentSessionId('t1')).toBe('sess-lookup');
    });

    it('returns null when no session ID set', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t1'));

      expect(adapter.getAgentSessionId('t1')).toBeNull();
    });

    it('falls back to lastAgentSessionId when agentSessionId is absent', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t1', { execution: { lastAgentSessionId: 'sess-last-lookup' } }));

      expect(adapter.getAgentSessionId('t1')).toBe('sess-last-lookup');
    });

    it('returns null for non-existent task', () => {
      expect(adapter.getAgentSessionId('nonexistent')).toBeNull();
    });
  });

  describe('getTaskStatus', () => {
    it('returns status for an existing task', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t1'));

      expect(adapter.getTaskStatus('t1')).toBe('pending');
    });

    it('returns null for non-existent task', () => {
      expect(adapter.getTaskStatus('nonexistent')).toBeNull();
    });

    it('returns updated status after updateTask', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t1'));
      adapter.updateTask('t1', { status: 'running' });

      expect(adapter.getTaskStatus('t1')).toBe('running');
    });

    it('returns fixing_with_ai for legacy running + isFixingWithAI rows', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t1'));
      adapter.updateTask('t1', { status: 'running', execution: { isFixingWithAI: true } } as any);
      expect(adapter.getTaskStatus('t1')).toBe('fixing_with_ai');
    });
  });

  describe('deleteAllWorkflows', () => {
    it('deletes all workflows, tasks, and events', () => {
      adapter.saveWorkflow({
        id: 'wf-1',
        name: 'First',
        status: 'running',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      });
      adapter.saveWorkflow({
        id: 'wf-2',
        name: 'Second',
        status: 'running',
        createdAt: '2024-01-02T00:00:00Z',
        updatedAt: '2024-01-02T00:00:00Z',
      });

      adapter.saveTask('wf-1', makeTask('t1'));
      adapter.saveTask('wf-2', makeTask('t2'));
      adapter.logEvent('t1', 'started');

      adapter.deleteAllWorkflows();

      expect(adapter.listWorkflows()).toEqual([]);
      expect(adapter.loadTasks('wf-1')).toEqual([]);
      expect(adapter.loadTasks('wf-2')).toEqual([]);
      expect(adapter.getEvents('t1')).toEqual([]);
    });

    it('works on empty database', () => {
      adapter.deleteAllWorkflows();
      expect(adapter.listWorkflows()).toEqual([]);
    });
  });

  describe('deleteWorkflow', () => {
    it('deletes a single workflow and its tasks/events but keeps other workflows', () => {
      // Create two workflows with tasks and events
      adapter.saveWorkflow({
        id: 'wf-1',
        name: 'First',
        status: 'running',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      });
      adapter.saveWorkflow({
        id: 'wf-2',
        name: 'Second',
        status: 'running',
        createdAt: '2024-01-02T00:00:00Z',
        updatedAt: '2024-01-02T00:00:00Z',
      });

      adapter.saveTask('wf-1', makeTask('t1'));
      adapter.saveTask('wf-1', makeTask('t2'));
      adapter.saveTask('wf-2', makeTask('t3'));

      adapter.logEvent('t1', 'started');
      adapter.logEvent('t2', 'started');
      adapter.logEvent('t3', 'started');

      adapter.appendTaskOutput('t1', 'output from t1\n');
      adapter.appendTaskOutput('t3', 'output from t3\n');

      // Delete wf-1
      adapter.deleteWorkflow('wf-1');

      // Assert wf-1 is gone
      const workflows = adapter.listWorkflows();
      expect(workflows).toHaveLength(1);
      expect(workflows[0].id).toBe('wf-2');
      expect(adapter.loadWorkflow('wf-1')).toBeUndefined();
      expect(adapter.loadTasks('wf-1')).toEqual([]);
      expect(adapter.getEvents('t1')).toEqual([]);
      expect(adapter.getEvents('t2')).toEqual([]);
      expect(adapter.getTaskOutput('t1')).toBe('');

      // Assert wf-2 is intact
      expect(adapter.loadWorkflow('wf-2')).toBeDefined();
      expect(adapter.loadWorkflow('wf-2')!.name).toBe('Second');
      const wf2Tasks = adapter.loadTasks('wf-2');
      expect(wf2Tasks).toHaveLength(1);
      expect(wf2Tasks[0].id).toBe('t3');
      expect(adapter.getEvents('t3')).toHaveLength(1);
      expect(adapter.getTaskOutput('t3')).toBe('output from t3\n');
    });

    it('works when workflow has no tasks', () => {
      adapter.saveWorkflow({
        id: 'wf-empty',
        name: 'Empty Workflow',
        status: 'running',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      });

      adapter.deleteWorkflow('wf-empty');

      expect(adapter.loadWorkflow('wf-empty')).toBeUndefined();
      expect(adapter.listWorkflows()).toEqual([]);
    });

    it('deletes workflow that has attempts on its tasks', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t1'));

      const attempt = createAttempt('t1', { status: 'running' });
      adapter.saveAttempt(attempt);

      // Should not throw SQLITE_CONSTRAINT_FOREIGNKEY
      adapter.deleteWorkflow('wf-1');

      expect(adapter.loadWorkflow('wf-1')).toBeUndefined();
      expect(adapter.loadTasks('wf-1')).toEqual([]);
      expect(adapter.loadAttempts('t1')).toEqual([]);
    });

    it('is a no-op for non-existent workflow', () => {
      adapter.saveWorkflow({
        id: 'wf-exists',
        name: 'Existing',
        status: 'running',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      });
      adapter.saveTask('wf-exists', makeTask('t1'));

      // Call deleteWorkflow on a non-existent workflow
      adapter.deleteWorkflow('nonexistent');

      // Verify no error and existing data is untouched
      expect(adapter.loadWorkflow('wf-exists')).toBeDefined();
      expect(adapter.loadTasks('wf-exists')).toHaveLength(1);
      expect(adapter.listWorkflows()).toHaveLength(1);
    });
  });

  // ── Task Output ──────────────────────────────────────

  describe('task output', () => {
    it('round-trips output chunks through append and get', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t1'));

      adapter.appendTaskOutput('t1', 'line 1\n');
      adapter.appendTaskOutput('t1', 'line 2\n');
      adapter.appendTaskOutput('t1', '[worktree] Process exited: exitCode=0\n');

      const output = adapter.getTaskOutput('t1');
      expect(output).toContain('line 1');
      expect(output).toContain('line 2');
      expect(output).toContain('[worktree] Process exited');
    });

    it('returns empty string for task with no output', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t1'));

      const output = adapter.getTaskOutput('t1');
      expect(output).toBe('');
    });

    it('isolates output by task ID', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t1'));
      adapter.saveTask('wf-1', makeTask('t2'));

      adapter.appendTaskOutput('t1', 'task 1 output\n');
      adapter.appendTaskOutput('t2', 'task 2 output\n');

      expect(adapter.getTaskOutput('t1')).toContain('task 1');
      expect(adapter.getTaskOutput('t1')).not.toContain('task 2');
      expect(adapter.getTaskOutput('t2')).toContain('task 2');
    });

    it('preserves ordering of appended chunks', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t1'));

      adapter.appendTaskOutput('t1', 'first\n');
      adapter.appendTaskOutput('t1', 'second\n');
      adapter.appendTaskOutput('t1', 'third\n');

      const output = adapter.getTaskOutput('t1');
      const firstIdx = output.indexOf('first');
      const secondIdx = output.indexOf('second');
      const thirdIdx = output.indexOf('third');
      expect(firstIdx).toBeLessThan(secondIdx);
      expect(secondIdx).toBeLessThan(thirdIdx);
    });
  });

  // ── Conversations ──────────────────────────────────────

  function makeConversation(threadTs: string, overrides: Partial<Conversation> = {}): Conversation {
    return {
      threadTs,
      channelId: 'C123',
      userId: 'U456',
      extractedPlan: null,
      planSubmitted: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...overrides,
    };
  }

  describe('saveConversation + loadConversation', () => {
    it('round-trips a conversation through save and load', () => {
      adapter.saveConversation(makeConversation('1234567890.123456'));

      const loaded = adapter.loadConversation('1234567890.123456');
      expect(loaded).toBeDefined();
      expect(loaded!.threadTs).toBe('1234567890.123456');
      expect(loaded!.channelId).toBe('C123');
      expect(loaded!.userId).toBe('U456');
      expect(loaded!.extractedPlan).toBeNull();
      expect(loaded!.planSubmitted).toBe(false);
    });

    it('returns undefined for non-existent thread', () => {
      expect(adapter.loadConversation('nonexistent')).toBeUndefined();
    });

    it('persists extracted plan as JSON string', () => {
      const plan = JSON.stringify({ name: 'test-plan', tasks: [{ id: 't1', description: 'Do something' }] });
      adapter.saveConversation(makeConversation('ts-1', { extractedPlan: plan, planSubmitted: true }));

      const loaded = adapter.loadConversation('ts-1');
      expect(loaded!.extractedPlan).toBe(plan);
      expect(loaded!.planSubmitted).toBe(true);
      expect(JSON.parse(loaded!.extractedPlan!)).toEqual({
        name: 'test-plan',
        tasks: [{ id: 't1', description: 'Do something' }],
      });
    });

    it('upserts on duplicate thread_ts', () => {
      adapter.saveConversation(makeConversation('ts-1', { userId: 'U111' }));
      adapter.saveConversation(makeConversation('ts-1', { userId: 'U222' }));

      const loaded = adapter.loadConversation('ts-1');
      expect(loaded!.userId).toBe('U222');
    });
  });

  describe('updateConversation', () => {
    it('updates extractedPlan and planSubmitted', () => {
      adapter.saveConversation(makeConversation('ts-1'));

      const plan = JSON.stringify({ name: 'updated', tasks: [] });
      adapter.updateConversation('ts-1', { extractedPlan: plan, planSubmitted: true });

      const loaded = adapter.loadConversation('ts-1');
      expect(loaded!.extractedPlan).toBe(plan);
      expect(loaded!.planSubmitted).toBe(true);
    });

    it('bumps updated_at on every update', () => {
      adapter.saveConversation(makeConversation('ts-1', { updatedAt: '2024-01-01T00:00:00Z' }));

      adapter.updateConversation('ts-1', { planSubmitted: true, updatedAt: '2024-06-15T12:00:00Z' });

      const loaded = adapter.loadConversation('ts-1');
      expect(loaded!.updatedAt).toBe('2024-06-15T12:00:00Z');
    });
  });

  describe('deleteConversation', () => {
    it('removes conversation and its messages', () => {
      adapter.saveConversation(makeConversation('ts-1'));
      adapter.appendMessage('ts-1', 'user', '"hello"');
      adapter.appendMessage('ts-1', 'assistant', '"hi there"');

      adapter.deleteConversation('ts-1');

      expect(adapter.loadConversation('ts-1')).toBeUndefined();
      expect(adapter.loadMessages('ts-1')).toEqual([]);
    });
  });

  // ── Conversation Messages ──────────────────────────────

  describe('appendMessage + loadMessages', () => {
    it('appends messages with auto-incrementing seq', () => {
      adapter.saveConversation(makeConversation('ts-1'));

      adapter.appendMessage('ts-1', 'user', '"What should I build?"');
      adapter.appendMessage('ts-1', 'assistant', '"Let me explore the codebase."');
      adapter.appendMessage('ts-1', 'user', '"Sounds good"');

      const messages = adapter.loadMessages('ts-1');
      expect(messages).toHaveLength(3);
      expect(messages[0].seq).toBe(1);
      expect(messages[0].role).toBe('user');
      expect(messages[0].content).toBe('"What should I build?"');
      expect(messages[1].seq).toBe(2);
      expect(messages[1].role).toBe('assistant');
      expect(messages[2].seq).toBe(3);
      expect(messages[2].role).toBe('user');
    });

    it('returns empty array for thread with no messages', () => {
      adapter.saveConversation(makeConversation('ts-1'));
      expect(adapter.loadMessages('ts-1')).toEqual([]);
    });

    it('isolates messages by thread_ts', () => {
      adapter.saveConversation(makeConversation('ts-1'));
      adapter.saveConversation(makeConversation('ts-2'));

      adapter.appendMessage('ts-1', 'user', '"thread 1 msg"');
      adapter.appendMessage('ts-2', 'user', '"thread 2 msg"');
      adapter.appendMessage('ts-1', 'assistant', '"reply to thread 1"');

      const msgs1 = adapter.loadMessages('ts-1');
      const msgs2 = adapter.loadMessages('ts-2');

      expect(msgs1).toHaveLength(2);
      expect(msgs2).toHaveLength(1);
      expect(msgs1[0].content).toBe('"thread 1 msg"');
      expect(msgs2[0].content).toBe('"thread 2 msg"');
    });

    it('handles JSON-serialized complex content', () => {
      adapter.saveConversation(makeConversation('ts-1'));

      const complexContent = JSON.stringify([
        { type: 'text', text: 'Hello' },
        { type: 'tool_use', id: 'tool-1', name: 'read_file', input: { path: 'src/index.ts' } },
      ]);
      adapter.appendMessage('ts-1', 'assistant', complexContent);

      const messages = adapter.loadMessages('ts-1');
      expect(messages).toHaveLength(1);
      const parsed = JSON.parse(messages[0].content);
      expect(parsed).toHaveLength(2);
      expect(parsed[0].type).toBe('text');
      expect(parsed[1].type).toBe('tool_use');
    });
  });

  describe('loadAllCompletedTasks', () => {
    it('returns completed tasks across multiple workflows with workflowName', () => {
      adapter.saveWorkflow({ id: 'wf-1', name: 'First Plan', status: 'completed', createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z' });
      adapter.saveWorkflow({ id: 'wf-2', name: 'Second Plan', status: 'completed', createdAt: '2024-01-02T00:00:00Z', updatedAt: '2024-01-02T00:00:00Z' });

      adapter.saveTask('wf-1', makeTask('t1', { status: 'completed', execution: { completedAt: new Date('2024-01-02') } }));
      adapter.saveTask('wf-2', makeTask('t2', { status: 'completed', execution: { completedAt: new Date('2024-01-03') } }));
      adapter.saveTask('wf-1', makeTask('t3', { status: 'pending' }));

      const results = adapter.loadAllCompletedTasks();
      expect(results).toHaveLength(2);
      expect(results[0].id).toBe('t2');
      expect(results[1].id).toBe('t1');
      expect(results[0].workflowName).toBe('Second Plan');
      expect(results[1].workflowName).toBe('First Plan');
    });

    it('excludes non-completed tasks', () => {
      adapter.saveWorkflow({ id: 'wf-1', name: 'Test', status: 'running', createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z' });
      adapter.saveTask('wf-1', makeTask('t1', { status: 'pending' }));
      adapter.saveTask('wf-1', makeTask('t2', { status: 'running' }));
      adapter.saveTask('wf-1', makeTask('t3', { status: 'failed' }));

      const results = adapter.loadAllCompletedTasks();
      expect(results).toHaveLength(0);
    });

    it('returns empty array on empty database', () => {
      const results = adapter.loadAllCompletedTasks();
      expect(results).toHaveLength(0);
    });
  });

  describe('workflowId on tasks', () => {
    it('loadTasks returns workflowId on each task', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t1'));
      adapter.saveTask('wf-1', makeTask('t2'));

      const tasks = adapter.loadTasks('wf-1');
      expect(tasks).toHaveLength(2);
      expect(tasks[0].config.workflowId).toBe('wf-1');
      expect(tasks[1].config.workflowId).toBe('wf-1');
    });

    it('tasks from different workflows have correct workflowId', () => {
      adapter.saveWorkflow({ ...testWorkflow, id: 'wf-a', name: 'Workflow A' });
      adapter.saveWorkflow({ ...testWorkflow, id: 'wf-b', name: 'Workflow B' });
      adapter.saveTask('wf-a', makeTask('t1'));
      adapter.saveTask('wf-b', makeTask('t2'));

      const tasksA = adapter.loadTasks('wf-a');
      const tasksB = adapter.loadTasks('wf-b');
      expect(tasksA[0].config.workflowId).toBe('wf-a');
      expect(tasksB[0].config.workflowId).toBe('wf-b');
    });
  });

  describe('workflow merge config', () => {
    it('saveWorkflow persists onFinish, baseBranch, featureBranch', () => {
      const wf: Workflow = {
        ...testWorkflow,
        onFinish: 'merge',
        baseBranch: 'main',
        featureBranch: 'feat/test',
      };
      adapter.saveWorkflow(wf);

      const loaded = adapter.loadWorkflow('wf-1');
      expect(loaded).toBeDefined();
      expect(loaded!.onFinish).toBe('merge');
      expect(loaded!.baseBranch).toBe('main');
      expect(loaded!.featureBranch).toBe('feat/test');
    });

    it('listWorkflows returns merge config fields', () => {
      adapter.saveWorkflow({
        ...testWorkflow,
        onFinish: 'pull_request',
        baseBranch: 'develop',
        featureBranch: 'feat/pr',
      });

      const workflows = adapter.listWorkflows();
      expect(workflows).toHaveLength(1);
      expect(workflows[0].onFinish).toBe('pull_request');
      expect(workflows[0].baseBranch).toBe('develop');
      expect(workflows[0].featureBranch).toBe('feat/pr');
    });

    it('merge config fields are undefined when not set', () => {
      adapter.saveWorkflow(testWorkflow);

      const loaded = adapter.loadWorkflow('wf-1');
      expect(loaded!.onFinish).toBeUndefined();
      expect(loaded!.baseBranch).toBeUndefined();
      expect(loaded!.featureBranch).toBeUndefined();
    });

    it('listWorkflows returns full Workflow objects', () => {
      adapter.saveWorkflow({
        ...testWorkflow,
        planFile: 'plan.yaml',
        repoUrl: 'https://github.com/test',
        onFinish: 'merge',
      });

      const workflows = adapter.listWorkflows();
      expect(workflows[0].id).toBe('wf-1');
      expect(workflows[0].name).toBe('Test Workflow');
      expect(workflows[0].status).toBe('running');
      expect(workflows[0].planFile).toBe('plan.yaml');
      expect(workflows[0].repoUrl).toBe('https://github.com/test');
      expect(workflows[0].onFinish).toBe('merge');
    });
  });

  describe('updateWorkflow with baseBranch', () => {
    it('updates baseBranch on an existing workflow', () => {
      adapter.saveWorkflow({ ...testWorkflow, baseBranch: 'main' });

      adapter.updateWorkflow('wf-1', { baseBranch: 'master' });

      const loaded = adapter.loadWorkflow('wf-1');
      expect(loaded!.baseBranch).toBe('master');
    });

    it('sets baseBranch when it was previously undefined', () => {
      adapter.saveWorkflow(testWorkflow);

      const before = adapter.loadWorkflow('wf-1');
      expect(before!.baseBranch).toBeUndefined();

      adapter.updateWorkflow('wf-1', { baseBranch: 'develop' });

      const after = adapter.loadWorkflow('wf-1');
      expect(after!.baseBranch).toBe('develop');
    });

    it('updates baseBranch without affecting status', () => {
      adapter.saveWorkflow(testWorkflow);

      adapter.updateWorkflow('wf-1', { baseBranch: 'release' });

      const loaded = adapter.loadWorkflow('wf-1');
      expect(loaded!.status).toBe('running');
      expect(loaded!.baseBranch).toBe('release');
    });
  });

  describe('updateWorkflow with generation', () => {
    it('saves and loads generation field', () => {
      adapter.saveWorkflow({ ...testWorkflow, generation: 0 });

      const loaded = adapter.loadWorkflow('wf-1');
      expect(loaded!.generation).toBe(0);
    });

    it('defaults generation to 0 when not provided', () => {
      adapter.saveWorkflow(testWorkflow);

      const loaded = adapter.loadWorkflow('wf-1');
      expect(loaded!.generation).toBe(0);
    });

    it('updates generation via updateWorkflow', () => {
      adapter.saveWorkflow(testWorkflow);

      adapter.updateWorkflow('wf-1', { generation: 3 });

      const loaded = adapter.loadWorkflow('wf-1');
      expect(loaded!.generation).toBe(3);
    });

    it('updates generation without affecting status or baseBranch', () => {
      adapter.saveWorkflow({ ...testWorkflow, baseBranch: 'master' });

      adapter.updateWorkflow('wf-1', { generation: 5 });

      const loaded = adapter.loadWorkflow('wf-1');
      expect(loaded!.status).toBe('running');
      expect(loaded!.baseBranch).toBe('master');
      expect(loaded!.generation).toBe(5);
    });

    it('includes generation in listWorkflows', () => {
      adapter.saveWorkflow({ ...testWorkflow, generation: 2 });

      const workflows = adapter.listWorkflows();
      expect(workflows[0].generation).toBe(2);
    });
  });

  describe('getAllTaskIds', () => {
    it('returns empty array when no tasks', () => {
      expect(adapter.getAllTaskIds()).toEqual([]);
    });

    it('returns all task IDs across workflows', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveWorkflow({ ...testWorkflow, id: 'wf-2', name: 'Second' });
      adapter.saveTask('wf-1', makeTask('t1'));
      adapter.saveTask('wf-1', makeTask('t2'));
      adapter.saveTask('wf-2', makeTask('t3'));

      const ids = adapter.getAllTaskIds();
      expect(ids.sort()).toEqual(['t1', 't2', 't3']);
    });
  });

  describe('getAllTaskBranches', () => {
    it('returns empty array when no tasks', () => {
      expect(adapter.getAllTaskBranches()).toEqual([]);
    });

    it('returns distinct non-null branches across workflows', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveWorkflow({ ...testWorkflow, id: 'wf-2', name: 'Second' });
      adapter.saveTask('wf-1', makeTask('t1'));
      adapter.saveTask('wf-1', makeTask('t2'));
      adapter.saveTask('wf-2', makeTask('t3'));

      adapter.updateTask('t1', { execution: { branch: 'experiment/t1-abc12345' } } as any);
      adapter.updateTask('t2', { execution: { branch: 'experiment/t2-def67890' } } as any);

      const branches = adapter.getAllTaskBranches();
      expect(branches.sort()).toEqual([
        'experiment/t1-abc12345',
        'experiment/t2-def67890',
      ]);
    });

    it('deduplicates branches', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t1'));
      adapter.saveTask('wf-1', makeTask('t2'));

      adapter.updateTask('t1', { execution: { branch: 'experiment/shared-branch' } } as any);
      adapter.updateTask('t2', { execution: { branch: 'experiment/shared-branch' } } as any);

      const branches = adapter.getAllTaskBranches();
      expect(branches).toEqual(['experiment/shared-branch']);
    });
  });

  describe('logEvent FK constraint', () => {
    it('logEvent with a real task_id succeeds', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t1'));

      expect(() => adapter.logEvent('t1', 'task.running')).not.toThrow();
    });

    it('logEvent with __workflow__ (non-existent task) throws FK error', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t1'));

      expect(() => adapter.logEvent('__workflow__', 'workflow.completed')).toThrow(/FOREIGN KEY/);
    });
  });

  describe('orchestrator + SQLiteAdapter integration: checkWorkflowCompletion FK bug', () => {
    it('handleWorkerResponse does NOT throw FK error when workflow completes (FIX VERIFIED)', async () => {
      const { Orchestrator } = await import('@invoker/workflow-core');

      const bus = { publish() {} };
      const orchestrator = new Orchestrator({ persistence: adapter, messageBus: bus });

      orchestrator.loadPlan({
        name: 'FK Repro',
        tasks: [{ id: 'fk-t1', description: 'Will fail', command: 'false' }],
      });
      orchestrator.startExecution();

      expect(() => {
        orchestrator.handleWorkerResponse({
          requestId: 'req-1',
          actionId: 'fk-t1',
          status: 'failed',
          outputs: { exitCode: 1, error: 'boom' },
        });
      }).not.toThrow();
    });
  });

  describe('migrateTestCommands', () => {
    it('rewrites bad pnpm test commands when DB is re-opened', async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'invoker-test-'));
      const dbPath = join(tmpDir, 'migrate.db');

      const db1 = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
      db1.saveWorkflow(testWorkflow);
      db1.saveTask('wf-1', makeTask('t-bad1', {
        config: { command: 'pnpm test packages/protocol/src/__tests__/validation.test.ts' },
      }));
      db1.saveTask('wf-1', makeTask('t-bad2', {
        config: { command: 'pnpm test -- packages/surfaces/src/__tests__/slack.test.ts' },
      }));
      db1.saveTask('wf-1', makeTask('t-good', {
        config: { command: 'cd packages/protocol && pnpm test' },
      }));
      db1.close();

      const db2 = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
      const tasks = db2.loadTasks('wf-1');
      const bad1 = tasks.find(t => t.id === 't-bad1')!;
      const bad2 = tasks.find(t => t.id === 't-bad2')!;
      const good = tasks.find(t => t.id === 't-good')!;

      expect(bad1.config.command).toBe('cd packages/protocol && pnpm test -- src/__tests__/validation.test.ts');
      expect(bad2.config.command).toBe('cd packages/surfaces && pnpm test -- src/__tests__/slack.test.ts');
      expect(good.config.command).toBe('cd packages/protocol && pnpm test');
      db2.close();

      rmSync(tmpDir, { recursive: true, force: true });
    });
  });

  describe('getExecutionAgent — agent_name vs execution_agent', () => {
    it('returns execution_agent when agent_name is not set', () => {
      adapter.saveWorkflow(testWorkflow);
      const task = makeTask('t-agent-1', {
        config: { workflowId: 'wf-1', executionAgent: 'codex' },
      });
      adapter.saveTask('wf-1', task);

      expect(adapter.getExecutionAgent('t-agent-1')).toBe('codex');
    });

    it('returns agent_name (from fix flow) over execution_agent (from config)', () => {
      adapter.saveWorkflow(testWorkflow);
      // Task created with executionAgent: 'claude' in config
      const task = makeTask('t-agent-2', {
        config: { workflowId: 'wf-1', executionAgent: 'claude' },
      });
      adapter.saveTask('wf-1', task);

      // Fix with codex sets execution.agentName
      adapter.updateTask('t-agent-2', {
        execution: { agentName: 'codex' },
      });

      // getExecutionAgent should return 'codex' (agent_name) not 'claude' (execution_agent)
      expect(adapter.getExecutionAgent('t-agent-2')).toBe('codex');
    });

    it('returns agent_name when execution_agent is null', () => {
      adapter.saveWorkflow(testWorkflow);
      // Task created without executionAgent in config
      const task = makeTask('t-agent-3', {
        config: { workflowId: 'wf-1' },
      });
      adapter.saveTask('wf-1', task);

      // Fix with codex
      adapter.updateTask('t-agent-3', {
        execution: { agentName: 'codex', agentSessionId: 'sess-123' },
      });

      expect(adapter.getExecutionAgent('t-agent-3')).toBe('codex');
    });

    it('returns null when neither agent_name nor execution_agent is set', () => {
      adapter.saveWorkflow(testWorkflow);
      const task = makeTask('t-agent-4', {
        config: { workflowId: 'wf-1' },
      });
      adapter.saveTask('wf-1', task);

      expect(adapter.getExecutionAgent('t-agent-4')).toBeNull();
    });
  });

  describe('end-to-end: fix-with-codex → open-terminal reads codex', () => {
    it('simulates headless fix codex flow and verifies getExecutionAgent returns codex', () => {
      adapter.saveWorkflow(testWorkflow);
      // 1. Task created with default config (no executionAgent set — like most plans)
      const task = makeTask('t-fix-e2e', {
        status: 'failed',
        config: { workflowId: 'wf-1', command: 'pnpm test' },
        execution: { error: 'test failed', workspacePath: '/tmp/worktree-abc', branch: 'experiment/abc' },
      });
      adapter.saveTask('wf-1', task);

      // 2. fixWithAgentImpl persists agentSessionId + agentName (codex)
      adapter.updateTask('t-fix-e2e', {
        execution: { agentSessionId: 'sess-codex-999', agentName: 'codex' },
      });

      // 3. open-terminal reads getExecutionAgent — must return 'codex'
      expect(adapter.getExecutionAgent('t-fix-e2e')).toBe('codex');

      // 4. Also verify agentSessionId survived the same updateTask call
      expect(adapter.getAgentSessionId('t-fix-e2e')).toBe('sess-codex-999');
    });

    it('setFixAwaitingApproval does not clobber agent_name', () => {
      adapter.saveWorkflow(testWorkflow);
      const task = makeTask('t-fix-approve', {
        status: 'fixing_with_ai',
        config: { workflowId: 'wf-1', command: 'pnpm test' },
        execution: { workspacePath: '/tmp/worktree-xyz' },
      });
      adapter.saveTask('wf-1', task);

      // fixWithAgentImpl writes agentName + agentSessionId
      adapter.updateTask('t-fix-approve', {
        execution: { agentSessionId: 'sess-codex-approve', agentName: 'codex' },
      });

      // setFixAwaitingApproval writes status + pendingFixError + isFixingWithAI + agentSessionId
      // (but NOT agentName — it must survive)
      adapter.updateTask('t-fix-approve', {
        status: 'awaiting_approval' as any,
        execution: { pendingFixError: 'original error', isFixingWithAI: false, agentSessionId: 'sess-codex-approve' },
      });

      // agent_name must still be 'codex' after the status transition
      expect(adapter.getExecutionAgent('t-fix-approve')).toBe('codex');
      expect(adapter.getAgentSessionId('t-fix-approve')).toBe('sess-codex-approve');
    });
  });

  describe('read-only / flush safety', () => {
    it('does not rewrite db file when closed without writes', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'sqlite-adapter-readonly-'));
      const dbPath = join(dir, 'invoker.db');
      try {
        const writer = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
        writer.saveWorkflow(testWorkflow);
        writer.saveTask(testWorkflow.id, makeTask('t-read-only'));
        writer.close();

        const before = statSync(dbPath).mtimeMs;
        await new Promise((resolve) => setTimeout(resolve, 20));

        const reader = await SQLiteAdapter.create(dbPath, { readOnly: true });
        const loaded = reader.loadTasks(testWorkflow.id);
        expect(loaded).toHaveLength(1);
        reader.close();

        const after = statSync(dbPath).mtimeMs;
        expect(after).toBe(before);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('throws if a read-only adapter attempts to write', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'sqlite-adapter-readonly-write-'));
      const dbPath = join(dir, 'invoker.db');
      try {
        const writer = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
        writer.saveWorkflow(testWorkflow);
        writer.saveTask(testWorkflow.id, makeTask('t-read-only-write'));
        writer.close();

        const reader = await SQLiteAdapter.create(dbPath, { readOnly: true });
        expect(() =>
          reader.updateTask('t-read-only-write', { status: 'failed' }),
        ).toThrow(/read-only/i);
        reader.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('owner-only writable initialization', () => {
    it('allows writable init with ownerCapability=true for file-backed DB', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'sqlite-adapter-owner-'));
      const dbPath = join(dir, 'invoker.db');
      try {
        const db = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
        db.saveWorkflow(testWorkflow);
        db.saveTask(testWorkflow.id, makeTask('t-owner-write'));
        db.close();

        // Verify write succeeded
        const db2 = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
        const tasks = db2.loadTasks(testWorkflow.id);
        expect(tasks).toHaveLength(1);
        expect(tasks[0].id).toBe('t-owner-write');
        db2.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('rejects writable init without ownerCapability for file-backed DB', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'sqlite-adapter-non-owner-'));
      const dbPath = join(dir, 'invoker.db');
      try {
        await expect(
          SQLiteAdapter.create(dbPath),
        ).rejects.toThrow(/owner capability/i);

        await expect(
          SQLiteAdapter.create(dbPath, { readOnly: false }),
        ).rejects.toThrow(/owner capability/i);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('allows read-only init without ownerCapability', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'sqlite-adapter-readonly-no-cap-'));
      const dbPath = join(dir, 'invoker.db');
      try {
        // Create DB with owner capability
        const writer = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
        writer.saveWorkflow(testWorkflow);
        writer.close();

        // Open read-only without owner capability — should succeed
        const reader = await SQLiteAdapter.create(dbPath, { readOnly: true });
        const workflows = reader.listWorkflows();
        expect(workflows).toHaveLength(1);
        reader.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('allows writable init for in-memory DB without ownerCapability', async () => {
      // In-memory DBs bypass owner check (no persistent state to guard)
      const db = await SQLiteAdapter.create(':memory:');
      db.saveWorkflow(testWorkflow);
      const workflows = db.listWorkflows();
      expect(workflows).toHaveLength(1);
      db.close();
    });
  });

  // ── Output Spool Regression Tests ──────────────────────

  describe('output spool: monotonic offsets', () => {
    it('appends chunks with strictly increasing offset values', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t-offset'));

      // Append multiple chunks
      adapter.appendOutputChunk('t-offset', 'chunk 1\n');
      adapter.appendOutputChunk('t-offset', 'chunk 2\n');
      adapter.appendOutputChunk('t-offset', 'chunk 3\n');

      // Retrieve chunks with their offsets
      const chunks = adapter.getOutputChunks('t-offset');
      expect(chunks).toHaveLength(3);
      expect(chunks[0].offset).toBe(0);
      expect(chunks[1].offset).toBe(8);  // 'chunk 1\n'.length
      expect(chunks[2].offset).toBe(16); // cumulative: 8 + 'chunk 2\n'.length
      expect(chunks[0].data).toBe('chunk 1\n');
      expect(chunks[1].data).toBe('chunk 2\n');
      expect(chunks[2].data).toBe('chunk 3\n');
    });

    it('maintains monotonic offsets across multiple append calls', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t-monotonic'));

      const chunks = ['a', 'bb', 'ccc', 'dddd'];
      for (const chunk of chunks) {
        adapter.appendOutputChunk('t-monotonic', chunk);
      }

      const stored = adapter.getOutputChunks('t-monotonic');
      expect(stored).toHaveLength(4);

      // Verify offsets are strictly increasing and match cumulative byte length
      let expectedOffset = 0;
      for (let i = 0; i < stored.length; i++) {
        expect(stored[i].offset).toBe(expectedOffset);
        expectedOffset += Buffer.byteLength(chunks[i], 'utf8');
      }
    });

    it('handles concurrent chunk appends without offset collision', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t-concurrent'));

      // Simulate rapid concurrent appends
      const appendCount = 50;
      for (let i = 0; i < appendCount; i++) {
        adapter.appendOutputChunk('t-concurrent', `line ${i}\n`);
      }

      const chunks = adapter.getOutputChunks('t-concurrent');
      expect(chunks).toHaveLength(appendCount);

      // Verify all offsets are unique and monotonically increasing
      const offsets = chunks.map(c => c.offset);
      const uniqueOffsets = new Set(offsets);
      expect(uniqueOffsets.size).toBe(appendCount);

      for (let i = 1; i < offsets.length; i++) {
        expect(offsets[i]).toBeGreaterThan(offsets[i - 1]);
      }
    });
  });

  describe('output spool: replay from offset', () => {
    it('allows late subscriber to replay all output from offset 0', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t-replay'));

      adapter.appendOutputChunk('t-replay', 'early output\n');
      adapter.appendOutputChunk('t-replay', 'middle output\n');
      adapter.appendOutputChunk('t-replay', 'late output\n');

      // Late subscriber starts from beginning
      const chunks = adapter.replayOutputFrom('t-replay', 0);
      expect(chunks).toHaveLength(3);
      expect(chunks[0].data).toBe('early output\n');
      expect(chunks[1].data).toBe('middle output\n');
      expect(chunks[2].data).toBe('late output\n');
    });

    it('replays only chunks after specified offset', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t-partial-replay'));

      adapter.appendOutputChunk('t-partial-replay', 'chunk 1\n'); // offset 0
      adapter.appendOutputChunk('t-partial-replay', 'chunk 2\n'); // offset 8
      adapter.appendOutputChunk('t-partial-replay', 'chunk 3\n'); // offset 16

      // Subscriber already has offset 0-7, wants chunks from offset 8 onward
      const chunks = adapter.replayOutputFrom('t-partial-replay', 8);
      expect(chunks).toHaveLength(2);
      expect(chunks[0].offset).toBe(8);
      expect(chunks[0].data).toBe('chunk 2\n');
      expect(chunks[1].offset).toBe(16);
      expect(chunks[1].data).toBe('chunk 3\n');
    });

    it('returns empty array when offset is beyond all chunks', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t-future-offset'));

      adapter.appendOutputChunk('t-future-offset', 'only chunk\n'); // offset 0, length 11

      const chunks = adapter.replayOutputFrom('t-future-offset', 999);
      expect(chunks).toEqual([]);
    });

    it('prevents duplicate chunk delivery across offset boundaries', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t-no-dup'));

      adapter.appendOutputChunk('t-no-dup', 'A');
      adapter.appendOutputChunk('t-no-dup', 'B');
      adapter.appendOutputChunk('t-no-dup', 'C');

      // First subscriber reads from 0
      const batch1 = adapter.replayOutputFrom('t-no-dup', 0);
      expect(batch1.map(c => c.data)).toEqual(['A', 'B', 'C']);

      // Second subscriber reads from offset after 'A' (offset 1)
      const batch2 = adapter.replayOutputFrom('t-no-dup', 1);
      expect(batch2.map(c => c.data)).toEqual(['B', 'C']);

      // Verify no overlap at the boundary where subscriber resumes (after first chunk)
      const firstOffset2 = batch2[0].offset;
      const resumeOffset = batch1[0].offset + batch1[0].data.length;
      expect(firstOffset2).toBeGreaterThanOrEqual(resumeOffset);
    });
  });

  describe('output spool: in-memory cache with tail limit', () => {
    it('retains only recent tail in memory after exceeding limit', async () => {
      const tailLimit = 3;
      const dir = mkdtempSync(join(tmpdir(), 'sqlite-adapter-tail-'));
      const dbPath = join(dir, 'invoker.db');

      try {
        const db = await SQLiteAdapter.create(dbPath, { ownerCapability: true, outputTailLimit: tailLimit });
        db.saveWorkflow(testWorkflow);
        db.saveTask('wf-1', makeTask('t-tail'));

        // Append more chunks than the tail limit
        for (let i = 0; i < 10; i++) {
          db.appendOutputChunk('t-tail', `line ${i}\n`);
        }

        // In-memory tail should contain only last 3 chunks
        const tail = db.getOutputTail('t-tail');
        expect(tail).toHaveLength(tailLimit);
        expect(tail[0].data).toBe('line 7\n');
        expect(tail[1].data).toBe('line 8\n');
        expect(tail[2].data).toBe('line 9\n');

        db.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('retrieves full history from spool storage beyond in-memory tail', async () => {
      const tailLimit = 2;
      const dir = mkdtempSync(join(tmpdir(), 'sqlite-adapter-full-'));
      const dbPath = join(dir, 'invoker.db');

      try {
        const db = await SQLiteAdapter.create(dbPath, { ownerCapability: true, outputTailLimit: tailLimit });
        db.saveWorkflow(testWorkflow);
        db.saveTask('wf-1', makeTask('t-full'));

        // Append 5 chunks
        for (let i = 0; i < 5; i++) {
          db.appendOutputChunk('t-full', `chunk ${i}\n`);
        }

        // Tail has only last 2
        const tail = db.getOutputTail('t-full');
        expect(tail).toHaveLength(tailLimit);

        // But full replay retrieves all 5 from storage
        const allChunks = db.replayOutputFrom('t-full', 0);
        expect(allChunks).toHaveLength(5);
        expect(allChunks[0].data).toBe('chunk 0\n');
        expect(allChunks[4].data).toBe('chunk 4\n');

        db.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('serves tail from memory without disk access when within limit', async () => {
      const tailLimit = 5;
      const dir = mkdtempSync(join(tmpdir(), 'sqlite-adapter-mem-'));
      const dbPath = join(dir, 'invoker.db');

      try {
        const db = await SQLiteAdapter.create(dbPath, { ownerCapability: true, outputTailLimit: tailLimit });
        db.saveWorkflow(testWorkflow);
        db.saveTask('wf-1', makeTask('t-mem'));

        // Append 3 chunks (within tail limit)
        db.appendOutputChunk('t-mem', 'A\n');
        db.appendOutputChunk('t-mem', 'B\n');
        db.appendOutputChunk('t-mem', 'C\n');

        const tail = db.getOutputTail('t-mem');
        expect(tail).toHaveLength(3);
        expect(tail.map(c => c.data)).toEqual(['A\n', 'B\n', 'C\n']);

        db.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('configures tail limit at adapter creation time', async () => {
      const customLimit = 10;
      const dir = mkdtempSync(join(tmpdir(), 'sqlite-adapter-config-'));
      const dbPath = join(dir, 'invoker.db');

      try {
        const db = await SQLiteAdapter.create(dbPath, { ownerCapability: true, outputTailLimit: customLimit });
        db.saveWorkflow(testWorkflow);
        db.saveTask('wf-1', makeTask('t-config'));

        // Append 15 chunks
        for (let i = 0; i < 15; i++) {
          db.appendOutputChunk('t-config', `x${i}\n`);
        }

        const tail = db.getOutputTail('t-config');
        expect(tail).toHaveLength(customLimit);
        expect(tail[0].data).toBe('x5\n'); // Last 10: x5 through x14

        db.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('defaults tail limit to reasonable value when not specified', async () => {
      const db = await SQLiteAdapter.create(':memory:');
      db.saveWorkflow(testWorkflow);
      db.saveTask('wf-1', makeTask('t-default'));

      // Append many chunks to trigger tail eviction
      for (let i = 0; i < 200; i++) {
        db.appendOutputChunk('t-default', `line ${i}\n`);
      }

      const tail = db.getOutputTail('t-default');
      // Default tail limit should be reasonable (e.g., 100)
      expect(tail.length).toBeLessThanOrEqual(100);
      expect(tail.length).toBeGreaterThan(0);

      db.close();
    });
  });

  describe('output spool: durability and persistence', () => {
    it('persists chunks to disk and survives adapter restart', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'sqlite-adapter-persist-'));
      const dbPath = join(dir, 'invoker.db');

      try {
        const db1 = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
        db1.saveWorkflow(testWorkflow);
        db1.saveTask('wf-1', makeTask('t-persist'));

        db1.appendOutputChunk('t-persist', 'persistent chunk 1\n');
        db1.appendOutputChunk('t-persist', 'persistent chunk 2\n');
        db1.close();

        // Reopen DB
        const db2 = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
        const chunks = db2.replayOutputFrom('t-persist', 0);
        expect(chunks).toHaveLength(2);
        expect(chunks[0].data).toBe('persistent chunk 1\n');
        expect(chunks[1].data).toBe('persistent chunk 2\n');

        db2.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('maintains offset consistency across restarts', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'sqlite-adapter-offset-persist-'));
      const dbPath = join(dir, 'invoker.db');

      try {
        const db1 = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
        db1.saveWorkflow(testWorkflow);
        db1.saveTask('wf-1', makeTask('t-offset-persist'));

        db1.appendOutputChunk('t-offset-persist', 'AAA');
        const chunks1 = db1.getOutputChunks('t-offset-persist');
        const lastOffset = chunks1[chunks1.length - 1].offset + Buffer.byteLength(chunks1[chunks1.length - 1].data, 'utf8');
        db1.close();

        // Reopen and append more
        const db2 = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
        db2.appendOutputChunk('t-offset-persist', 'BBB');
        const chunks2 = db2.getOutputChunks('t-offset-persist');

        expect(chunks2).toHaveLength(2);
        expect(chunks2[1].offset).toBe(lastOffset);
        expect(chunks2[1].data).toBe('BBB');

        db2.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  // ── Data Integrity Hardening Tests ──────────────────────

  describe('atomic flush (write-to-temp + rename)', () => {
    it('does not leave a .tmp file after successful flush', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'sqlite-adapter-atomic-'));
      const dbPath = join(dir, 'invoker.db');

      try {
        const db = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
        db.saveWorkflow(testWorkflow);
        db.close(); // close triggers flush

        // The .tmp file should not persist after a successful flush
        expect(existsSync(`${dbPath}.tmp`)).toBe(false);
        // The main DB file should exist
        expect(existsSync(dbPath)).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('persists data correctly through atomic flush cycle', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'sqlite-adapter-atomic-roundtrip-'));
      const dbPath = join(dir, 'invoker.db');

      try {
        const db1 = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
        db1.saveWorkflow(testWorkflow);
        db1.saveTask('wf-1', makeTask('t-atomic'));
        db1.close();

        // Reopen and verify data survived the atomic write
        const db2 = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
        const tasks = db2.loadTasks('wf-1');
        expect(tasks).toHaveLength(1);
        expect(tasks[0].id).toBe('t-atomic');
        db2.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('no stale .tmp files left in directory after multiple flushes', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'sqlite-adapter-atomic-multi-'));
      const dbPath = join(dir, 'invoker.db');

      try {
        const db = await SQLiteAdapter.create(dbPath, { ownerCapability: true });

        // Perform multiple writes that each trigger a flush on close
        db.saveWorkflow(testWorkflow);
        db.saveTask('wf-1', makeTask('t1'));
        db.saveTask('wf-1', makeTask('t2'));
        db.close();

        const files = readdirSync(dir);
        const tmpFiles = files.filter(f => f.endsWith('.tmp'));
        expect(tmpFiles).toEqual([]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('migration error handling', () => {
    it('swallows "duplicate column name" errors (idempotent migration)', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'sqlite-adapter-migrate-dup-'));
      const dbPath = join(dir, 'invoker.db');

      try {
        // First open creates schema + runs migrations
        const db1 = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
        db1.saveWorkflow(testWorkflow);
        db1.close();

        // Second open re-runs migrations — "duplicate column" errors should be swallowed
        const db2 = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
        const wf = db2.loadWorkflow('wf-1');
        expect(wf).toBeDefined();
        expect(wf!.name).toBe('Test Workflow');
        db2.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('rethrows unexpected migration errors', async () => {
      // Create an in-memory adapter and spy on db.run to inject a non-duplicate-column error
      const db = await SQLiteAdapter.create(':memory:');

      // The migrations already ran during create(). To test the error path,
      // we access the private db and migrate method via prototype manipulation.
      // Instead, we verify the behavior by checking that the adapter correctly
      // distinguishes error types.
      const origRun = (db as any).db.run.bind((db as any).db);
      let callCount = 0;

      // Spy on db.run: on the first ALTER TABLE call after re-patching, throw a non-duplicate error
      (db as any).db.run = function(sql: string, ...args: any[]) {
        callCount++;
        if (typeof sql === 'string' && sql.includes('ALTER TABLE') && sql.includes('ADD COLUMN')) {
          throw new Error('disk I/O error');
        }
        return origRun(sql, ...args);
      };

      // Calling migrate() should now rethrow the unexpected error
      expect(() => (db as any).migrate()).toThrow('disk I/O error');

      // Restore and clean up
      (db as any).db.run = origRun;
      db.close();
    });

    it('does not rethrow duplicate column name errors during migration', async () => {
      const db = await SQLiteAdapter.create(':memory:');

      const origRun = (db as any).db.run.bind((db as any).db);

      (db as any).db.run = function(sql: string, ...args: any[]) {
        if (typeof sql === 'string' && sql.includes('ALTER TABLE') && sql.includes('ADD COLUMN')) {
          throw new Error('duplicate column name: some_col');
        }
        return origRun(sql, ...args);
      };

      // Should NOT throw — duplicate column errors are expected and swallowed
      expect(() => (db as any).migrate()).not.toThrow();

      (db as any).db.run = origRun;
      db.close();
    });
  });

  describe('deleteAllWorkflows transactional atomicity', () => {
    it('rolls back all deletes if one fails mid-transaction', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t1'));
      adapter.logEvent('t1', 'started');

      // Spy on db.run to fail on the 'DELETE FROM tasks' step
      const origRun = (adapter as any).db.run.bind((adapter as any).db);
      let deleteCount = 0;

      (adapter as any).db.run = function(sql: string, ...args: any[]) {
        if (sql === 'DELETE FROM tasks') {
          deleteCount++;
          throw new Error('simulated disk failure');
        }
        return origRun(sql, ...args);
      };

      // deleteAllWorkflows should throw due to the simulated failure
      expect(() => adapter.deleteAllWorkflows()).toThrow('simulated disk failure');

      // Restore db.run
      (adapter as any).db.run = origRun;

      // Because of ROLLBACK, the data that was deleted before the failure
      // (events, task_output, attempts) should still be present
      expect(adapter.listWorkflows()).toHaveLength(1);
      expect(adapter.loadTasks('wf-1')).toHaveLength(1);
      expect(adapter.getEvents('t1')).toHaveLength(1);
    });

    it('commits all deletes atomically on success', () => {
      adapter.saveWorkflow({
        ...testWorkflow, id: 'wf-1', name: 'First',
        createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z',
      });
      adapter.saveWorkflow({
        ...testWorkflow, id: 'wf-2', name: 'Second',
        createdAt: '2024-01-02T00:00:00Z', updatedAt: '2024-01-02T00:00:00Z',
      });
      adapter.saveTask('wf-1', makeTask('t1'));
      adapter.saveTask('wf-2', makeTask('t2'));
      adapter.logEvent('t1', 'started');
      adapter.appendTaskOutput('t1', 'output');

      adapter.deleteAllWorkflows();

      // All tables should be empty
      expect(adapter.listWorkflows()).toEqual([]);
      expect(adapter.loadTasks('wf-1')).toEqual([]);
      expect(adapter.loadTasks('wf-2')).toEqual([]);
      expect(adapter.getEvents('t1')).toEqual([]);
      expect(adapter.getTaskOutput('t1')).toBe('');
    });
  });

  describe('deleteConversationsOlderThan dirty flag and persistence', () => {
    it('persists conversation deletes to disk after close', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'sqlite-adapter-conv-dirty-'));
      const dbPath = join(dir, 'invoker.db');

      try {
        // Create DB with an old conversation
        const db1 = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
        const old = new Date();
        old.setDate(old.getDate() - 10);

        db1.saveConversation({
          threadTs: 'ts-old',
          channelId: 'C1',
          userId: 'U1',
          extractedPlan: null,
          planSubmitted: false,
          createdAt: old.toISOString(),
          updatedAt: old.toISOString(),
        });
        db1.appendMessage('ts-old', 'user', '"old message"');

        // Also save a recent conversation to verify it survives
        db1.saveConversation({
          threadTs: 'ts-new',
          channelId: 'C2',
          userId: 'U2',
          extractedPlan: null,
          planSubmitted: false,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
        db1.close();

        // Reopen, delete old conversations, close
        const db2 = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - 7);
        const deleted = db2.deleteConversationsOlderThan(cutoff.toISOString());
        expect(deleted).toBe(1);
        db2.close();

        // Reopen and verify the delete was persisted to disk
        const db3 = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
        expect(db3.loadConversation('ts-old')).toBeUndefined();
        expect(db3.loadMessages('ts-old')).toEqual([]);
        // Recent conversation should survive
        expect(db3.loadConversation('ts-new')).toBeDefined();
        db3.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('rejects deleteConversationsOlderThan on read-only adapter', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'sqlite-adapter-conv-readonly-'));
      const dbPath = join(dir, 'invoker.db');

      try {
        const writer = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
        const old = new Date();
        old.setDate(old.getDate() - 10);
        writer.saveConversation({
          threadTs: 'ts-old',
          channelId: 'C1',
          userId: 'U1',
          extractedPlan: null,
          planSubmitted: false,
          createdAt: old.toISOString(),
          updatedAt: old.toISOString(),
        });
        writer.close();

        const reader = await SQLiteAdapter.create(dbPath, { readOnly: true });
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - 7);
        expect(() => reader.deleteConversationsOlderThan(cutoff.toISOString())).toThrow(/read-only/i);
        reader.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('sets dirty flag so scheduled flush actually writes', async () => {
      // Use in-memory adapter to verify the dirty flag is set
      // by checking the internal state after deleteConversationsOlderThan
      const old = new Date();
      old.setDate(old.getDate() - 10);

      adapter.saveConversation({
        threadTs: 'ts-old',
        channelId: 'C1',
        userId: 'U1',
        extractedPlan: null,
        planSubmitted: false,
        createdAt: old.toISOString(),
        updatedAt: old.toISOString(),
      });

      // Reset dirty flag to false (simulating a clean state after flush)
      (adapter as any).dirty = false;

      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - 7);
      adapter.deleteConversationsOlderThan(cutoff.toISOString());

      // dirty flag should now be true
      expect((adapter as any).dirty).toBe(true);
    });
  });
});
