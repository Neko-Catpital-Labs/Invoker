import { describe, expect, it, vi } from 'vitest';

import type {
  WorkerActionRecord,
  WorkerActionWrite,
  WorkflowMutationPriority,
} from '@invoker/data-store';
import type { TaskState } from '@invoker/workflow-core';

import { createAutoFixAttemptLedger } from '../auto-fix-attempt-ledger.js';
import {
  AUTO_FIX_WORKER_KIND,
  createAutoFixRecoveryTick,
} from '../auto-fix-recovery.js';

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  child: vi.fn(),
};

function makeFailedTask(overrides: Partial<TaskState> = {}): TaskState {
  const { config, execution, ...rest } = overrides;
  return {
    id: 'wf-1/build',
    description: 'build',
    status: 'failed',
    dependencies: [],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    config: {
      workflowId: 'wf-1',
      command: 'pnpm build',
      ...(config ?? {}),
    },
    execution: {
      generation: 2,
      selectedAttemptId: 'attempt-1',
      branch: 'feature/build',
      error: 'pnpm build failed with exit code 1',
      ...(execution ?? {}),
    },
    taskStateVersion: 7,
    ...rest,
  } as TaskState;
}

function toRecord(write: WorkerActionWrite): WorkerActionRecord {
  const now = '2026-01-01T00:00:00.000Z';
  return {
    ...write,
    attemptCount: write.attemptCount ?? 0,
    createdAt: write.createdAt ?? now,
    updatedAt: write.updatedAt ?? now,
  };
}

function makeHarness(task = makeFailedTask()) {
  const tasks = new Map<string, TaskState>([[task.id, task]]);
  const actions = new Map<string, WorkerActionRecord>();
  const submit = vi.fn((_workflowId: string, _priority: WorkflowMutationPriority, _channel: string, _args: unknown[]) => 99);
  const store = {
    listWorkflows: vi.fn(() => [{ id: 'wf-1' }]),
    loadTasks: vi.fn((workflowId: string) => workflowId === 'wf-1' ? Array.from(tasks.values()) : []),
    loadTask: vi.fn((taskId: string) => tasks.get(taskId)),
    listWorkflowMutationIntents: vi.fn(() => []),
    getWorkerAction: vi.fn((workerKind: string, externalKey: string) =>
      actions.get(`${workerKind}:${externalKey}`)),
    upsertWorkerAction: vi.fn((write: WorkerActionWrite) => {
      const key = `${write.workerKind}:${write.externalKey}`;
      const existing = actions.get(key);
      const saved = toRecord({ ...write, id: existing?.id ?? write.id, createdAt: existing?.createdAt });
      actions.set(key, saved);
      return saved;
    }),
    logEvent: vi.fn(),
  };
  const attemptLedger = createAutoFixAttemptLedger();
  return { tasks, actions, store, submit, attemptLedger };
}

