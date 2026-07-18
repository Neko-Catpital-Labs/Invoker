import { describe, expect, it, vi } from 'vitest';

import type { WorkerActionRecord, WorkerActionWrite, WorkflowMutationPriority } from '@invoker/data-store';
import type { TaskState } from '@invoker/workflow-core';

import {
  isMeaningfulSkipReason,
  recordWorkerDecisionRow,
} from '../worker-decision-ledger.js';
import { createAutoFixRecoveryTick } from '../auto-fix-recovery.js';
import { createAutoFixAttemptLedger } from '../auto-fix-attempt-ledger.js';

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  child: vi.fn(),
};

function makeActionStore() {
  const actions = new Map<string, WorkerActionRecord>();
  return {
    actions,
    getWorkerAction: vi.fn((kind: string, externalKey: string) => actions.get(`${kind}:${externalKey}`)),
    upsertWorkerAction: vi.fn((write: WorkerActionWrite) => {
      const key = `${write.workerKind}:${write.externalKey}`;
      const existing = actions.get(key);
      const saved = {
        ...write,
        attemptCount: write.attemptCount ?? 0,
        id: existing?.id ?? write.id,
        createdAt: existing?.createdAt ?? '2026-01-01T00:00:00.000Z',
        updatedAt: write.updatedAt ?? '2026-01-01T00:00:00.000Z',
      } as WorkerActionRecord;
      actions.set(key, saved);
      return saved;
    }),
  };
}

describe('recordWorkerDecisionRow', () => {
  it('derives the row id from workerKind/externalKey and folds reason into payload', () => {
    const store = makeActionStore();
    const row = recordWorkerDecisionRow(store, {
      workerKind: 'autofix',
      actionType: 'auto-fix',
      externalKey: 'autofix:wf-1/t:0:a1',
      subjectType: 'task',
      subjectId: 'wf-1/t',
      status: 'skipped',
      summary: 'skipped it',
      reason: 'not-eligible',
    });
    expect(row?.id).toBe('autofix:autofix:wf-1/t:0:a1');
    expect(row?.status).toBe('skipped');
    expect(row?.payload).toMatchObject({ reason: 'not-eligible' });
    expect(row?.completedAt).toBeDefined();
  });

  it('preserves the id and increments attemptCount across ticks when requested', () => {
    const store = makeActionStore();
    const base = {
      workerKind: 'autofix',
      actionType: 'auto-fix',
      externalKey: 'autofix:wf-1/t:0:a1',
      subjectType: 'task',
      subjectId: 'wf-1/t',
      summary: 'queued',
      incrementAttempt: true,
    } as const;
    const first = recordWorkerDecisionRow(store, { ...base, status: 'queued' });
    const second = recordWorkerDecisionRow(store, { ...base, status: 'queued' });
    expect(first?.attemptCount).toBe(1);
    expect(second?.attemptCount).toBe(2);
    expect(second?.id).toBe(first?.id);
    // A non-terminal status leaves completedAt unset.
    expect(second?.completedAt).toBeUndefined();
  });

  it('no-ops when the store cannot persist worker actions', () => {
    const row = recordWorkerDecisionRow({}, {
      workerKind: 'autofix',
      actionType: 'auto-fix',
      externalKey: 'k',
      subjectType: 'task',
      subjectId: 't',
      status: 'queued',
      summary: 's',
    });
    expect(row).toBeUndefined();
  });
});

describe('isMeaningfulSkipReason', () => {
  it('treats terminal/decision-grade reasons as meaningful', () => {
    expect(isMeaningfulSkipReason('worker-retry-budget-exhausted')).toBe(true);
    expect(isMeaningfulSkipReason('retry-budget-disabled')).toBe(true);
    expect(isMeaningfulSkipReason('not-eligible')).toBe(true);
  });

  it('treats scan noise as routine (not recorded)', () => {
    expect(isMeaningfulSkipReason('stale-generation')).toBe(false);
    expect(isMeaningfulSkipReason('task-not-found')).toBe(false);
    expect(isMeaningfulSkipReason('already-queued-intent')).toBe(false);
    expect(isMeaningfulSkipReason('lock-held')).toBe(false);
  });
});

function makeFailedTask(overrides: Partial<TaskState['execution']> = {}): TaskState {
  return {
    id: 'wf-1/task-a',
    description: 'task a',
    status: 'failed',
    dependencies: [],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    config: { workflowId: 'wf-1' },
    execution: {
      generation: 1,
      selectedAttemptId: 'a1',
      error: 'boom',
      ...overrides,
    },
    taskStateVersion: 3,
  } as TaskState;
}

