import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SQLiteAdapter } from '../sqlite-adapter.js';
import type { Workflow, Conversation } from '../adapter.js';
import type { TaskState } from '@invoker/core';

describe('SQLiteAdapter', () => {
  let adapter: SQLiteAdapter;

  beforeEach(() => {
    adapter = new SQLiteAdapter(':memory:');
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
      ...overrides,
    };
  }

  describe('saveTask + loadTasks', () => {
    it('round-trips a task through save and load', () => {
      adapter.saveWorkflow(testWorkflow);
      const task = makeTask('t1', { command: 'echo hello', dependencies: ['dep1'] });
      adapter.saveTask('wf-1', task);

      const loaded = adapter.loadTasks('wf-1');
      expect(loaded).toHaveLength(1);
      expect(loaded[0].id).toBe('t1');
      expect(loaded[0].command).toBe('echo hello');
      expect(loaded[0].dependencies).toEqual(['dep1']);
      expect(loaded[0].status).toBe('pending');
    });
  });

  describe('updateTask', () => {
    it('persists partial changes', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t1'));

      adapter.updateTask('t1', { status: 'running', startedAt: new Date() });

      const loaded = adapter.loadTasks('wf-1');
      expect(loaded[0].status).toBe('running');
      expect(loaded[0].startedAt).toBeInstanceOf(Date);
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
        experimentVariants: [{ id: 'v1', description: 'V1', prompt: 'Try 1' }],
        experimentResults: [{ id: 'exp1', status: 'completed', exitCode: 0 }],
      });
      adapter.saveTask('wf-1', task);

      const loaded = adapter.loadTasks('wf-1');
      expect(loaded[0].dependencies).toEqual(['a', 'b']);
      expect(loaded[0].experimentVariants).toEqual([{ id: 'v1', description: 'V1', prompt: 'Try 1' }]);
      expect(loaded[0].experimentResults).toEqual([{ id: 'exp1', status: 'completed', exitCode: 0 }]);
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
      adapter.saveTask('wf-1', makeTask('recon-1', { isReconciliation: true }));
      adapter.updateTask('recon-1', { selectedExperiment: 'exp-winner' });

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

  describe('claudeSessionId persistence', () => {
    it('round-trips claudeSessionId through save and load', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t1', { claudeSessionId: 'sess-abc' }));

      const loaded = adapter.loadTasks('wf-1');
      expect(loaded[0].claudeSessionId).toBe('sess-abc');
    });

    it('persists claudeSessionId via updateTask', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t1'));

      adapter.updateTask('t1', { claudeSessionId: 'sess-xyz' });

      const loaded = adapter.loadTasks('wf-1');
      expect(loaded[0].claudeSessionId).toBe('sess-xyz');
    });

    it('returns undefined when claudeSessionId is not set', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t1'));

      const loaded = adapter.loadTasks('wf-1');
      expect(loaded[0].claudeSessionId).toBeUndefined();
    });
  });

  describe('saveTask null defaults', () => {
    it('stores SQL NULL (not string literals) for missing optional fields', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t1'));

      const loaded = adapter.loadTasks('wf-1');
      const task = loaded[0];

      // These fields should be undefined (mapped from SQL NULL),
      // NOT the string literals 'pending' or 'none'
      expect(task.familiarType).toBeUndefined();
      expect(task.claudeSessionId).toBeUndefined();
      expect(task.workspacePath).toBeUndefined();
      expect(task.containerId).toBeUndefined();
    });

    it('does not store string "pending" as default for familiarType', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t1'));

      const loaded = adapter.loadTasks('wf-1');
      expect(loaded[0].familiarType).not.toBe('pending');
    });
  });

  describe('getClaudeSessionId', () => {
    it('returns session ID for a task with one', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t1', { claudeSessionId: 'sess-lookup' }));

      expect(adapter.getClaudeSessionId('t1')).toBe('sess-lookup');
    });

    it('returns null when no session ID set', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t1'));

      expect(adapter.getClaudeSessionId('t1')).toBeNull();
    });

    it('returns null for non-existent task', () => {
      expect(adapter.getClaudeSessionId('nonexistent')).toBeNull();
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

  // ── Task Output ──────────────────────────────────────

  describe('task output', () => {
    it('round-trips output chunks through append and get', () => {
      adapter.saveWorkflow(testWorkflow);
      adapter.saveTask('wf-1', makeTask('t1'));

      adapter.appendTaskOutput('t1', 'line 1\n');
      adapter.appendTaskOutput('t1', 'line 2\n');
      adapter.appendTaskOutput('t1', '[LocalFamiliar] Process exited: exitCode=0\n');

      const output = adapter.getTaskOutput('t1');
      expect(output).toContain('line 1');
      expect(output).toContain('line 2');
      expect(output).toContain('[LocalFamiliar] Process exited');
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

      adapter.saveTask('wf-1', makeTask('t1', { status: 'completed', completedAt: new Date('2024-01-02') }));
      adapter.saveTask('wf-2', makeTask('t2', { status: 'completed', completedAt: new Date('2024-01-03') }));
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
});