describe('AutoFixWorker attempt-0 bare retry', () => {
  it('submits invoker:restart-task on the first tick and does not consume an auto-fix attempt', async () => {
    const harness = makeHarness();
    const tick = createAutoFixRecoveryTick({
      store: harness.store,
      submitter: { submit: harness.submit },
      logger,
      attemptLedger: harness.attemptLedger,
      defaultAutoFixRetries: 3,
      getAutoFixAgent: () => 'codex',
    });

    await tick({ reason: 'poll' } as never);

    expect(harness.submit).toHaveBeenCalledTimes(1);
    const [workflowId, priority, channel, args] = harness.submit.mock.calls[0]!;
    expect(workflowId).toBe('wf-1');
    expect(priority).toBe('normal');
    expect(channel).toBe('invoker:restart-task');
    expect(args).toEqual(['wf-1/build']);

    const retryRow = harness.actions.get(`${AUTO_FIX_WORKER_KIND}:${AUTO_FIX_WORKER_KIND}:retry:wf-1/build`);
    expect(retryRow).toBeDefined();
    expect(retryRow?.actionType).toBe('auto-retry');
    expect(retryRow?.attemptCount).toBe(1);
    expect(retryRow?.status).toBe('queued');
  });

  it('escalates to invoker:fix-with-agent on the next tick once the bare retry row exists', async () => {
    const harness = makeHarness();
    const tick = createAutoFixRecoveryTick({
      store: harness.store,
      submitter: { submit: harness.submit },
      logger,
      attemptLedger: harness.attemptLedger,
      defaultAutoFixRetries: 3,
      getAutoFixAgent: () => 'codex',
    });

    await tick({ reason: 'poll' } as never);
    harness.submit.mockClear();
    await tick({ reason: 'poll' } as never);

    expect(harness.submit).toHaveBeenCalledTimes(1);
    const channel = harness.submit.mock.calls[0]?.[2];
    expect(channel).toBe('invoker:fix-with-agent');

    const fixRow = harness.actions.get(`${AUTO_FIX_WORKER_KIND}:${AUTO_FIX_WORKER_KIND}:wf-1/build:2:attempt-1`);
    expect(fixRow?.actionType).toBe('auto-fix');
    expect(fixRow?.status).toBe('queued');
  });

  it('does not submit twice for the same task within a single tick', async () => {
    const task = makeFailedTask();
    const secondTask = makeFailedTask({ id: 'wf-1/build' });
    const harness = makeHarness(task);
    harness.tasks.set('wf-1/build', secondTask);

    const tick = createAutoFixRecoveryTick({
      store: harness.store,
      submitter: { submit: harness.submit },
      logger,
      attemptLedger: harness.attemptLedger,
      defaultAutoFixRetries: 3,
    });

    await tick({ reason: 'poll' } as never);
    expect(harness.submit).toHaveBeenCalledTimes(1);
  });

  it('respects existing bare-retry row across ledger resets (persistence path)', async () => {
    const harness = makeHarness();
    const retryKey = `${AUTO_FIX_WORKER_KIND}:${AUTO_FIX_WORKER_KIND}:retry:wf-1/build`;
    harness.actions.set(retryKey, toRecord({
      id: retryKey,
      workerKind: AUTO_FIX_WORKER_KIND,
      externalKey: `${AUTO_FIX_WORKER_KIND}:retry:wf-1/build`,
      actionType: 'auto-retry',
      subjectType: 'task',
      subjectId: 'wf-1/build',
      status: 'queued',
      attemptCount: 1,
      workflowId: 'wf-1',
      taskId: 'wf-1/build',
    }));

    const tick = createAutoFixRecoveryTick({
      store: harness.store,
      submitter: { submit: harness.submit },
      logger,
      attemptLedger: createAutoFixAttemptLedger(),
      defaultAutoFixRetries: 3,
      getAutoFixAgent: () => 'codex',
    });

    await tick({ reason: 'poll' } as never);

    expect(harness.submit).toHaveBeenCalledTimes(1);
    expect(harness.submit.mock.calls[0]?.[2]).toBe('invoker:fix-with-agent');
  });

  it('escalates after a generation bump once the bare retry row exists', async () => {
    const harness = makeHarness();
    const tick = createAutoFixRecoveryTick({
      store: harness.store,
      submitter: { submit: harness.submit },
      logger,
      attemptLedger: harness.attemptLedger,
      defaultAutoFixRetries: 3,
      getAutoFixAgent: () => 'codex',
    });

    await tick({ reason: 'poll' } as never);
    expect(harness.submit.mock.calls[0]?.[2]).toBe('invoker:restart-task');
    harness.submit.mockClear();

    // Bare retry succeeded then failed again under a new generation/attempt.
    harness.tasks.set('wf-1/build', makeFailedTask({
      execution: {
        generation: 3,
        selectedAttemptId: 'attempt-2',
        branch: 'feature/build',
        error: 'pnpm build failed with exit code 1',
      },
      taskStateVersion: 8,
    }));

    await tick({ reason: 'poll' } as never);
    expect(harness.submit).toHaveBeenCalledTimes(1);
    expect(harness.submit.mock.calls[0]?.[2]).toBe('invoker:fix-with-agent');
  });

  it('escalates on wake even when drained hints only carry the pre-retry generation', async () => {
    const harness = makeHarness();
    const tick = createAutoFixRecoveryTick({
      store: harness.store,
      submitter: { submit: harness.submit },
      logger,
      attemptLedger: harness.attemptLedger,
      defaultAutoFixRetries: 2,
      getAutoFixAgent: () => 'codex',
      drainWakeupHints: () => [{
        eventKey: 'stale-failure',
        eventKind: 'task.failed',
        workflowId: 'wf-1',
        taskId: 'wf-1/build',
        taskStateVersion: 7,
        generation: 2,
        attemptId: 'attempt-1',
        createdAt: '2026-01-01T00:00:00.000Z',
        reason: 'task_failure',
        authoritative: false,
      }],
    });

    await tick({ reason: 'poll' } as never);
    expect(harness.submit.mock.calls[0]?.[2]).toBe('invoker:restart-task');
    harness.submit.mockClear();

    harness.tasks.set('wf-1/build', makeFailedTask({
      execution: {
        generation: 3,
        selectedAttemptId: 'attempt-2',
        branch: 'feature/build',
        error: 'pnpm build failed with exit code 1',
      },
      taskStateVersion: 8,
    }));

    await tick({ reason: 'wake' } as never);
    expect(harness.submit).toHaveBeenCalledTimes(1);
    expect(harness.submit.mock.calls[0]?.[2]).toBe('invoker:fix-with-agent');
  });

  it('records a recovery.worker.submit audit event for the bare retry', async () => {
    const harness = makeHarness();
    const tick = createAutoFixRecoveryTick({
      store: harness.store,
      submitter: { submit: harness.submit },
      logger,
      attemptLedger: harness.attemptLedger,
      defaultAutoFixRetries: 3,
    });

    await tick({ reason: 'poll' } as never);

    const submitCalls = harness.store.logEvent.mock.calls.filter((call) => call[1] === 'recovery.worker.submit');
    expect(submitCalls.length).toBeGreaterThan(0);
    const payload = submitCalls[0]?.[2] as { phase?: string; details?: { channel?: string } };
    expect(payload.phase).toBe('worker-autofix-bare-retry-submitted');
    expect(payload.details?.channel).toBe('invoker:restart-task');
  });
});
