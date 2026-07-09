import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { SQLiteAdapter, type WorkerActionWrite } from '@invoker/data-store';
import type { TaskState } from '@invoker/workflow-core';

import { listWorkerDecisions } from '../worker-control.js';
import { formatWorkerDecisions } from '../formatter.js';

describe('worker decisions end-to-end (real SQLite)', () => {
  let adapter: SQLiteAdapter;

  beforeEach(async () => {
    adapter = await SQLiteAdapter.create(':memory:');
    const now = new Date().toISOString();
    adapter.saveWorkflow({ id: 'wf-1', name: 'Run', status: 'running', createdAt: now, updatedAt: now });
    adapter.saveTask('wf-1', {
      id: 'wf-1/task-a',
      description: 'task a',
      status: 'failed',
      dependencies: [],
      createdAt: new Date(),
      config: {},
      execution: {},
      taskStateVersion: 1,
    } as TaskState);
  });

  afterEach(() => {
    adapter.close();
  });

  function write(overrides: Partial<WorkerActionWrite>): WorkerActionWrite {
    return {
      id: 'wa',
      workerKind: 'autofix',
      actionType: 'auto-fix',
      workflowId: 'wf-1',
      taskId: 'wf-1/task-a',
      subjectType: 'task',
      subjectId: 'wf-1/task-a',
      externalKey: 'k',
      status: 'queued',
      attemptCount: 1,
      updatedAt: '2026-01-01T00:00:01.000Z',
      ...overrides,
    };
  }

  it('reads autofix submit + skip decisions back with decision class and reason', () => {
    adapter.upsertWorkerAction(write({
      id: 'act-row',
      externalKey: 'autofix:wf-1/task-a:0:a1',
      status: 'queued',
      agentName: 'claude',
      intentId: '42',
      summary: 'Queued auto-fix with agent',
      payload: { channel: 'invoker:fix-with-agent' },
      updatedAt: '2026-01-01T00:00:02.000Z',
    }));
    adapter.upsertWorkerAction(write({
      id: 'skip-row',
      externalKey: 'autofix:wf-1/task-a:1:a2',
      status: 'skipped',
      summary: 'Skipped auto-fix: retry-budget-disabled',
      payload: { reason: 'retry-budget-disabled' },
      updatedAt: '2026-01-01T00:00:03.000Z',
    }));

    const all = listWorkerDecisions(adapter, { workflowId: 'wf-1' });
    expect([...all.actions.map((action) => action.decision)].sort()).toEqual(['act', 'skip']);

    const skips = listWorkerDecisions(adapter, { workflowId: 'wf-1', decision: 'skip' });
    expect(skips.actions).toHaveLength(1);
    expect(skips.actions[0]).toMatchObject({ decision: 'skip', reason: 'retry-budget-disabled', taskId: 'wf-1/task-a' });

    const byReason = listWorkerDecisions(adapter, { reason: 'budget' });
    expect(byReason.actions.map((action) => action.id)).toEqual(['skip-row']);

    const text = formatWorkerDecisions(all.actions);
    expect(text).toContain('SKIP');
    expect(text).toContain('reason=retry-budget-disabled');
    expect(text).toContain('agent=claude');
  });
});
