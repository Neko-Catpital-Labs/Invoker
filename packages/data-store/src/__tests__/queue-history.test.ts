import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SQLiteAdapter } from '../sqlite-adapter.js';
import type { Workflow } from '../adapter.js';
import { resolveTaskConfig, type Attempt, type TaskState } from '@invoker/workflow-core';

interface QueueHistoryRow {
  id: number;
  event_type: string;
  workflow_id: string | null;
  task_id: string | null;
  attempt_id: string | null;
  dispatch_id: number | null;
  resource_key: string | null;
  from_state: string | null;
  to_state: string;
  queue_position: number | null;
  queue_size: number | null;
  payload_json: string;
  unknown_fields: string;
}

const WORKFLOW: Workflow = {
  id: 'wf-history',
  name: 'Queue history',
  status: 'pending',
  createdAt: '2026-09-15T00:00:00.000Z',
  updatedAt: '2026-09-15T00:00:00.000Z',
};

function makeTask(id: string, selectedAttemptId: string): TaskState {
  return {
    id,
    description: id,
    status: 'pending',
    dependencies: [],
    createdAt: new Date('2026-09-15T00:00:00.000Z'),
    config: resolveTaskConfig({ workflowId: WORKFLOW.id, command: `echo ${id}` }),
    execution: { selectedAttemptId, generation: 1 },
    taskStateVersion: 1,
  };
}

function makeAttempt(id: string, nodeId: string, queuePriority: number): Attempt {
  return {
    id,
    nodeId,
    queuePriority,
    status: 'pending',
    upstreamAttemptIds: [],
    createdAt: new Date('2026-09-15T00:00:00.000Z'),
  };
}

function historyRows(adapter: SQLiteAdapter): QueueHistoryRow[] {
  return (adapter as any).queryAll(
    `SELECT id, event_type, workflow_id, task_id, attempt_id, dispatch_id, resource_key,
            from_state, to_state, queue_position, queue_size, payload_json, unknown_fields
       FROM queue_history
      ORDER BY id ASC`,
  ) as QueueHistoryRow[];
}

function payload(row: QueueHistoryRow): Record<string, unknown> {
  return JSON.parse(row.payload_json) as Record<string, unknown>;
}

function unknownFields(row: QueueHistoryRow): string[] {
  return JSON.parse(row.unknown_fields) as string[];
}

