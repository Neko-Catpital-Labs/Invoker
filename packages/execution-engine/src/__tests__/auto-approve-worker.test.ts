import type { Logger } from '@invoker/contracts';
import type { WorkerActionRecord, WorkerActionWrite, WorkflowMutationIntent } from '@invoker/data-store';
import type { RecoveryWorkerWakeupHint } from '../lifecycle-events.js';
import type { TaskState } from '@invoker/workflow-core';
import { describe, expect, it, vi } from 'vitest';

import {
  collectValidatedAutoApproveCandidates,
  createAutoApproveTick,
  isApproveIntentForTask,
  listAutoApproveScanCandidates,
  type AutoApproveCandidate,
  type AutoApproveWorkerStore,
} from '../workers/auto-approve-worker.js';

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  child: vi.fn(),
} as unknown as Logger;

function task(overrides: Partial<TaskState> = {}): TaskState {
  const { config, execution, ...rest } = overrides;
  return {
    id: 'wf-1/task-1',
    description: 'Task 1',
    status: 'awaiting_approval',
    dependencies: [],
    createdAt: new Date('2026-01-01T00:00:00Z'),
    config: { id: 'task-1', workflowId: 'wf-1', ...config },
    execution: {
      pendingFixError: 'boom',
      generation: 1,
      selectedAttemptId: 'attempt-1',
      ...execution,
    },
    taskStateVersion: 4,
    ...rest,
  } as TaskState;
}

