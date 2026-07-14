import { describe, expect, it, vi } from 'vitest';

import type { WorkflowMutationIntent, WorkflowMutationPriority } from '@invoker/data-store';
import type { TaskState } from '@invoker/workflow-core';

import {
  createWorkflowResumeCooldownLedger,
  createWorkflowResumeTick,
  DEFAULT_WORKFLOW_RESUME_COOLDOWN_MS,
  WORKFLOW_RESUME_COMMAND_CHANNEL,
} from '../workers/workflow-resume-worker.js';

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  child: vi.fn(),
};

const POLL_CTX = {
  identity: { kind: 'workflow-resume', instanceId: 'w1' },
  reason: 'poll' as const,
  tickNumber: 1,
  signal: new AbortController().signal,
};
const WAKE_CTX = {
  identity: { kind: 'workflow-resume', instanceId: 'w1' },
  reason: 'wake' as const,
  tickNumber: 2,
  signal: new AbortController().signal,
};

function makeTask(overrides: Partial<TaskState> = {}): TaskState {
  return {
    id: 'wf-1/task',
    description: 'task',
    status: overrides.status ?? ('running' as TaskState['status']),
    dependencies: [],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    config: { workflowId: 'wf-1', ...(overrides.config ?? {}) },
    execution: { ...(overrides.execution ?? {}) },
    taskStateVersion: 1,
    ...overrides,
  } as TaskState;
}

interface HarnessOptions {
  workflows?: Array<{ id: string; tasks: TaskState[] }>;
  cooldownMs?: number;
  wakeupWorkflowIds?: string[];
}

function harness(options: HarnessOptions = {}) {
  const workflows = options.workflows ?? [];
  const workflowIds = workflows.map((w) => ({ id: w.id }));
  const tasksById = new Map(workflows.map((w) => [w.id, w.tasks]));

  const intents: WorkflowMutationIntent[] = [];
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
        createdAt: new Date().toISOString(),
      });
      return id;
    },
  );
  const logEvent = vi.fn();
  const store = {
    listWorkflows: () => workflowIds,
    loadTasks: (workflowId: string) => tasksById.get(workflowId) ?? [],
    logEvent,
  };

  let now = 0;
  const ledger = createWorkflowResumeCooldownLedger();
  const tick = createWorkflowResumeTick({
    store,
    submitter: { submit },
    logger,
    ledger,
    cooldownMs: options.cooldownMs ?? DEFAULT_WORKFLOW_RESUME_COOLDOWN_MS,
    now: () => now,
    drainWakeupHints: () => (options.wakeupWorkflowIds ?? []).map((workflowId) => ({
      workflowId,
      reason: 'workflow_status_changed' as const,
    })),
  });

  return {
    submit,
    logEvent,
    intents,
    tick,
    setNow: (t: number) => {
      now = t;
    },
  };
}

