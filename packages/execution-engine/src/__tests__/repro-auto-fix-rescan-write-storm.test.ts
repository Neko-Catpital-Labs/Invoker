import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { WorkerActionRecord, WorkerActionWrite } from '@invoker/data-store';
import type { TaskState } from '@invoker/workflow-core';

import { createAutoFixAttemptLedger } from '../auto-fix-attempt-ledger.js';
import { createAutoFixRecoveryTick } from '../auto-fix-recovery.js';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn() };

const FAILED_TASKS = 60;
const WORKFLOWS = 90;
const TICKS = 10;
const UNPAUSED_BREAKER_PATH = join(tmpdir(), `repro-rescan-write-storm-${process.pid}-no-pause.json`);

function makeIneligibleFailedTask(index: number): TaskState {
  return {
    id: `wf-0/child-${index}`,
    description: `child ${index}`,
    status: 'failed',
    dependencies: [],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    config: { workflowId: 'wf-0', command: 'true', parentTask: 'wf-0/parent' },
    execution: { generation: 0, selectedAttemptId: `attempt-${index}`, error: 'exit 1' },
    taskStateVersion: 7,
  } as TaskState;
}

function makeStore() {
  const tasks = Array.from({ length: FAILED_TASKS }, (_, i) => makeIneligibleFailedTask(i));
  const workflows = Array.from({ length: WORKFLOWS }, (_, i) => ({
    id: `wf-${i}`,
    name: `workflow ${i}`,
    repoUrl: 'https://example.com/repo.git',
  }));
  const actions = new Map<string, WorkerActionRecord>();
  return {
    listWorkflows: vi.fn(() => workflows),
    loadTasks: vi.fn((workflowId: string) => (workflowId === 'wf-0' ? tasks : [])),
    loadTask: vi.fn((taskId: string) => tasks.find((task) => task.id === taskId)),
    listWorkflowMutationIntents: vi.fn(() => []),
    getWorkerAction: vi.fn((kind: string, key: string) => actions.get(`${kind}:${key}`)),
    upsertWorkerAction: vi.fn((write: WorkerActionWrite) => {
      const saved = {
        ...write,
        attemptCount: write.attemptCount ?? 0,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      } as WorkerActionRecord;
      actions.set(`${write.workerKind}:${write.externalKey}`, saved);
      return saved;
    }),
    logEvent: vi.fn(),
  };
}

describe('auto-fix recovery rescan write storm (beachball incident 2026-09-12)', () => {
  it.fails('does not re-write skip rows for failed tasks whose state has not changed', async () => {
    const store = makeStore();
    const tick = createAutoFixRecoveryTick({
      store,
      submitter: { submit: vi.fn(() => 1) },
      logger,
      attemptLedger: createAutoFixAttemptLedger(),
      defaultAutoFixRetries: 3,
      getAutoFixAgent: () => 'codex',
      circuitBreakerPath: UNPAUSED_BREAKER_PATH,
    });

    await tick({ reason: 'wake' } as never);
    const eventsAfterFirstScan = store.logEvent.mock.calls.length;
    const upsertsAfterFirstScan = store.upsertWorkerAction.mock.calls.length;

    for (let i = 1; i < TICKS; i += 1) {
      await tick({ reason: 'wake' } as never);
    }

    console.log(
      `[repro] ticks=${TICKS} failedTasks=${FAILED_TASKS} `
      + `logEvent: first=${eventsAfterFirstScan} total=${store.logEvent.mock.calls.length} `
      + `upsertWorkerAction: first=${upsertsAfterFirstScan} total=${store.upsertWorkerAction.mock.calls.length} `
      + `listWorkflows calls=${store.listWorkflows.mock.calls.length}`,
    );

    expect(store.logEvent.mock.calls.length).toBe(eventsAfterFirstScan);
    expect(store.upsertWorkerAction.mock.calls.length).toBe(upsertsAfterFirstScan);
  });

  it.fails('records the skip again once the failed task changes', async () => {
    const store = makeStore();
    const tick = createAutoFixRecoveryTick({
      store,
      submitter: { submit: vi.fn(() => 1) },
      logger,
      attemptLedger: createAutoFixAttemptLedger(),
      defaultAutoFixRetries: 3,
      getAutoFixAgent: () => 'codex',
      circuitBreakerPath: UNPAUSED_BREAKER_PATH,
    });

    await tick({ reason: 'wake' } as never);
    const eventsAfterFirstScan = store.logEvent.mock.calls.length;

    const changed = store.loadTasks('wf-0')[0];
    changed.taskStateVersion += 1;
    await tick({ reason: 'wake' } as never);

    const newCalls = store.logEvent.mock.calls.slice(eventsAfterFirstScan);
    expect(newCalls.map(([taskId]) => taskId)).toEqual([changed.id, changed.id]);
  });

  it.fails('lists workflows a bounded number of times per scan, not once per failed task', async () => {
    const store = makeStore();
    const tick = createAutoFixRecoveryTick({
      store,
      submitter: { submit: vi.fn(() => 1) },
      logger,
      attemptLedger: createAutoFixAttemptLedger(),
      defaultAutoFixRetries: 3,
      getAutoFixAgent: () => 'codex',
      circuitBreakerPath: UNPAUSED_BREAKER_PATH,
    });

    await tick({ reason: 'wake' } as never);

    expect(store.listWorkflows.mock.calls.length).toBeLessThanOrEqual(2);
  });
});
