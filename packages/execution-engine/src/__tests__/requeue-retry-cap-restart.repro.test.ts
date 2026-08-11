import { describe, expect, it, vi } from 'vitest';

import type {
  WorkerActionRecord,
  WorkerActionWrite,
  WorkflowMutationIntent,
  WorkflowMutationPriority,
} from '@invoker/data-store';
import type { TaskState } from '@invoker/workflow-core';

import { createRequeueAttemptLedger } from '../requeue-attempt-ledger.js';
import { requeueRetryCapExternalKey } from '../requeue-retry-cap.js';
import {
  createRequeueRecoveryTick,
  parseRequeueEscalateMutationArgs,
  REQUEUE_COMMAND_CHANNEL,
  REQUEUE_ESCALATE_CHANNEL,
} from '../workers/requeue-worker.js';

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  child: vi.fn(),
};

const POLL_CTX = {
  identity: { kind: 'requeue', instanceId: 'r1' },
  reason: 'poll' as const,
  tickNumber: 1,
  signal: new AbortController().signal,
};

const NOW = '2026-01-01T00:00:00.000Z';

function toRecord(write: WorkerActionWrite, existing?: WorkerActionRecord): WorkerActionRecord {
  return {
    ...write,
    id: existing?.id ?? write.id,
    attemptCount: write.attemptCount ?? 0,
    createdAt: existing?.createdAt ?? NOW,
    updatedAt: write.updatedAt ?? NOW,
  };
}

function makeTask(): TaskState {
  return {
    id: 'wf-1/gate',
    description: 'stalled merge gate',
    status: 'failed',
    dependencies: [],
    createdAt: new Date(NOW),
    config: { workflowId: 'wf-1', isMergeNode: true },
    execution: {
      error: 'Execution stalled: ... (attempt lease expired).',
      failureClass: 'liveness_stall',
      generation: 2,
      selectedAttemptId: 'attempt-1',
    },
    taskStateVersion: 3,
  };
}

function makeHarness(task: TaskState) {
  const tasks = new Map<string, TaskState>([[task.id, task]]);
  const intents: WorkflowMutationIntent[] = [];
  const actions = new Map<string, WorkerActionRecord>();
  const submit = vi.fn(
    (workflowId: string, priority: WorkflowMutationPriority, channel: string, args: unknown[]) => {
      const id = intents.length + 1;
      intents.push({
        id,
        workflowId,
        priority,
        channel,
        args,
        status: 'queued',
        createdAt: NOW,
      });
      return id;
    },
  );
  const store = {
    listWorkflows: () => [{ id: 'wf-1' }],
    loadTasks: (workflowId: string) => (workflowId === 'wf-1' ? Array.from(tasks.values()) : []),
    loadTask: (taskId: string) => tasks.get(taskId),
    listWorkflowMutationIntents: () => intents,
    getWorkerAction: vi.fn((workerKind: string, externalKey: string) => actions.get(`${workerKind}:${externalKey}`)),
    upsertWorkerAction: vi.fn((write: WorkerActionWrite) => {
      const key = `${write.workerKind}:${write.externalKey}`;
      const saved = toRecord(write, actions.get(key));
      actions.set(key, saved);
      return saved;
    }),
    logEvent: vi.fn(),
  };
  const makeTick = () => createRequeueRecoveryTick({
    store,
    submitter: { submit },
    logger,
    ledger: createRequeueAttemptLedger(),
    stallRequeueRetries: 1,
    stallRequeueBackoffMs: 0,
    now: () => 0,
  });
  return { actions, makeTick, store, submit };
}

describe('requeue retry cap restart regression', () => {
  it('keeps the exhausted stall-requeue budget durable across a worker restart', async () => {
    const h = makeHarness(makeTask());
    const firstProcessTick = h.makeTick();

    await firstProcessTick(POLL_CTX);
    expect(h.submit.mock.calls.map((call) => call[2])).toEqual([REQUEUE_COMMAND_CHANNEL]);
    expect(h.store.getWorkerAction('requeue', requeueRetryCapExternalKey('wf-1/gate'))?.attemptCount).toBe(1);

    await firstProcessTick(POLL_CTX);
    expect(h.submit.mock.calls.map((call) => call[2])).toEqual([
      REQUEUE_COMMAND_CHANNEL,
      REQUEUE_ESCALATE_CHANNEL,
    ]);
    const escalation = parseRequeueEscalateMutationArgs(h.submit.mock.calls[1][3]);
    expect(escalation.taskId).toBe('wf-1/gate');
    expect(escalation.prompt).toContain('requeued 1 time(s)');

    const callsBeforeRestart = h.submit.mock.calls.length;
    const restartedProcessTick = h.makeTick();

    await restartedProcessTick(POLL_CTX);

    const channelsAfterRestart = h.submit.mock.calls.slice(callsBeforeRestart).map((call) => call[2]);
    expect(channelsAfterRestart).not.toContain(REQUEUE_COMMAND_CHANNEL);
    expect(h.submit.mock.calls.filter((call) => call[2] === REQUEUE_COMMAND_CHANNEL)).toHaveLength(1);
  });
});
