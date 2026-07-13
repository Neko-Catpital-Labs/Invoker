import { describe, expect, it, vi } from 'vitest';

import type { WorkflowMutationIntent, WorkflowMutationPriority } from '@invoker/data-store';
import type { TaskState } from '@invoker/workflow-core';

import { createRequeueAttemptLedger } from '../requeue-attempt-ledger.js';
import {
  createRequeueRecoveryTick,
  listRequeueScanCandidates,
  parseRequeueMutationArgs,
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

const POLL_CTX = { identity: { kind: 'requeue', instanceId: 'r1' }, reason: 'poll' as const, tickNumber: 1, signal: new AbortController().signal };

function makeTask(overrides: Partial<TaskState> = {}): TaskState {
  const { config, execution, ...rest } = overrides;
  return {
    id: 'wf-1/gate',
    description: 'stalled merge gate',
    status: 'failed',
    dependencies: [],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    config: { workflowId: 'wf-1', isMergeNode: true, ...(config ?? {}) },
    execution: {
      error: 'Execution stalled: ... (attempt lease expired).',
      failureClass: 'liveness_stall',
      generation: 2,
      selectedAttemptId: 'attempt-1',
      ...(execution ?? {}),
    },
    taskStateVersion: 3,
    ...rest,
  };
}

function harness(task: TaskState, opts: { budget?: number; backoffMs?: number } = {}) {
  const tasks = new Map<string, TaskState>([[task.id, task]]);
  const intents: WorkflowMutationIntent[] = [];
  const submit = vi.fn(
    (workflowId: string, priority: WorkflowMutationPriority, channel: string, args: unknown[]) => {
      const id = intents.length + 1;
      intents.push({ id, workflowId, priority, channel, args, status: 'queued', createdAt: new Date().toISOString() });
      return id;
    },
  );
  const logEvent = vi.fn();
  const store = {
    listWorkflows: () => [{ id: 'wf-1' }],
    loadTasks: (workflowId: string) => (workflowId === 'wf-1' ? Array.from(tasks.values()) : []),
    loadTask: (taskId: string) => tasks.get(taskId),
    listWorkflowMutationIntents: () => intents,
    logEvent,
  };
  const ledger = createRequeueAttemptLedger();
  let now = 0;
  const tick = createRequeueRecoveryTick({
    store,
    submitter: { submit },
    logger,
    ledger,
    stallRequeueRetries: opts.budget ?? 3,
    stallRequeueBackoffMs: opts.backoffMs ?? 120_000,
    now: () => now,
  });
  return { submit, logEvent, tasks, intents, tick, setNow: (t: number) => { now = t; } };
}

describe('requeue worker tick', () => {
  it('lists only failed liveness-classed tasks as candidates', () => {
    const liveness = makeTask();
    const codeFail = makeTask({ id: 'wf-1/other', execution: { failureClass: undefined, error: 'assertion failed', generation: 1 } });
    const running = makeTask({ id: 'wf-1/run', status: 'running' });
    const tasks = [liveness, codeFail, running];
    const candidates = listRequeueScanCandidates({
      listWorkflows: () => [{ id: 'wf-1' }],
      loadTasks: () => tasks,
      listWorkflowMutationIntents: () => [],
    });
    expect(candidates).toEqual([{ taskId: 'wf-1/gate', workflowId: 'wf-1' }]);
  });

  it('submits a retry-task requeue for a stalled task', async () => {
    const h = harness(makeTask());
    await h.tick(POLL_CTX);
    expect(h.submit).toHaveBeenCalledTimes(1);
    const [, , channel, args] = h.submit.mock.calls[0];
    expect(channel).toBe(REQUEUE_COMMAND_CHANNEL);
    expect(parseRequeueMutationArgs(args)).toEqual({ taskId: 'wf-1/gate' });
  });

  it('holds within the backoff window without submitting again', async () => {
    const h = harness(makeTask(), { backoffMs: 120_000 });
    await h.tick(POLL_CTX);
    h.setNow(30_000);
    await h.tick(POLL_CTX);
    expect(h.submit).toHaveBeenCalledTimes(1);
  });

  it('requeues up to the budget then escalates to needs_input exactly once', async () => {
    const h = harness(makeTask(), { budget: 3, backoffMs: 120_000 });
    // Three requeues, spaced past the backoff each time.
    await h.tick(POLL_CTX);
    h.setNow(120_000);
    await h.tick(POLL_CTX);
    h.setNow(240_000);
    await h.tick(POLL_CTX);
    const requeues = h.submit.mock.calls.filter((c) => c[2] === REQUEUE_COMMAND_CHANNEL);
    expect(requeues).toHaveLength(3);

    // Budget exhausted → escalate once.
    h.setNow(360_000);
    await h.tick(POLL_CTX);
    h.setNow(480_000);
    await h.tick(POLL_CTX);
    const escalations = h.submit.mock.calls.filter((c) => c[2] === REQUEUE_ESCALATE_CHANNEL);
    expect(escalations).toHaveLength(1);
    const parsed = parseRequeueEscalateMutationArgs(escalations[0][3]);
    expect(parsed.taskId).toBe('wf-1/gate');
    expect(parsed.prompt).toMatch(/stalled/i);
  });

  it('ignores a failed task that is not a liveness stall', async () => {
    const h = harness(makeTask({ execution: { failureClass: undefined, error: 'real bug', generation: 2 } }));
    await h.tick(POLL_CTX);
    expect(h.submit).not.toHaveBeenCalled();
  });

  it('ignores a task that is no longer failed', async () => {
    const h = harness(makeTask({ status: 'running' }));
    await h.tick(POLL_CTX);
    expect(h.submit).not.toHaveBeenCalled();
  });
});
