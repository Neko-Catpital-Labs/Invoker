import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SQLiteAdapter } from '../sqlite-adapter.js';
import type { Workflow } from '../adapter.js';
import { resolveTaskConfig } from '@invoker/workflow-core';
import type { FixFailureRecord, TaskState, TaskStateChanges } from '@invoker/workflow-core';

describe('execution.lastFixFailure persistence', () => {
  let adapter: SQLiteAdapter;

  const workflow: Workflow = {
    id: 'wf-1',
    name: 'Test Workflow',
    status: 'running',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const fullRecord: FixFailureRecord = {
    agent: 'claude',
    failureClass: 'agent-usage-limit',
    message: "SSH remote script failed (exit=1, phase=remote_agent_fix)\nSTDOUT:\nYou've hit your weekly limit",
    resetsAt: new Date('2026-10-01T01:00:00.000Z'),
    at: new Date('2026-09-27T13:23:00.000Z'),
  };

  function makeTask(id: string, execution: TaskState['execution'] = {}): TaskState {
    return {
      id,
      description: `Task ${id}`,
      status: 'failed',
      dependencies: [],
      createdAt: new Date(),
      config: resolveTaskConfig({}),
      execution,
      taskStateVersion: 1,
    };
  }

  function loadRecord(taskId: string): FixFailureRecord | undefined {
    return adapter.loadTasks('wf-1').find((task) => task.id === taskId)?.execution.lastFixFailure;
  }

  function replaceStoredRecord(json: string): void {
    (adapter as any).db.run('UPDATE tasks SET last_fix_failure_json = ? WHERE id = ?', [json, 't1']);
  }

  beforeEach(async () => {
    adapter = await SQLiteAdapter.create(':memory:');
    adapter.saveWorkflow(workflow);
  });

  afterEach(() => {
    adapter.close();
  });

  it('round-trips a full record through saveTask with Date fields restored', () => {
    adapter.saveTask('wf-1', makeTask('t1', { error: 'test failed', lastFixFailure: fullRecord }));

    const loaded = loadRecord('t1');
    expect(loaded).toEqual(fullRecord);
    expect(loaded?.at).toBeInstanceOf(Date);
    expect(loaded?.resetsAt).toBeInstanceOf(Date);
    expect(adapter.loadTasks('wf-1')[0].execution.error).toBe('test failed');
  });

  it('round-trips a record without resetsAt or failureClass', () => {
    const minimal: FixFailureRecord = { agent: 'codex', message: 'fix crashed', at: new Date('2026-09-27T13:30:00.000Z') };
    adapter.saveTask('wf-1', makeTask('t1', { lastFixFailure: minimal }));

    const loaded = loadRecord('t1');
    expect(loaded).toEqual(minimal);
    expect(loaded).not.toHaveProperty('resetsAt');
    expect(loaded).not.toHaveProperty('failureClass');
  });

  it('round-trips through saveTasks', () => {
    adapter.saveTasks('wf-1', [makeTask('t1', { lastFixFailure: fullRecord }), makeTask('t2')]);

    expect(loadRecord('t1')).toEqual(fullRecord);
    expect(loadRecord('t2')).toBeUndefined();
  });

  it('sets and clears the record through updateTask', () => {
    adapter.saveTask('wf-1', makeTask('t1'));
    expect(loadRecord('t1')).toBeUndefined();

    adapter.updateTask('t1', { execution: { lastFixFailure: fullRecord } } as TaskStateChanges);
    expect(loadRecord('t1')).toEqual(fullRecord);

    adapter.updateTask('t1', { execution: { lastFixFailure: undefined } } as TaskStateChanges);
    expect(loadRecord('t1')).toBeUndefined();
  });

  it('loads a task that never had a record with lastFixFailure undefined', () => {
    adapter.saveTask('wf-1', makeTask('t1', { error: 'plain failure', pendingFixError: 'awaiting approval' }));

    const execution = adapter.loadTasks('wf-1')[0].execution;
    expect(execution.lastFixFailure).toBeUndefined();
    expect(execution.error).toBe('plain failure');
    expect(execution.pendingFixError).toBe('awaiting approval');
  });

  it('rejects a persisted JSON null record while loading', () => {
    adapter.saveTask('wf-1', makeTask('t1', { lastFixFailure: fullRecord }));
    replaceStoredRecord('null');

    expect(() => adapter.loadTasks('wf-1')).toThrow('Invalid last_fix_failure_json: value must be an object');
  });

  it('rejects persisted non-object fix failure records while loading', () => {
    adapter.saveTask('wf-1', makeTask('t1', { lastFixFailure: fullRecord }));

    for (const json of ['[]', '"codex"', '42']) {
      replaceStoredRecord(json);
      expect(() => adapter.loadTasks('wf-1')).toThrow('Invalid last_fix_failure_json: value must be an object');
    }
  });

  it('rejects persisted records missing required fields while loading', () => {
    adapter.saveTask('wf-1', makeTask('t1', { lastFixFailure: fullRecord }));
    replaceStoredRecord(JSON.stringify({ agent: 'codex', at: '2026-09-27T13:30:00.000Z' }));

    expect(() => adapter.loadTasks('wf-1')).toThrow('Invalid last_fix_failure_json: message must be a string');
  });

  it('rejects persisted records with an invalid at date while loading', () => {
    adapter.saveTask('wf-1', makeTask('t1', { lastFixFailure: fullRecord }));
    replaceStoredRecord(JSON.stringify({ agent: 'codex', message: 'fix failed', at: 'not-a-date' }));

    expect(() => adapter.loadTasks('wf-1')).toThrow('Invalid last_fix_failure_json: at must be a valid date');
  });

  it('rejects persisted records with an invalid resetsAt date while loading', () => {
    adapter.saveTask('wf-1', makeTask('t1', { lastFixFailure: fullRecord }));
    replaceStoredRecord(JSON.stringify({
      agent: 'codex',
      message: 'fix failed',
      at: '2026-09-27T13:30:00.000Z',
      resetsAt: 'not-a-date',
    }));

    expect(() => adapter.loadTasks('wf-1')).toThrow('Invalid last_fix_failure_json: resetsAt must be a valid date');
  });
});
