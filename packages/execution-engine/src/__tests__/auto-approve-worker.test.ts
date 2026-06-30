import { describe, expect, it, vi } from 'vitest';

import type { WorkerActionRecord, WorkerActionWrite, WorkflowMutationIntent, WorkflowMutationPriority } from '@invoker/data-store';
import type { TaskState } from '@invoker/workflow-core';

import {
  AUTO_APPROVE_WORKER_KIND,
  autoApproveActionKey,
  createAutoApproveTick,
  createAutoApproveWorker,
} from '../workers/auto-approve-worker.js';

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  child: vi.fn(),
};

function makeTask(overrides: Partial<TaskState> = {}): TaskState {
  const { config, execution, ...rest } = overrides;
  return {
    id: 'wf-1/task-1',
    description: 'fixed task',
    status: 'awaiting_approval',
    dependencies: [],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    config: { workflowId: 'wf-1', ...(config ?? {}) },
    execution: {
      pendingFixError: 'original failure',
      generation: 1,
      selectedAttemptId: 'attempt-1',
      ...(execution ?? {}),
    },
    taskStateVersion: 4,
    ...rest,
  };
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

function makeHarness(task: TaskState = makeTask(), enabled = true) {
  const workflows = [{ id: 'wf-1' }];
  const tasks = new Map<string, TaskState>([[task.id, task]]);
  const intents: WorkflowMutationIntent[] = [];
  const actions = new Map<string, WorkerActionRecord>();
  const submit = vi.fn((workflowId: string, priority: WorkflowMutationPriority, channel: string, args: unknown[]) => {
    const id = intents.length + 1;
    intents.push({
      id,
      workflowId,
      priority,
      channel,
      args,
      status: 'queued',
      createdAt: new Date().toISOString(),
    });
    return id;
  });
  const store = {
    listWorkflows: vi.fn(() => workflows),
    loadTasks: vi.fn((workflowId: string) => workflowId === 'wf-1' ? Array.from(tasks.values()) : []),
    loadTask: vi.fn((taskId: string) => tasks.get(taskId)),
    listWorkflowMutationIntents: vi.fn((workflowId?: string, statuses?: string[]) => intents.filter((intent) => (
      (!workflowId || intent.workflowId === workflowId)
      && (!statuses || statuses.includes(intent.status))
    ))),
    getWorkerAction: vi.fn((workerKind: string, externalKey: string) => actions.get(`${workerKind}:${externalKey}`)),
    upsertWorkerAction: vi.fn((write: WorkerActionWrite) => {
      const existing = actions.get(`${write.workerKind}:${write.externalKey}`);
      const saved = toRecord({ ...write, id: existing?.id ?? write.id, createdAt: existing?.createdAt });
      actions.set(`${write.workerKind}:${write.externalKey}`, saved);
      return saved;
    }),
    listWorkerActions: vi.fn((filters?: { workerKind?: string }) => Array.from(actions.values()).filter((action) => (
      !filters?.workerKind || action.workerKind === filters.workerKind
    ))),
    logEvent: vi.fn(),
  };
  return {
    options: {
      store,
      submitter: { submit },
      logger,
      getAutoApproveAIFixes: () => enabled,
    },
    actions,
    intents,
    store,
    submit,
    tasks,
  };
}

describe('auto-approve worker', () => {
  it('exposes the auto-approve identity', () => {
    const runtime = createAutoApproveWorker({ logger, instanceId: 'aa-1', installSignalHandlers: false });

    expect(runtime.identity).toEqual({ kind: AUTO_APPROVE_WORKER_KIND, instanceId: 'aa-1' });
  });

  it('queues headless approve once for an awaiting AI fix and records a queued action', async () => {
    const task = makeTask();
    const harness = makeHarness(task, true);
    const tick = createAutoApproveTick(harness.options);

    await tick({ identity: { kind: AUTO_APPROVE_WORKER_KIND, instanceId: 'test' }, reason: 'manual', tickNumber: 1 });
    await tick({ identity: { kind: AUTO_APPROVE_WORKER_KIND, instanceId: 'test' }, reason: 'manual', tickNumber: 2 });

    expect(harness.submit).toHaveBeenCalledTimes(1);
    expect(harness.submit).toHaveBeenCalledWith(
      'wf-1',
      'normal',
      'headless.exec',
      [{ args: ['approve', 'wf-1/task-1'], noTrack: true }],
    );
    const action = harness.actions.get(`${AUTO_APPROVE_WORKER_KIND}:${autoApproveActionKey({
      taskId: task.id,
      generation: 1,
      taskStateVersion: 4,
      attemptId: 'attempt-1',
    })}`);
    expect(action).toMatchObject({
      workerKind: AUTO_APPROVE_WORKER_KIND,
      actionType: 'approve-ai-fix',
      status: 'queued',
      intentId: '1',
      taskId: 'wf-1/task-1',
    });
  });

  it('records skipped when auto approval is disabled', async () => {
    const harness = makeHarness(makeTask(), false);
    const tick = createAutoApproveTick(harness.options);

    await tick({ identity: { kind: AUTO_APPROVE_WORKER_KIND, instanceId: 'test' }, reason: 'manual', tickNumber: 1 });

    expect(harness.submit).not.toHaveBeenCalled();
    expect(Array.from(harness.actions.values())[0]).toMatchObject({
      status: 'skipped',
      summary: expect.stringContaining('disabled'),
    });
  });

  it('marks queued auto-approval actions stale after the task leaves the approval state', async () => {
    const task = makeTask({ status: 'completed' });
    const harness = makeHarness(task, true);
    const externalKey = autoApproveActionKey({
      taskId: task.id,
      generation: 1,
      taskStateVersion: 4,
      attemptId: 'attempt-1',
    });
    harness.actions.set(`${AUTO_APPROVE_WORKER_KIND}:${externalKey}`, toRecord({
      id: 'aa-1',
      workerKind: AUTO_APPROVE_WORKER_KIND,
      actionType: 'approve-ai-fix',
      workflowId: 'wf-1',
      taskId: task.id,
      subjectType: 'task',
      subjectId: task.id,
      externalKey,
      status: 'queued',
      attemptCount: 1,
    }));
    const tick = createAutoApproveTick(harness.options);

    await tick({ identity: { kind: AUTO_APPROVE_WORKER_KIND, instanceId: 'test' }, reason: 'manual', tickNumber: 1 });

    expect(harness.submit).not.toHaveBeenCalled();
    expect(harness.actions.get(`${AUTO_APPROVE_WORKER_KIND}:${externalKey}`)).toMatchObject({
      status: 'stale',
      summary: expect.stringContaining('status-changed'),
    });
  });
});
