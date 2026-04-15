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
    orchestrator.startExecution(); // occupy scheduler slot

    const badResponse = {
      requestId: 'req-bad',
      actionId: 'task-invalid',
      executionGeneration: 0,
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
      executionGeneration: 0,
      status: 'failed',
      outputs: { exitCode: 1, error: 'command failed' },
    };

    orchestrator.handleWorkerResponse(res);

    const row = adapter.loadTasks(wf.id).find((t) => t.id === 'task-fail')!;
    expect(row.status).toBe('failed');
    expect(row.execution.exitCode).toBe(1);
    expect(row.execution.error).toContain('command failed');
  });

  it('valid failed response with selected running attempt persists failed task row too', () => {
    adapter.saveTask(wf.id, baseTask('task-fail-attempt'));
    orchestrator.syncFromDb(wf.id);
    orchestrator.startExecution();

    const runningRow = adapter.loadTasks(wf.id).find((t) => t.id === 'task-fail-attempt')!;
    expect(runningRow.status).toBe('running');
    expect(runningRow.execution.selectedAttemptId).toBeTruthy();

    const res: WorkResponse = {
      requestId: 'req-fail-attempt',
      actionId: 'task-fail-attempt',
      attemptId: runningRow.execution.selectedAttemptId,
      executionGeneration: 0,
      status: 'failed',
      outputs: { exitCode: 1, error: 'command failed with attempt' },
    };

    orchestrator.handleWorkerResponse(res);

    const row = adapter.loadTasks(wf.id).find((t) => t.id === 'task-fail-attempt')!;
    const attempt = adapter.loadAttempt(runningRow.execution.selectedAttemptId!)!;
    expect(row.status).toBe('failed');
    expect(row.execution.exitCode).toBe(1);
    expect(row.execution.error).toContain('command failed with attempt');
    expect(attempt.status).toBe('failed');
    expect(attempt.exitCode).toBe(1);
  });

  it('loadTasks reconciles a stale running task row from its failed selected attempt', () => {
    adapter.saveTask(wf.id, baseTask('task-reconcile'));
    adapter.saveAttempt({
      id: 'task-reconcile-a1',
      nodeId: 'task-reconcile',
      attemptNumber: 0,
      queuePriority: 0,
      status: 'failed',
      upstreamAttemptIds: [],
      createdAt: new Date(),
      startedAt: new Date(),
      completedAt: new Date(),
      exitCode: 1,
      error: 'attempt failed first',
      branch: 'experiment/task-reconcile',
      workspacePath: '/tmp/mock-workspace',
    });
    adapter.updateTask('task-reconcile', {
      status: 'running',
      execution: {
        selectedAttemptId: 'task-reconcile-a1',
        startedAt: new Date(),
      },
    });

    const row = adapter.loadTasks(wf.id).find((t) => t.id === 'task-reconcile')!;
    expect(row.status).toBe('failed');
    expect(row.execution.exitCode).toBe(1);
    expect(row.execution.error).toContain('attempt failed first');
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

describe('Protocol failure persistence (SQLite roundtrip)', () => {
  let adapter: SQLiteAdapter;
  let orchestrator: Orchestrator;

  const wf: Workflow = {
    id: 'wf-protocol',
    name: 'Protocol',
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
      description: 'protocol test task',
      status: 'pending',
      dependencies: [],
      createdAt: new Date(),
      config: { workflowId: wf.id, command: 'true' },
      execution: {},
    };
  }

  it('malformed status persists failed + protocol error metadata', () => {
    adapter.saveTask(wf.id, baseTask('task-malformed'));
    orchestrator.syncFromDb(wf.id);
    orchestrator.startExecution(); // start task, occupy scheduler slot

    const badResponse = {
      requestId: 'req-malformed',
      actionId: 'task-malformed',
      executionGeneration: 0,
      status: 'this_is_not_a_valid_status',
      outputs: { exitCode: 1, error: 'x' },
    } as unknown as WorkResponse;

    orchestrator.handleWorkerResponse(badResponse);

    // Re-read from SQLite to exercise column projection
    const row = adapter.loadTasks(wf.id).find((t) => t.id === 'task-malformed')!;
    expect(row.status).toBe('failed');
    expect(row.execution.protocolErrorCode).toBe('MALFORMED_RESPONSE');
    expect(row.execution.protocolErrorMessage).toBeDefined();
    expect(row.execution.error).toMatch(/^Protocol error:/);
    expect(row.execution.exitCode).toBe(1);
    expect(row.execution.completedAt).toBeDefined();

    // Verify scheduler slot freed
    const status = (orchestrator as any).scheduler.getStatus();
    expect(status.runningCount).toBe(0);
  });

  it('spawn_experiments without dagMutation persists failed', () => {
    adapter.saveTask(wf.id, baseTask('task-spawn'));
    orchestrator.syncFromDb(wf.id);
    orchestrator.startExecution();

    const badResponse = {
      requestId: 'req-spawn',
      actionId: 'task-spawn',
      executionGeneration: 0,
      status: 'spawn_experiments',
      outputs: {},
      // Missing required dagMutation field
    } as unknown as WorkResponse;

    orchestrator.handleWorkerResponse(badResponse);

    const row = adapter.loadTasks(wf.id).find((t) => t.id === 'task-spawn')!;
    expect(row.status).toBe('failed');
    expect(row.execution.protocolErrorCode).toBe('MALFORMED_RESPONSE');
    expect(row.execution.protocolErrorMessage).toContain('spawn_experiments');
    expect(row.execution.error).toMatch(/^Protocol error:/);
    expect(row.execution.exitCode).toBe(1);
    expect(row.execution.completedAt).toBeDefined();

    const status = (orchestrator as any).scheduler.getStatus();
    expect(status.runningCount).toBe(0);
  });

  it('select_experiment without dagMutation persists failed', () => {
    adapter.saveTask(wf.id, baseTask('task-select'));
    orchestrator.syncFromDb(wf.id);
    orchestrator.startExecution();

    const badResponse = {
      requestId: 'req-select',
      actionId: 'task-select',
      executionGeneration: 0,
      status: 'select_experiment',
      outputs: {},
      // Missing required dagMutation field
    } as unknown as WorkResponse;

    orchestrator.handleWorkerResponse(badResponse);

    const row = adapter.loadTasks(wf.id).find((t) => t.id === 'task-select')!;
    expect(row.status).toBe('failed');
    expect(row.execution.protocolErrorCode).toBe('MALFORMED_RESPONSE');
    expect(row.execution.protocolErrorMessage).toContain('select_experiment');
    expect(row.execution.error).toMatch(/^Protocol error:/);
    expect(row.execution.exitCode).toBe(1);
    expect(row.execution.completedAt).toBeDefined();

    const status = (orchestrator as any).scheduler.getStatus();
    expect(status.runningCount).toBe(0);
  });

  it('unknown actionId does not mutate unrelated tasks', () => {
    adapter.saveTask(wf.id, baseTask('task-a'));
    adapter.saveTask(wf.id, baseTask('task-b'));
    orchestrator.syncFromDb(wf.id);

    // Start both tasks
    adapter.updateTask('task-a', {
      status: 'running',
      execution: { startedAt: new Date() },
    });
    adapter.updateTask('task-b', {
      status: 'running',
      execution: { startedAt: new Date() },
    });
    orchestrator.syncFromDb(wf.id);
    orchestrator.startExecution();

    const badResponse = {
      requestId: 'req-unknown',
      actionId: 'task-does-not-exist',
      status: 'this_is_not_a_valid_status',
      outputs: { exitCode: 1, error: 'x' },
    } as unknown as WorkResponse;

    orchestrator.handleWorkerResponse(badResponse);

    // Both tasks should remain running (no mutation)
    const rowA = adapter.loadTasks(wf.id).find((t) => t.id === 'task-a')!;
    const rowB = adapter.loadTasks(wf.id).find((t) => t.id === 'task-b')!;
    expect(rowA.status).toBe('running');
    expect(rowB.status).toBe('running');
  });

  it('atomic rollback leaves task+attempt consistent when attempt update fails', () => {
    adapter.saveTask(wf.id, baseTask('task-atomic'));
    orchestrator.syncFromDb(wf.id);
    orchestrator.startExecution();

    // Create a running attempt
    const attempts = adapter.loadAttempts('task-atomic');
    const latestAttempt = attempts[attempts.length - 1];
    expect(latestAttempt).toBeDefined();

    // Monkey-patch updateAttempt to throw on first call
    let callCount = 0;
    const originalUpdateAttempt = adapter.updateAttempt.bind(adapter);
    adapter.updateAttempt = function(attemptId: string, changes: any) {
      callCount++;
      if (callCount === 1) {
        throw new Error('Simulated updateAttempt failure');
      }
      return originalUpdateAttempt(attemptId, changes);
    };

    const badResponse = {
      requestId: 'req-atomic',
      actionId: 'task-atomic',
      status: 'this_is_not_a_valid_status',
      outputs: { exitCode: 1, error: 'x' },
    } as unknown as WorkResponse;

    // The call should throw or surface the error
    expect(() => {
      orchestrator.handleWorkerResponse(badResponse);
    }).toThrow();

    // Verify rollback: task should still be at running status
    const taskRow = adapter.loadTasks(wf.id).find((t) => t.id === 'task-atomic')!;
    expect(taskRow.status).toBe('running');

    // Verify attempt is still running
    const attemptsAfter = adapter.loadAttempts('task-atomic');
    const latestAfter = attemptsAfter[attemptsAfter.length - 1];
    expect(latestAfter.status).toBe('running');
  });
});