describe('workflow resume worker tick', () => {
  it('submits start-ready for a workflow that has ready pending work', async () => {
    const h = harness({
      workflows: [
        {
          id: 'wf-1',
          tasks: [makeTask({ status: 'pending' as TaskState['status'] })],
        },
      ],
    });
    await h.tick(POLL_CTX);
    expect(h.submit).toHaveBeenCalledTimes(1);
    const [workflowId, priority, channel, args] = h.submit.mock.calls[0];
    expect(workflowId).toBe('wf-1');
    expect(priority).toBe('normal');
    expect(channel).toBe(WORKFLOW_RESUME_COMMAND_CHANNEL);
    expect(args).toEqual([{}]);
  });

  it('skips pending work whose local dependencies are not completed', async () => {
    const h = harness({
      workflows: [
        {
          id: 'wf-1',
          tasks: [
            makeTask({ id: 'wf-1/a', status: 'running' as TaskState['status'] }),
            makeTask({
              id: 'wf-1/b',
              status: 'pending' as TaskState['status'],
              dependencies: ['wf-1/a'],
            }),
          ],
        },
      ],
    });
    await h.tick(POLL_CTX);
    expect(h.submit).not.toHaveBeenCalled();
  });

  it('submits pending work when local dependencies are completed', async () => {
    const h = harness({
      workflows: [
        {
          id: 'wf-1',
          tasks: [
            makeTask({ id: 'wf-1/a', status: 'completed' as TaskState['status'] }),
            makeTask({
              id: 'wf-1/b',
              status: 'pending' as TaskState['status'],
              dependencies: ['wf-1/a'],
            }),
          ],
        },
      ],
    });
    await h.tick(POLL_CTX);
    expect(h.submit).toHaveBeenCalledTimes(1);
  });

  it('skips workflows whose tasks are all terminal', async () => {
    const h = harness({
      workflows: [
        {
          id: 'wf-done',
          tasks: [
            makeTask({ id: 'wf-done/a', status: 'completed' as TaskState['status'] }),
            makeTask({ id: 'wf-done/b', status: 'review_ready' as TaskState['status'] }),
          ],
        },
        {
          id: 'wf-empty',
          tasks: [],
        },
      ],
    });
    await h.tick(POLL_CTX);
    expect(h.submit).not.toHaveBeenCalled();
  });

  it('skips a workflow whose only unfinished work is a failed task', async () => {
    const h = harness({
      workflows: [
        { id: 'wf-failed', tasks: [makeTask({ id: 'wf-failed/a', status: 'failed' as TaskState['status'] })] },
      ],
    });
    await h.tick(POLL_CTX);
    expect(h.submit).not.toHaveBeenCalled();
  });

  it('skips workflows whose tasks are closed or stale', async () => {
    const h = harness({
      workflows: [
        { id: 'wf-closed', tasks: [makeTask({ id: 'wf-closed/a', status: 'closed' as TaskState['status'] })] },
        { id: 'wf-stale', tasks: [makeTask({ id: 'wf-stale/a', status: 'stale' as TaskState['status'] })] },
      ],
    });
    await h.tick(POLL_CTX);
    expect(h.submit).not.toHaveBeenCalled();
  });

  it('does not resume a workflow whose tasks are only completed and failed', async () => {
    const h = harness({
      workflows: [
        {
          id: 'wf-mixed-terminal',
          tasks: [
            makeTask({ id: 'wf-mixed-terminal/a', status: 'completed' as TaskState['status'] }),
            makeTask({ id: 'wf-mixed-terminal/b', status: 'failed' as TaskState['status'] }),
          ],
        },
      ],
    });
    await h.tick(POLL_CTX);
    expect(h.submit).not.toHaveBeenCalled();
  });

  it('still submits start-ready for pending work alongside a failed task', async () => {
    const h = harness({
      workflows: [
        {
          id: 'wf-1',
          tasks: [
            makeTask({ id: 'wf-1/a', status: 'failed' as TaskState['status'] }),
            makeTask({ id: 'wf-1/b', status: 'pending' as TaskState['status'] }),
          ],
        },
      ],
    });
    await h.tick(POLL_CTX);
    expect(h.submit).toHaveBeenCalledTimes(1);
    expect(h.submit.mock.calls[0][0]).toBe('wf-1');
  });

  it('honors the cooldown window and re-submits after it expires', async () => {
    const h = harness({
      cooldownMs: 60_000,
      workflows: [
        {
          id: 'wf-1',
          tasks: [makeTask({ status: 'pending' as TaskState['status'] })],
        },
      ],
    });
    await h.tick(POLL_CTX);
    expect(h.submit).toHaveBeenCalledTimes(1);

    h.setNow(30_000);
    await h.tick(POLL_CTX);
    expect(h.submit).toHaveBeenCalledTimes(1);

    h.setNow(60_000);
    await h.tick(POLL_CTX);
    expect(h.submit).toHaveBeenCalledTimes(2);
  });

  it('on a wake event, only checks the hinted workflowIds and skips others', async () => {
    const h = harness({
      wakeupWorkflowIds: ['wf-target'],
      workflows: [
        {
          id: 'wf-target',
          tasks: [makeTask({ id: 'wf-target/a', status: 'pending' as TaskState['status'] })],
        },
        {
          id: 'wf-other',
          tasks: [makeTask({ id: 'wf-other/a', status: 'pending' as TaskState['status'] })],
        },
      ],
    });
    await h.tick(WAKE_CTX);
    expect(h.submit).toHaveBeenCalledTimes(1);
    const [workflowId] = h.submit.mock.calls[0];
    expect(workflowId).toBe('wf-target');
  });

  it('deduplicates within a single tick when the wake hint list has duplicates', async () => {
    const h = harness({
      wakeupWorkflowIds: ['wf-1', 'wf-1', 'wf-1'],
      workflows: [
        {
          id: 'wf-1',
          tasks: [makeTask({ status: 'pending' as TaskState['status'] })],
        },
      ],
    });
    await h.tick(WAKE_CTX);
    expect(h.submit).toHaveBeenCalledTimes(1);
  });

  it('logs a recovery.worker.submit event with the workflow id and intent id', async () => {
    const h = harness({
      workflows: [
        {
          id: 'wf-1',
          tasks: [makeTask({ status: 'pending' as TaskState['status'] })],
        },
      ],
    });
    await h.tick(POLL_CTX);
    expect(h.logEvent).toHaveBeenCalledWith(
      'wf-1',
      'recovery.worker.submit',
      expect.objectContaining({
        worker: 'workflow-resume',
        phase: 'start-ready',
        workflowId: 'wf-1',
        channel: WORKFLOW_RESUME_COMMAND_CHANNEL,
        intentId: expect.any(Number),
      }),
    );
  });

  it('does not submit for a workflow that only appears in wake hints and has all terminal tasks', async () => {
    const h = harness({
      wakeupWorkflowIds: ['wf-1'],
      workflows: [
        {
          id: 'wf-1',
          tasks: [makeTask({ status: 'completed' as TaskState['status'] })],
        },
      ],
    });
    await h.tick(WAKE_CTX);
    expect(h.submit).not.toHaveBeenCalled();
  });
});

describe('createWorkflowResumeCooldownLedger', () => {
  it('allows the first submit at any time', () => {
    const ledger = createWorkflowResumeCooldownLedger();
    expect(ledger.shouldSubmit('wf-1', 0)).toBe(true);
    expect(ledger.shouldSubmit('wf-1', 100_000)).toBe(true);
  });

  it('blocks a second submit until the eligible-at moment passes', () => {
    const ledger = createWorkflowResumeCooldownLedger();
    ledger.markSubmitted('wf-1', 60_000);
    expect(ledger.shouldSubmit('wf-1', 0)).toBe(false);
    expect(ledger.shouldSubmit('wf-1', 30_000)).toBe(false);
    expect(ledger.shouldSubmit('wf-1', 59_999)).toBe(false);
    expect(ledger.shouldSubmit('wf-1', 60_000)).toBe(true);
    expect(ledger.shouldSubmit('wf-1', 120_000)).toBe(true);
  });

  it('tracks workflows independently', () => {
    const ledger = createWorkflowResumeCooldownLedger();
    ledger.markSubmitted('wf-1', 60_000);
    expect(ledger.shouldSubmit('wf-1', 0)).toBe(false);
    expect(ledger.shouldSubmit('wf-2', 0)).toBe(true);
  });
});