function intent(overrides: Partial<WorkflowMutationIntent>): WorkflowMutationIntent {
  return {
    id: 1,
    workflowId: 'wf-1',
    channel: 'invoker:approve',
    args: ['wf-1/task-1'],
    priority: 'normal',
    status: 'queued',
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function wakeup(overrides: Partial<RecoveryWorkerWakeupHint> = {}): RecoveryWorkerWakeupHint {
  return {
    eventKey: 'event-1',
    eventKind: 'task.awaiting_approval',
    workflowId: 'wf-1',
    taskId: 'wf-1/task-1',
    taskStateVersion: 4,
    generation: 1,
    attemptId: 'attempt-1',
    createdAt: '2026-01-01T00:00:00Z',
    reason: 'task_lifecycle',
    authoritative: false,
    ...overrides,
  };
}

function makeStore(
  tasks: TaskState[],
  openIntents: WorkflowMutationIntent[] = [],
  workflows: Array<{ id: string; mergeMode?: string | null; onFinish?: string | null }> = [{ id: 'wf-1' }],
) {
  const workflowMap = new Map(workflows.map((workflow) => [workflow.id, workflow]));
  const actions = new Map<string, WorkerActionRecord>();
  const writes: WorkerActionWrite[] = [];
  const store: AutoApproveWorkerStore = {
    listWorkflows: vi.fn(() => workflows.map(({ id }) => ({ id }))),
    loadWorkflow: vi.fn((workflowId: string) => workflowMap.get(workflowId)),
    loadTasks: vi.fn(() => tasks),
    loadTask: vi.fn((taskId: string) => tasks.find((candidate) => candidate.id === taskId)),
    listWorkflowMutationIntents: vi.fn(() => openIntents),
    getWorkerAction: vi.fn((workerKind: string, externalKey: string) => actions.get(`${workerKind}:${externalKey}`)),
    upsertWorkerAction: vi.fn((write: WorkerActionWrite) => {
      writes.push(write);
      const now = new Date('2026-01-01T00:00:00Z').toISOString();
      const record: WorkerActionRecord = {
        attemptCount: 0,
        createdAt: now,
        updatedAt: now,
        ...write,
      };
      actions.set(`${write.workerKind}:${write.externalKey}`, record);
      return record;
    }),
    logEvent: vi.fn(),
  };
  return { store, writes };
}

function candidate(overrides: Partial<AutoApproveCandidate> = {}): AutoApproveCandidate {
  return {
    taskId: 'wf-1/task-1',
    workflowId: 'wf-1',
    generation: 1,
    taskStateVersion: 4,
    attemptId: 'attempt-1',
    source: 'scan',
    ...overrides,
  };
}

describe('autoapprove worker', () => {
  it('scan candidates include only awaiting approval tasks with pending fix errors', () => {
    const eligible = task();
    const noPendingFix = task({ id: 'wf-1/task-2', execution: { pendingFixError: undefined } });
    const failed = task({ id: 'wf-1/task-3', status: 'failed' });
    const { store } = makeStore([eligible, noPendingFix, failed]);

    expect(listAutoApproveScanCandidates({ store })).toEqual([
      expect.objectContaining({ taskId: 'wf-1/task-1', workflowId: 'wf-1', generation: 1, taskStateVersion: 4 }),
    ]);
  });

  it('does not submit awaiting approval tasks without pending fix errors', async () => {
    const { store } = makeStore([task({ execution: { pendingFixError: undefined } })]);
    const submitter = { submit: vi.fn() };

    await createAutoApproveTick({ store, submitter, logger, enabled: true })({
      identity: { kind: 'autoapprove', instanceId: 'test' },
      reason: 'manual',
      tickNumber: 1,
      signal: new AbortController().signal,
    });

    expect(submitter.submit).not.toHaveBeenCalled();
  });

  it('skips review-ready tasks with pending fix errors as ambiguous', () => {
    const { store, writes } = makeStore([task({ status: 'review_ready' })]);

    expect(collectValidatedAutoApproveCandidates({ store, submitter: { submit: vi.fn() }, logger, enabled: true }, [candidate()])).toEqual([]);
    expect(writes[0]).toMatchObject({ status: 'skipped', summary: 'Skipped AI fix approval: review-ready-ambiguous' });
  });
  it('scans review-ready automatic merge gates', () => {
    const reviewReadyGate = task({
      status: 'review_ready',
      config: { workflowId: 'wf-1', isMergeNode: true },
      execution: { pendingFixError: undefined },
    });
    const { store } = makeStore([reviewReadyGate], [], [{ id: 'wf-1', mergeMode: 'automatic', onFinish: 'merge' }]);

    expect(listAutoApproveScanCandidates({ store })).toEqual([
      expect.objectContaining({ taskId: 'wf-1/task-1', workflowId: 'wf-1', generation: 1, taskStateVersion: 4 }),
    ]);
  });

  it('submits review-ready automatic merge gates for approval', async () => {
    const reviewReadyGate = task({
      status: 'review_ready',
      config: { workflowId: 'wf-1', isMergeNode: true },
      execution: { pendingFixError: undefined },
    });
    const { store, writes } = makeStore([reviewReadyGate], [], [{ id: 'wf-1', mergeMode: 'automatic', onFinish: 'merge' }]);
    const submitter = { submit: vi.fn(() => 42) };

    await createAutoApproveTick({ store, submitter, logger, enabled: true })({
      identity: { kind: 'autoapprove', instanceId: 'test' },
      reason: 'manual',
      tickNumber: 1,
      signal: new AbortController().signal,
    });

    expect(submitter.submit).toHaveBeenCalledWith('wf-1', 'normal', 'invoker:approve', ['wf-1/task-1']);
    expect(writes[0]).toMatchObject({ status: 'queued', summary: 'Queued AI fix approval' });
  });

  it('skips stale workflow, generation, task-state version, and attempt snapshots', () => {
    const cases: Array<[string, TaskState, AutoApproveCandidate]> = [
      ['stale-workflow', task({ config: { workflowId: 'wf-2' } }), candidate()],
      ['stale-generation', task({ execution: { generation: 2 } }), candidate()],
      ['stale-task-state-version', task({ taskStateVersion: 5 }), candidate()],
      ['stale-attempt', task({ execution: { selectedAttemptId: 'attempt-2' } }), candidate()],
    ];

    for (const [reason, latest, snapshot] of cases) {
      const { store, writes } = makeStore([latest]);
      const result = collectValidatedAutoApproveCandidates({ store, submitter: { submit: vi.fn() }, logger, enabled: true }, [snapshot]);
      expect(result).toEqual([]);
      expect(writes[0]).toMatchObject({ status: 'skipped', summary: `Skipped AI fix approval: ${reason}` });
    }
  });

  it('dedupes duplicate wakeups for the same snapshot', async () => {
    const { store } = makeStore([task()]);
    const submitter = { submit: vi.fn(() => 42) };

    await createAutoApproveTick({
      store,
      submitter,
      logger,
      enabled: true,
      drainWakeupHints: () => [wakeup(), wakeup()],
    })({ identity: { kind: 'autoapprove', instanceId: 'test' }, reason: 'wake', tickNumber: 1,
      signal: new AbortController().signal });

    expect(submitter.submit).toHaveBeenCalledTimes(1);
  });

  it('skips open invoker and headless approval intents', () => {
    const openInvoker = intent({ id: 10, channel: 'invoker:approve', args: ['wf-1/task-1'] });
    const openHeadless = intent({ id: 11, channel: 'headless.exec', args: [{ args: ['approve', 'wf-1/task-1'] }] });
    expect(isApproveIntentForTask(openInvoker, 'wf-1/task-1')).toBe(true);
    expect(isApproveIntentForTask(openHeadless, 'wf-1/task-1')).toBe(true);

    for (const openIntent of [openInvoker, openHeadless]) {
      const { store, writes } = makeStore([task()], [openIntent]);
      const result = collectValidatedAutoApproveCandidates({ store, submitter: { submit: vi.fn() }, logger, enabled: true }, [candidate()]);
      expect(result).toEqual([]);
      expect(writes[0]).toMatchObject({ status: 'skipped', summary: 'Skipped AI fix approval: already-queued-intent' });
    }
  });

  it('submits a valid approval intent and records a queued worker action', async () => {
    const { store, writes } = makeStore([task()]);
    const submitter = { submit: vi.fn(() => 42) };

    await createAutoApproveTick({ store, submitter, logger, enabled: true })({
      identity: { kind: 'autoapprove', instanceId: 'test' },
      reason: 'manual',
      tickNumber: 1,
      signal: new AbortController().signal,
    });

    expect(submitter.submit).toHaveBeenCalledWith('wf-1', 'normal', 'invoker:approve', ['wf-1/task-1']);
    expect(writes[0]).toMatchObject({
      id: 'autoapprove:autoapprove:wf-1/task-1:1:4:attempt-1',
      workerKind: 'autoapprove',
      actionType: 'approve-ai-fix',
      subjectType: 'task',
      subjectId: 'wf-1/task-1',
      status: 'queued',
      summary: 'Queued AI fix approval',
      intentId: '42',
    });
  });

  it('does not scan or submit when disabled', async () => {
    const { store } = makeStore([task()]);
    const submitter = { submit: vi.fn() };

    await createAutoApproveTick({ store, submitter, logger, enabled: false })({
      identity: { kind: 'autoapprove', instanceId: 'test' },
      reason: 'manual',
      tickNumber: 1,
      signal: new AbortController().signal,
    });

    expect(store.listWorkflows).not.toHaveBeenCalled();
    expect(submitter.submit).not.toHaveBeenCalled();
  });
});