describe('queue history persistence', () => {
  let cleanup: (() => void) | undefined;

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
  });

  it('records queue positions, transitions, executor admission, settlement, reload, and unknown results', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'invoker-queue-history-'));
    cleanup = () => rmSync(dir, { recursive: true, force: true });
    const dbPath = join(dir, 'invoker.db');

    const adapter = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
    adapter.saveWorkflow(WORKFLOW);
    adapter.saveTask(WORKFLOW.id, makeTask('task-low', 'attempt-low'));
    adapter.saveTask(WORKFLOW.id, makeTask('task-high', 'attempt-high'));
    adapter.saveAttempt(makeAttempt('attempt-low', 'task-low', 5));
    adapter.saveAttempt(makeAttempt('attempt-high', 'task-high', 1));

    adapter.enqueueLaunchDispatch({
      taskId: 'task-low',
      attemptId: 'attempt-low',
      workflowId: WORKFLOW.id,
      priority: 5,
      generation: 1,
    });
    adapter.enqueueLaunchDispatch({
      taskId: 'task-high',
      attemptId: 'attempt-high',
      workflowId: WORKFLOW.id,
      priority: 1,
      generation: 1,
    });

    const expectedFirst = (adapter as any).queryOne(
      `SELECT task_id
         FROM task_launch_dispatch
        WHERE state = 'enqueued'
        ORDER BY CAST(priority AS INTEGER) ASC, id ASC
        LIMIT 1`,
    )?.task_id;
    const leased = adapter.claimLaunchDispatchAtomic({
      ownerId: 'dispatcher-1',
      nowIso: '2026-09-15T00:00:10.000Z',
    });
    expect(leased?.taskId).toBe(expectedFirst);
    expect(leased?.taskId).toBe('task-high');

    adapter.updateTask('task-high', { status: 'running' });
    adapter.markLaunchDispatchAccepted(leased!.id, '2026-09-15T00:00:11.000Z');
    expect(adapter.claimExecutionResourceLease({
      resourceKey: 'pool:ssh:1',
      resourceType: 'ssh',
      holderId: 'attempt-high',
      taskId: 'task-high',
      poolId: 'ssh',
      poolMemberId: '1',
    })).toBe(true);
    adapter.updateAttempt('attempt-high', {
      status: 'completed',
      completedAt: new Date('2026-09-15T00:01:00.000Z'),
      exitCode: 0,
    });
    adapter.updateTask('task-high', {
      status: 'completed',
      execution: { completedAt: new Date('2026-09-15T00:01:00.000Z'), exitCode: 0 },
    });
    expect(adapter.markLaunchDispatchCompleted(leased!.id, '2026-09-15T00:01:01.000Z')).toBe(true);
    adapter.releaseExecutionResourceLease('pool:ssh:1', 'attempt-high');
    adapter.releaseExecutionResourceLease('missing-resource', 'missing-holder');

    const rows = historyRows(adapter);
    const snapshots = rows.filter((row) => row.event_type === 'queue_snapshot');
    expect(snapshots).toEqual(expect.arrayContaining([
      expect.objectContaining({
        workflow_id: WORKFLOW.id,
        task_id: 'task-high',
        attempt_id: 'attempt-high',
        to_state: 'enqueued',
        queue_position: 1,
        queue_size: 2,
      }),
      expect.objectContaining({
        workflow_id: WORKFLOW.id,
        task_id: 'task-low',
        attempt_id: 'attempt-low',
        to_state: 'enqueued',
        queue_position: 1,
        queue_size: 1,
      }),
    ]));

    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event_type: 'dispatch_state_transition',
        task_id: 'task-high',
        from_state: 'enqueued',
        to_state: 'leased',
      }),
      expect.objectContaining({
        event_type: 'dispatch_state_transition',
        task_id: 'task-high',
        from_state: 'leased',
        to_state: 'completed',
      }),
      expect.objectContaining({
        event_type: 'task_state_transition',
        task_id: 'task-high',
        from_state: 'pending',
        to_state: 'running',
      }),
      expect.objectContaining({
        event_type: 'attempt_state_transition',
        task_id: 'task-high',
        attempt_id: 'attempt-high',
        from_state: 'pending',
        to_state: 'completed',
      }),
      expect.objectContaining({
        event_type: 'workflow_state_transition',
        workflow_id: WORKFLOW.id,
        from_state: 'pending',
        to_state: 'running',
      }),
      expect.objectContaining({
        event_type: 'executor_admission',
        task_id: 'task-high',
        resource_key: 'pool:ssh:1',
        to_state: 'leased',
      }),
      expect.objectContaining({
        event_type: 'executor_settlement',
        task_id: 'task-high',
        resource_key: 'pool:ssh:1',
        from_state: 'leased',
        to_state: 'released',
      }),
    ]));

    const unknownSettlement = rows.find((row) => row.resource_key === 'missing-resource');
    expect(unknownSettlement).toMatchObject({
      event_type: 'executor_settlement',
      task_id: null,
      from_state: null,
      to_state: 'unknown',
    });
    expect(unknownFields(unknownSettlement!)).toEqual(expect.arrayContaining([
      'task_id',
      'resource_type',
      'from_state',
      'to_state',
    ]));

    const queuedLow = snapshots.filter((row) => row.task_id === 'task-low').at(-1);
    const completedHigh = rows.find((row) => row.task_id === 'task-high' && row.to_state === 'completed');
    expect(queuedLow).toMatchObject({ to_state: 'enqueued', queue_position: 1, queue_size: 1 });
    expect(completedHigh).toBeDefined();
    expect(payload(queuedLow!)).toMatchObject({ cause: 'claimLaunchDispatchAtomic' });

    const beforeReloadCount = rows.length;
    adapter.close();

    const reloaded = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
    try {
      const reloadedRows = historyRows(reloaded);
      expect(reloadedRows).toHaveLength(beforeReloadCount);
      expect(reloadedRows.at(-1)).toMatchObject({
        event_type: 'executor_settlement',
        resource_key: 'missing-resource',
        to_state: 'unknown',
      });
    } finally {
      reloaded.close();
    }
  });

  it('records an expired settlement when claim-time reclaim evicts a stale holder', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'invoker-queue-history-reclaim-'));
    cleanup = () => rmSync(dir, { recursive: true, force: true });

    const adapter = await SQLiteAdapter.create(join(dir, 'invoker.db'), { ownerCapability: true });
    try {
      expect(adapter.claimExecutionResourceLease({
        resourceKey: 'pool:ssh:1',
        resourceType: 'ssh',
        holderId: 'attempt-stale',
        taskId: 'task-stale',
        leaseMs: -1000,
      })).toBe(true);

      expect(adapter.claimExecutionResourceLease({
        resourceKey: 'pool:ssh:1',
        resourceType: 'ssh',
        holderId: 'attempt-next',
        taskId: 'task-next',
      })).toBe(true);

      const rows = historyRows(adapter);
      const expired = rows.filter((row) => row.to_state === 'expired');
      expect(expired).toHaveLength(1);
      expect(expired[0]).toMatchObject({
        event_type: 'executor_settlement',
        resource_key: 'pool:ssh:1',
        task_id: 'task-stale',
        from_state: 'leased',
      });
      expect(payload(expired[0])).toMatchObject({ source: 'claimExecutionResourceLease' });
      expect(unknownFields(expired[0])).toEqual([]);

      const admissionNext = rows.find(
        (row) => row.event_type === 'executor_admission' && row.task_id === 'task-next',
      );
      expect(admissionNext).toBeDefined();
      expect(expired[0].id).toBeLessThan(admissionNext!.id);
    } finally {
      adapter.close();
    }
  });
  async function twoDispatchAdapter(): Promise<SQLiteAdapter> {
    const dir = mkdtempSync(join(tmpdir(), 'invoker-queue-history-'));
    cleanup = () => rmSync(dir, { recursive: true, force: true });
    const adapter = await SQLiteAdapter.create(join(dir, 'invoker.db'), { ownerCapability: true });
    adapter.saveWorkflow(WORKFLOW);
    for (const [task, attempt] of [['task-a', 'attempt-a'], ['task-b', 'attempt-b']] as const) {
      adapter.saveTask(WORKFLOW.id, makeTask(task, attempt));
      adapter.saveAttempt(makeAttempt(attempt, task, 1));
      adapter.enqueueLaunchDispatch({ taskId: task, attemptId: attempt, workflowId: WORKFLOW.id, priority: 1, generation: 1 });
    }
    return adapter;
  }

  function eventsFrom(adapter: SQLiteAdapter, source: string): QueueHistoryRow[] {
    return historyRows(adapter).filter((row) => {
      const p = payload(row);
      return p.source === source || p.cause === source;
    });
  }

  it('records one executor admission when a dispatch is accepted twice', async () => {
    const adapter = await twoDispatchAdapter();
    const leased = adapter.claimLaunchDispatchAtomic({ ownerId: 'd', nowIso: '2026-09-15T00:00:10.000Z' });
    adapter.markLaunchDispatchAccepted(leased!.id, '2026-09-15T00:00:11.000Z');
    adapter.markLaunchDispatchAccepted(leased!.id, '2026-09-15T00:00:12.000Z');
    expect(historyRows(adapter).filter((row) => row.event_type === 'executor_admission')).toHaveLength(1);
  });

  it('writes every bulk abandonment before one snapshot per workflow', async () => {
    const adapter = await twoDispatchAdapter();
    adapter.abandonLaunchDispatchesForTasks(['task-a', 'task-b'], 'reset', '2026-09-15T00:00:20.000Z');
    expect(eventsFrom(adapter, 'abandonLaunchDispatchesForTasks').map((row) => row.event_type)).toEqual([
      'dispatch_state_transition',
      'dispatch_state_transition',
      'queue_snapshot',
    ]);
  });

  it('writes every bulk requeue before one snapshot per workflow', async () => {
    const adapter = await twoDispatchAdapter();
    adapter.claimLaunchDispatchAtomic({ ownerId: 'd', nowIso: '2026-09-15T00:00:10.000Z' });
    adapter.claimLaunchDispatchAtomic({ ownerId: 'd', nowIso: '2026-09-15T00:00:10.000Z' });
    adapter.reapExpiredLaunchDispatchLeases({ nowIso: '2026-09-16T00:00:00.000Z' });
    const types = eventsFrom(adapter, 'reapExpiredLaunchDispatchLeases').map((row) => row.event_type);
    expect(types.slice(0, 2)).toEqual(['dispatch_state_transition', 'dispatch_state_transition']);
    expect(types.slice(2).every((type) => type === 'queue_snapshot')).toBe(true);
    expect(types.length).toBeGreaterThan(2);
  });
});
