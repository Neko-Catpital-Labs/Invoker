import { describe, expect, it, vi } from 'vitest';
import type { WorkflowMutationIntent } from '@invoker/data-store';
import { Channels, LocalBus } from '@invoker/transport';
import type { TaskState } from '@invoker/workflow-core';

import { buildFixWithAgentMutationArgs, parseFixWithAgentMutationArgs } from '../auto-fix-intents.js';
import type { ReviewGateCiFailedLifecycleEvent } from '../lifecycle-events.js';
import {
  buildCiFailureDedupeKey,
  createCiFailureWorker,
} from '../workers/ci-failure-worker.js';

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
};

function makeTask(overrides: Partial<TaskState> = {}): TaskState {
  return {
    id: 'wf-1/merge',
    description: 'merge gate',
    status: 'review_ready',
    dependencies: [],
    createdAt: new Date('2026-06-03T00:00:00.000Z'),
    config: { workflowId: 'wf-1', isMergeNode: true },
    execution: {
      generation: 2,
      selectedAttemptId: 'attempt-1',
      branch: 'feature/ci-red',
      reviewGate: {
        activeGeneration: 2,
        completion: { required: 'all', status: 'approved' },
        artifacts: [
          {
            id: 'runtime',
            providerId: '123',
            required: true,
            status: 'open',
            generation: 2,
            headSha: 'head-1',
          },
        ],
      },
    },
    taskStateVersion: 8,
    ...overrides,
  } as TaskState;
}

function makeEvent(overrides: Partial<ReviewGateCiFailedLifecycleEvent> = {}): ReviewGateCiFailedLifecycleEvent {
  return {
    eventKey: 'event-1',
    kind: 'review_gate.ci_failed',
    workflowId: 'wf-1',
    taskId: 'wf-1/merge',
    status: 'review_ready',
    taskStateVersion: 8,
    generation: 2,
    attemptId: 'attempt-1',
    createdAt: '2026-06-04T00:00:00.000Z',
    recoveryWakeup: {
      eventKey: 'event-1',
      eventKind: 'review_gate.ci_failed',
      workflowId: 'wf-1',
      taskId: 'wf-1/merge',
      taskStateVersion: 8,
      generation: 2,
      attemptId: 'attempt-1',
      createdAt: '2026-06-04T00:00:00.000Z',
      reason: 'review_gate_failure',
      authoritative: false,
    },
    reviewId: '123',
    reviewUrl: 'https://github.com/owner/repo/pull/123',
    headSha: 'head-1',
    headRef: 'feature/ci-red',
    branch: 'feature/ci-red',
    failedChecks: [
      { name: 'test-all', conclusion: 'FAILURE', detailsUrl: 'https://github.com/owner/repo/actions/runs/1' },
    ],
    statusText: 'CI failed',
    ...overrides,
  };
}

function makeIntent(overrides: Partial<WorkflowMutationIntent>): WorkflowMutationIntent {
  return {
    id: 1,
    workflowId: 'wf-1',
    channel: 'invoker:fix-with-agent',
    args: [],
    priority: 'normal',
    status: 'completed',
    createdAt: '2026-06-04T00:00:00.000Z',
    ...overrides,
  } as WorkflowMutationIntent;
}

