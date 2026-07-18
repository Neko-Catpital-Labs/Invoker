import { afterEach, describe, expect, it, vi } from 'vitest';

import type { WorkerActionRecord, WorkerActionWrite, WorkflowMutationPriority } from '@invoker/data-store';
import type { TaskState } from '@invoker/workflow-core';

import { createAutoFixAttemptLedger } from '../auto-fix-attempt-ledger.js';
import type { ReviewGateCiFailedLifecycleEvent } from '../lifecycle-events.js';
import {
  CI_FAILURE_WORKER_KIND,
  createCiFailureTick,
} from '../workers/ci-failure-worker.js';

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  child: vi.fn(),
};

function makeTask(taskId: string): TaskState {
  return {
    id: taskId,
    description: 'merge',
    status: 'review_ready',
    dependencies: [],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    config: { workflowId: 'wf-1', isMergeNode: true },
    execution: {
      generation: 2,
      selectedAttemptId: 'attempt-1',
      branch: 'feature/ci',
      reviewGate: {
        activeGeneration: 2,
        completion: { required: 'all', status: 'approved' },
        artifacts: [{
          id: 'pr-123',
          providerId: '123',
          provider: 'github',
          required: true,
          status: 'open',
          generation: 2,
          headSha: 'sha-1',
        }],
      },
    },
    taskStateVersion: 10,
  } as TaskState;
}

function makeEvent(taskId: string): ReviewGateCiFailedLifecycleEvent {
  return {
    eventKey: `review_gate.ci_failed|workflow:wf-1|task:${taskId}`,
    kind: 'review_gate.ci_failed',
    workflowId: 'wf-1',
    taskId,
    status: 'review_ready',
    taskStateVersion: 10,
    generation: 2,
    attemptId: 'attempt-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    recoveryWakeup: {
      eventKey: `review_gate.ci_failed|workflow:wf-1|task:${taskId}`,
      eventKind: 'review_gate.ci_failed',
      workflowId: 'wf-1',
      taskId,
      taskStateVersion: 10,
      generation: 2,
      attemptId: 'attempt-1',
      createdAt: '2026-01-01T00:00:00.000Z',
      reason: 'review_gate_failure',
      authoritative: false,
    },
    reviewId: '123',
    reviewUrl: 'https://github.com/owner/repo/pull/123',
    headSha: 'sha-1',
    headRef: 'feature/ci',
    branch: 'feature/ci',
    failedChecks: [
      { name: 'unit', conclusion: 'FAILURE', detailsUrl: 'https://github.com/owner/repo/actions/1' },
    ],
    statusText: 'CI failed',
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

describe('createCiFailureTick resilience', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('processes remaining drained events when one event throws', async () => {
    const events = [makeEvent('task-1'), makeEvent('task-2'), makeEvent('task-3')];
    const tasks = new Map<string, TaskState>(events.map((event) => [event.taskId, makeTask(event.taskId)]));
    const actions = new Map<string, WorkerActionRecord>();
    const submit = vi.fn<[string, WorkflowMutationPriority, string, unknown[]], number>(() => 42);
    const store = {
      loadTasks: vi.fn((workflowId: string) => workflowId === 'wf-1' ? Array.from(tasks.values()) : []),
      loadTask: vi.fn((taskId: string) => {
        if (taskId === 'task-2') {
          throw new Error('boom loading task-2');
        }
        return tasks.get(taskId);
      }),
      listWorkflowMutationIntents: vi.fn(() => []),
      getWorkerAction: vi.fn((workerKind: string, externalKey: string) => actions.get(`${workerKind}:${externalKey}`)),
      upsertWorkerAction: vi.fn((write: WorkerActionWrite) => {
        const existing = actions.get(`${write.workerKind}:${write.externalKey}`);
        const saved = toRecord({ ...write, id: existing?.id ?? write.id, createdAt: existing?.createdAt });
        actions.set(`${write.workerKind}:${write.externalKey}`, saved);
        return saved;
      }),
      logEvent: vi.fn(),
    };

    const tick = createCiFailureTick({
      store,
      submitter: { submit },
      logger,
      attemptLedger: createAutoFixAttemptLedger(),
      defaultAutoFixRetries: 2,
      drainEvents: () => events,
    });

    await tick({
      identity: { kind: CI_FAILURE_WORKER_KIND, instanceId: 'test' },
      reason: 'wake',
      tickNumber: 1,
      signal: new AbortController().signal,
    });

    const submittedTaskIds = submit.mock.calls.map((call) => (call[3] as [string, ...unknown[]])[0]);
    expect(submittedTaskIds).toContain('task-1');
    expect(submittedTaskIds).toContain('task-3');
    expect(submit).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalled();
  });
});