function makeAutoFixHarness(options: {
  latestTask?: TaskState | undefined;
  scanTask?: TaskState;
} = {}) {
  const scanTask = options.scanTask ?? makeFailedTask();
  const latestTask = 'latestTask' in options ? options.latestTask : scanTask;
  const store = {
    listWorkflows: vi.fn(() => [{ id: 'wf-1' }]),
    loadTasks: vi.fn((workflowId: string) => (workflowId === 'wf-1' ? [scanTask] : [])),
    loadTask: vi.fn(() => latestTask),
    listWorkflowMutationIntents: vi.fn(() => []),
    getWorkerAction: vi.fn(() => undefined),
    upsertWorkerAction: vi.fn((write: WorkerActionWrite) => ({
      ...write,
      attemptCount: write.attemptCount ?? 0,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    } as WorkerActionRecord)),
    logEvent: vi.fn(),
  };
  const submit = vi.fn((_workflowId: string, _priority: WorkflowMutationPriority, _channel: string, _args: unknown[]) => 42);
  return { store, submit };
}

const tickCtx = { identity: { kind: 'recovery', instanceId: 'test' }, reason: 'poll' as const, tickNumber: 1, signal: new AbortController().signal };

describe('autofix decision ledger', () => {
  it('records a queued decision row when it escalates to an auto-fix on the second tick', async () => {
    const { store, submit } = makeAutoFixHarness();
    const upserts: WorkerActionWrite[] = [];
    store.upsertWorkerAction = vi.fn((write: WorkerActionWrite) => {
      upserts.push(write);
      return {
        ...write,
        attemptCount: write.attemptCount ?? 0,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      } as WorkerActionRecord;
    });
    store.getWorkerAction = vi.fn((kind: string, externalKey: string) => {
      if (kind !== 'autofix') return undefined;
      if (!externalKey.startsWith('autofix:retry:')) return undefined;
      const retryUpsert = upserts.find((w) => w.workerKind === 'autofix' && w.externalKey === externalKey);
      if (!retryUpsert) return undefined;
      return {
        ...retryUpsert,
        attemptCount: retryUpsert.attemptCount ?? 0,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      } as WorkerActionRecord;
    });
    const tick = createAutoFixRecoveryTick({
      store,
      submitter: { submit },
      logger,
      attemptLedger: createAutoFixAttemptLedger(),
      defaultAutoFixRetries: 2,
      getAutoFixAgent: () => 'claude',
    });

    await tick(tickCtx);
    await tick(tickCtx);

    expect(submit).toHaveBeenCalledTimes(2);
    expect(submit.mock.calls[0]?.[2]).toBe('invoker:restart-task');
    expect(submit.mock.calls[1]?.[2]).toBe('invoker:fix-with-agent');
    const autoFixWrite = upserts.find((w) => w.actionType === 'auto-fix');
    expect(autoFixWrite).toMatchObject({
      workerKind: 'autofix',
      actionType: 'auto-fix',
      status: 'queued',
      subjectType: 'task',
      subjectId: 'wf-1/task-a',
      attemptCount: 1,
      intentId: '42',
      agentName: 'claude',
    });
    expect(autoFixWrite?.externalKey).toBe('autofix:wf-1/task-a:1:a1');
  });

  it('records a skipped decision row for a meaningful skip (budget disabled)', async () => {
    const { store, submit } = makeAutoFixHarness();
    const tick = createAutoFixRecoveryTick({
      store,
      submitter: { submit },
      logger,
      attemptLedger: createAutoFixAttemptLedger(),
      defaultAutoFixRetries: 0,
    });

    await tick(tickCtx);

    expect(submit).not.toHaveBeenCalled();
    const write = store.upsertWorkerAction.mock.calls.at(-1)?.[0];
    expect(write).toMatchObject({ status: 'skipped', subjectId: 'wf-1/task-a' });
    expect(write?.payload).toMatchObject({ reason: 'retry-budget-disabled' });
  });

  it('does not record a row for a routine skip (stale generation)', async () => {
    // Scan sees generation 1; the latest persisted task moved to generation 2.
    const { store, submit } = makeAutoFixHarness({
      scanTask: makeFailedTask({ generation: 1 }),
      latestTask: makeFailedTask({ generation: 2 }),
    });
    const tick = createAutoFixRecoveryTick({
      store,
      submitter: { submit },
      logger,
      attemptLedger: createAutoFixAttemptLedger(),
      defaultAutoFixRetries: 2,
    });

    await tick(tickCtx);

    expect(submit).not.toHaveBeenCalled();
    expect(store.upsertWorkerAction).not.toHaveBeenCalled();
  });
});