describe('ci-failure worker', () => {
  it('submits a review-gate CI fix intent with the stable dedupe key', async () => {
    const bus = new LocalBus();
    const task = makeTask();
    const submit = vi.fn(() => 7);
    const event = makeEvent();
    const worker = createCiFailureWorker({
      logger,
      messageBus: bus,
      store: {
        loadTasks: () => [task],
        listWorkflowMutationIntents: () => [],
      },
      submitter: { submit },
      getAutoFixAgent: () => 'codex',
      installSignalHandlers: false,
    });
    worker.start();

    bus.publish(Channels.WORKFLOW_LIFECYCLE, event);
    await worker.tick();

    const expectedDedupeKey = buildCiFailureDedupeKey({
      taskId: event.taskId,
      reviewId: event.reviewId,
      headSha: event.headSha,
      failedChecks: event.failedChecks,
    });
    expect(submit).toHaveBeenCalledWith(
      'wf-1',
      'normal',
      'invoker:fix-with-agent',
      expect.any(Array),
    );
    const args = submit.mock.calls[0][3] as unknown[];
    const parsed = parseFixWithAgentMutationArgs(args);
    expect(parsed).toMatchObject({ taskId: 'wf-1/merge', agentName: 'codex' });
    expect(parsed.context.reviewGateContext).toMatchObject({
      reviewId: '123',
      generation: 2,
      selectedAttemptId: 'attempt-1',
      headSha: 'head-1',
      dedupeKey: expectedDedupeKey,
    });
    await worker.stop();
  });

  it('accepts failures for a later review-gate artifact in a PR stack', async () => {
    const bus = new LocalBus();
    const task = makeTask({
      execution: {
        ...makeTask().execution,
        reviewId: '111',
        reviewGate: {
          activeGeneration: 2,
          completion: { required: 'all', status: 'approved' },
          artifacts: [
            { id: 'contracts', providerId: '111', required: true, status: 'approved', generation: 2, headSha: 'head-a' },
            { id: 'runtime', providerId: '123', required: true, status: 'open', generation: 2, headSha: 'head-1' },
          ],
        },
      },
    });
    const submit = vi.fn(() => 7);
    const worker = createCiFailureWorker({
      logger,
      messageBus: bus,
      store: {
        loadTasks: () => [task],
        listWorkflowMutationIntents: () => [],
      },
      submitter: { submit },
      installSignalHandlers: false,
    });
    worker.start();

    bus.publish(Channels.WORKFLOW_LIFECYCLE, makeEvent({ reviewId: '123' }));
    await worker.tick();

    expect(submit).toHaveBeenCalledTimes(1);
    await worker.stop();
  });

  it('rejects stale head SHA before submitting a fix', async () => {
    const bus = new LocalBus();
    const task = makeTask({
      execution: {
        ...makeTask().execution,
        reviewGate: {
          activeGeneration: 2,
          completion: { required: 'all', status: 'approved' },
          artifacts: [
            { id: 'runtime', providerId: '123', required: true, status: 'open', generation: 2, headSha: 'head-2' },
          ],
        },
      },
    });
    const submit = vi.fn(() => 7);
    const worker = createCiFailureWorker({
      logger,
      messageBus: bus,
      store: {
        loadTasks: () => [task],
        listWorkflowMutationIntents: () => [],
      },
      submitter: { submit },
      installSignalHandlers: false,
    });
    worker.start();

    bus.publish(Channels.WORKFLOW_LIFECYCLE, makeEvent());
    await worker.tick();

    expect(submit).not.toHaveBeenCalled();
    await worker.stop();
  });

  it('dedupes completed fixes for the same review head and failed-check fingerprint', async () => {
    const event = makeEvent();
    const dedupeKey = buildCiFailureDedupeKey({
      taskId: event.taskId,
      reviewId: event.reviewId,
      headSha: event.headSha,
      failedChecks: event.failedChecks,
    });
    const existing = makeIntent({
      args: buildFixWithAgentMutationArgs('wf-1/merge', 'codex', {
        autoFix: true,
        reviewGateContext: {
          reviewId: '123',
          generation: 2,
          selectedAttemptId: 'attempt-1',
          headSha: 'head-1',
          dedupeKey,
        },
      }),
    });
    const bus = new LocalBus();
    const submit = vi.fn(() => 7);
    const worker = createCiFailureWorker({
      logger,
      messageBus: bus,
      store: {
        loadTasks: () => [makeTask()],
        listWorkflowMutationIntents: () => [existing],
      },
      submitter: { submit },
      installSignalHandlers: false,
    });
    worker.start();

    bus.publish(Channels.WORKFLOW_LIFECYCLE, event);
    await worker.tick();

    expect(submit).not.toHaveBeenCalled();
    await worker.stop();
  });
});
