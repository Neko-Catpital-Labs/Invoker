import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteAdapter } from '@invoker/data-store';
import type { Workflow } from '@invoker/data-store';
import { createAttempt, type TaskState } from '@invoker/workflow-core';

import {
  buildRecoveryWorkerAuditPayload,
  collectRecoveryWorkerStatus,
  recoveryWorkerEventType,
} from '../recovery-worker-observability.js';
import {
  AUTO_FIX_WORKER_KIND,
  createWorkerRegistry,
  type WorkerRuntimeDependencies,
} from '@invoker/execution-engine';
import { createWorkerRuntimeController } from '../worker-control.js';

function makeWorkflow(id: string, name: string): Workflow {
  return {
    id,
    name,
    status: 'running',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
  };
}

function makeTask(id: string, overrides: Partial<TaskState> = {}): TaskState {
  return {
    id,
    description: `Task ${id}`,
    status: 'pending',
    dependencies: [],
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    config: {},
    execution: {},
    taskStateVersion: 1,
    ...overrides,
  };
}

describe('main-process read hot-path cost guards', () => {
  let tmpDir: string | undefined;
  let adapter: SQLiteAdapter | undefined;

  afterEach(async () => {
    await adapter?.close();
    adapter = undefined;
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  it('collects recovery status from aggregates without per-task getEvents under a fat events table', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'invoker-hotpath-'));
    adapter = await SQLiteAdapter.create(join(tmpDir, 'invoker.db'), { ownerCapability: true });

    const taskCount = 40;
    const eventsPerTask = 250; // 10k events total
    adapter.runInTransaction(() => {
      adapter.saveWorkflow(makeWorkflow('wf-fat', 'Fat events'));

      for (let t = 0; t < taskCount; t += 1) {
        const taskId = `wf-fat/t${t}`;
        adapter.saveTask('wf-fat', makeTask(taskId));
        for (let e = 0; e < eventsPerTask; e += 1) {
          const action = e % 4 === 0 ? 'wakeup'
            : e % 4 === 1 ? 'scan'
              : e % 4 === 2 ? 'submit'
                : 'skip';
          adapter.logEvent(
            taskId,
            recoveryWorkerEventType(action),
            buildRecoveryWorkerAuditPayload(action, `${action}-phase`, {
              workflowId: 'wf-fat',
              reason: action === 'skip' ? 'budget' : undefined,
            }),
          );
        }
      }
    });

    const getEvents = vi.spyOn(adapter, 'getEvents');
    const started = Date.now();
    const status = collectRecoveryWorkerStatus(adapter);
    const elapsedMs = Date.now() - started;

    expect(getEvents).not.toHaveBeenCalled();
    expect(status.wakeups + status.scans + status.submissions + status.skips).toBe(taskCount * eventsPerTask);
    expect(status.recent.length).toBeGreaterThan(0);
    expect(status.recent.length).toBeLessThanOrEqual(10);
    // Per-type indexed LIMIT+merge must stay well under a 2s UI poll budget.
    expect(elapsedMs).toBeLessThan(50);
  });

  it('projects a stale-pointer task without scanning every attempt under large error blobs', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'invoker-hotpath-'));
    adapter = await SQLiteAdapter.create(join(tmpDir, 'invoker.db'), { ownerCapability: true });

    adapter.saveWorkflow(makeWorkflow('wf-1', 'Attempts'));
    adapter.saveTask('wf-1', makeTask('t1', { status: 'running' }));

    const selectedFailed = {
      ...createAttempt('t1', { status: 'failed' }),
      id: 't1-old',
      createdAt: new Date('2026-07-09T05:00:00.000Z'),
      error: 'boom',
    };
    const newerPending = {
      ...createAttempt('t1', { status: 'pending' }),
      id: 't1-new',
      createdAt: new Date('2026-07-09T06:00:00.000Z'),
      supersedesAttemptId: selectedFailed.id,
    };
    adapter.saveAttempt(selectedFailed);
    adapter.saveAttempt(newerPending);

    const bigError = 'x'.repeat(100_000);
    for (let i = 0; i < 80; i += 1) {
      adapter.saveAttempt({
        ...createAttempt('t1', { status: i % 2 === 0 ? 'failed' : 'superseded' }),
        id: `t1-blob-${i}`,
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)),
        error: bigError,
      });
    }
    adapter.updateTask('t1', { execution: { selectedAttemptId: selectedFailed.id } });

    const queryAll = vi.spyOn(adapter as unknown as { queryAll: (sql: string) => unknown }, 'queryAll');
    const started = Date.now();
    const [task] = adapter.loadTasks('wf-1');
    const elapsedMs = Date.now() - started;

    expect(task.status).toBe('running');
    expect(task.execution.error).toBeUndefined();
    const ranUnboundedScan = queryAll.mock.calls.some(
      ([sql]) =>
        typeof sql === 'string'
        && /FROM attempts\s+WHERE node_id = \?\s+ORDER BY created_at ASC/.test(sql),
    );
    expect(ranUnboundedScan).toBe(false);
    expect(elapsedMs).toBeLessThan(250);
    queryAll.mockRestore();
  });

  it('builds worker-status via indexed actions and recovery aggregates on every snapshot', () => {
    const registry = createWorkerRegistry<WorkerRuntimeDependencies>();
    registry.register({
      kind: AUTO_FIX_WORKER_KIND,
      note: 'autofix',
      factory: () => ({
        identity: { kind: AUTO_FIX_WORKER_KIND, instanceId: 'x' },
        start: vi.fn(),
        wake: vi.fn(),
        tick: vi.fn(async () => {}),
        stop: vi.fn(async () => {}),
        isRunning: vi.fn(() => false),
      }),
    });
    const listWorkerActions = vi.fn(() => []);
    const countEventsByTypes = vi.fn(() => [
      { eventType: recoveryWorkerEventType('wakeup'), count: 0, lastCreatedAt: null },
      { eventType: recoveryWorkerEventType('scan'), count: 0, lastCreatedAt: null },
      { eventType: recoveryWorkerEventType('submit'), count: 0, lastCreatedAt: null },
      { eventType: recoveryWorkerEventType('skip'), count: 0, lastCreatedAt: null },
    ]);
    const getEventsByTypes = vi.fn(() => []);

    const controller = createWorkerRuntimeController({
      registry,
      deps: {
        store: {} as never,
        submitter: { submit: vi.fn(() => 1) },
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      } as never,
      autoStartKinds: [],
      persistence: {
        listWorkerActions,
        listWorkflows: vi.fn(() => []),
        loadTasks: vi.fn(() => []),
        getEvents: vi.fn(() => []),
        countEventsByTypes,
        getEventsByTypes,
      } as never,
      canControl: () => true,
    });

    const first = controller.snapshot();
    const second = controller.snapshot();
    expect(second).not.toBe(first);
    expect(listWorkerActions).toHaveBeenCalledTimes(2);
    expect(countEventsByTypes).toHaveBeenCalledTimes(2);
    expect(listWorkerActions).toHaveBeenCalledWith({ workerKind: AUTO_FIX_WORKER_KIND, limit: 5 });
  });
});
