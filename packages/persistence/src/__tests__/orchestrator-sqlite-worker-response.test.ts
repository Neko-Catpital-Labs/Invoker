/**
 * Reproduces persistence gaps between worker responses and SQLite task rows.
 *
 * When validateWorkResponse fails, handleWorkerResponse returns without calling
 * writeAndSync — the task stays in its previous DB state (often `running`).
 *
 * Run via: pnpm --filter @invoker/persistence test -- src/__tests__/orchestrator-sqlite-worker-response.test.ts
 * Or: bash scripts/repro-task-db-state.sh
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Orchestrator } from '@invoker/workflow-core';
import type { OrchestratorMessageBus, TaskState } from '@invoker/workflow-core';
import type { WorkResponse } from '@invoker/contracts';
import { SQLiteAdapter } from '../sqlite-adapter.js';
import type { Workflow } from '../adapter.js';

class NoopBus implements OrchestratorMessageBus {
  publish(): void {}
}

describe('Orchestrator + SQLite worker response persistence', () => {
  let adapter: SQLiteAdapter;
  let orchestrator: Orchestrator;

  const wf: Workflow = {
    id: 'wf-repro',
    name: 'Repro',
    status: 'running',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  beforeEach(async () => {
    adapter = await SQLiteAdapter.create(':memory:');
    adapter.saveWorkflow(wf);
    orchestrator = new Orchestrator({
      persistence: adapter,
      messageBus: new NoopBus(),
      maxConcurrency: 3,
    });
  });

  afterEach(() => {
    adapter.close();
  });

  function baseTask(id: string): TaskState {
    return {
      id,
      description: 'repro task',
      status: 'pending',
      dependencies: [],
      createdAt: new Date(),
      config: { workflowId: wf.id, command: 'true' },
      execution: {},
    };
  }

  it('invalid WorkResponse persists failed status (was: stuck running)', () => {
    adapter.saveTask(wf.id, baseTask('task-invalid'));
    orchestrator.syncFromDb(wf.id);

    adapter.updateTask('task-invalid', {
      status: 'running',
      execution: { startedAt: new Date() },
    });
    orchestrator.syncFromDb(wf.id);

    const badResponse = {
      requestId: 'req-bad',
      actionId: 'task-invalid',
      status: 'not_a_real_status',
      outputs: { exitCode: 1, error: 'x' },
    } as unknown as WorkResponse;

    orchestrator.handleWorkerResponse(badResponse);

    const row = adapter.loadTasks(wf.id).find((t) => t.id === 'task-invalid')!;
    expect(row.status).toBe('failed');
  });

  it('valid failed response persists failed + exitCode to SQLite', () => {
    adapter.saveTask(wf.id, baseTask('task-fail'));
    orchestrator.syncFromDb(wf.id);

    adapter.updateTask('task-fail', {
      status: 'running',
      execution: { startedAt: new Date() },
    });
    orchestrator.syncFromDb(wf.id);

    const res: WorkResponse = {
      requestId: 'req-fail',
      actionId: 'task-fail',
      status: 'failed',
      outputs: { exitCode: 1, error: 'command failed' },
    };

    orchestrator.handleWorkerResponse(res);

    const row = adapter.loadTasks(wf.id).find((t) => t.id === 'task-fail')!;
    expect(row.status).toBe('failed');
    expect(row.execution.exitCode).toBe(1);
    expect(row.execution.error).toContain('command failed');
  });

  it('beginConflictResolution persists fixing_with_ai and clears error/exit/completed', () => {
    adapter.saveTask(wf.id, baseTask('task-fix'));
    orchestrator.syncFromDb(wf.id);

    adapter.updateTask('task-fix', {
      status: 'failed',
      execution: {
        error: 'boom',
        exitCode: 1,
        completedAt: new Date(),
      },
    });
    orchestrator.syncFromDb(wf.id);

    orchestrator.beginConflictResolution('task-fix');

    const row = adapter.loadTasks(wf.id).find((t) => t.id === 'task-fix')!;
    expect(row.status).toBe('fixing_with_ai');
    expect(row.execution.error).toBeUndefined();
    expect(row.execution.exitCode).toBeUndefined();
    expect(row.execution.completedAt).toBeUndefined();
    expect(row.execution.isFixingWithAI).toBeFalsy();
  });
});
