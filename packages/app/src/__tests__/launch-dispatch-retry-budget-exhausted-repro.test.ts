import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SQLiteAdapter } from '@invoker/data-store';
import {
  LAUNCH_STUCK_ABANDON_MS,
  MAX_STUCK_LEASE_RETRIES,
  type Logger,
} from '@invoker/contracts';
import {
  createAttempt,
  Orchestrator,
  type OrchestratorPersistence,
} from '@invoker/workflow-core';
import { InMemoryBus } from '@invoker/test-kit';
import { LaunchDispatcher } from '../launch-dispatcher.js';

describe('launch-dispatcher retry-budget exhaustion', () => {
  let adapter: SQLiteAdapter;

  beforeEach(async () => {
    adapter = await SQLiteAdapter.create(':memory:');
  });

  afterEach(() => {
    adapter.close();
  });

  function makeLogger(): Logger {
    return {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      child(): Logger {
        return this;
      },
    };
  }

  function setDispatchLeasedAndStale(rowId: number, startedAtMs: number): void {
    const startedIso = new Date(startedAtMs).toISOString();
    const staleIso = new Date(startedAtMs + LAUNCH_STUCK_ABANDON_MS + 1_000).toISOString();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).db.run(
      `UPDATE task_launch_dispatch
         SET state = 'leased',
             dispatch_owner = 'owner-test',
             enqueued_at = ?,
             fenced_until = ?
       WHERE id = ?`,
      [startedIso, staleIso, rowId],
    );
  }

  it('fails a launching task once stuck-lease abandon count exceeds the retry budget', () => {
    const orchestrator = new Orchestrator({
      persistence: adapter as OrchestratorPersistence,
      messageBus: new InMemoryBus(),
      maxConcurrency: 1,
    });
    orchestrator.loadPlan({
      name: 'wf-budget-exhausted',
      tasks: [{ id: 'fix-ci', description: 'fix-ci', command: 'sleep 999' }],
    });

    const workflowId = adapter.listWorkflows()[0]?.id;
    if (!workflowId) throw new Error('Expected workflow to be persisted');
    const taskId = `${workflowId}/fix-ci`;
    const targetAbandons = MAX_STUCK_LEASE_RETRIES + 3;
    const startedAtMs = Date.parse('2026-08-02T05:48:00.000Z');

    for (let i = 0; i < targetAbandons - 1; i += 1) {
      const attempt = createAttempt(taskId, { status: 'superseded' });
      adapter.saveAttempt(attempt);
      const row = adapter.enqueueLaunchDispatch({
        taskId,
        attemptId: attempt.id,
        workflowId,
        generation: i,
      });
      expect(
        adapter.markLaunchDispatchAbandoned(row.id, 'prior stuck launch', undefined, 'stuck-lease'),
      ).toBe(true);
    }

    const currentAttempt = createAttempt(taskId, {
      status: 'running',
      startedAt: new Date(startedAtMs),
      lastHeartbeatAt: new Date(startedAtMs),
    });
    adapter.saveAttempt(currentAttempt);
    adapter.updateTask(taskId, {
      status: 'running',
      execution: {
        selectedAttemptId: currentAttempt.id,
        generation: targetAbandons,
        startedAt: new Date(startedAtMs),
        lastHeartbeatAt: new Date(startedAtMs),
        phase: 'launching',
        launchStartedAt: new Date(startedAtMs),
      },
    });
    const currentRow = adapter.enqueueLaunchDispatch({
      taskId,
      attemptId: currentAttempt.id,
      workflowId,
      generation: targetAbandons,
    });
    setDispatchLeasedAndStale(currentRow.id, startedAtMs);

    const dispatcher = new LaunchDispatcher({
      persistence: adapter,
      orchestrator: {
        prepareTaskForNewAttempt: (id, reason) => orchestrator.prepareTaskForNewAttempt(id, reason),
        failTask: (id, reason) => orchestrator.failTask(id, reason),
      },
      ownerId: 'owner-test',
      logger: makeLogger(),
    });

    const nowIso = new Date(startedAtMs + LAUNCH_STUCK_ABANDON_MS + 60_000).toISOString();
    expect(dispatcher.abandonStuckLeases(nowIso)).toBe(1);
    expect(adapter.countAbandonedLaunchDispatchesForTask(taskId)).toBe(targetAbandons);

    const task = adapter.loadTask(taskId);
    expect(task?.status).toBe('failed');
    expect(task?.execution.error).toContain('Launch dispatch abandoned');
  });
});
