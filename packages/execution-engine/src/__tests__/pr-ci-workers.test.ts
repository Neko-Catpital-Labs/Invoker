import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TaskState } from '@invoker/workflow-core';

import { maybePublishReviewGateCiFailure } from '../task-runner-review-gate.js';
import {
  DEFAULT_PR_STATUS_WORKER_INTERVAL_MS,
  createPrStatusWorker,
} from '../workers/pr-status-worker.js';

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
    id: 'wf-1/merge',
    description: 'merge',
    status: 'review_ready',
    dependencies: [],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    config: { workflowId: 'wf-1', isMergeNode: true, ...(config ?? {}) },
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
      ...(execution ?? {}),
    },
    taskStateVersion: 10,
    ...rest,
  } as TaskState;
}

describe('PR status worker', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('polls review-gate status on the 60000ms default interval', async () => {
    vi.useFakeTimers();
    const checkMergeGateStatuses = vi.fn().mockResolvedValue(undefined);
    const worker = createPrStatusWorker({
      logger,
      reviewGate: { checkMergeGateStatuses },
      installSignalHandlers: false,
    });

    worker.start();
    expect(checkMergeGateStatuses).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(DEFAULT_PR_STATUS_WORKER_INTERVAL_MS);

    expect(checkMergeGateStatuses).toHaveBeenCalledTimes(1);
    await worker.stop();
  });

  it('does not publish a CI repair intent for pending checks or merge-conflict-only polls', async () => {
    const publish = vi.fn();
    const host = {
      reviewGateCiFailurePublisher: { publish },
      reviewGateCiFailureInFlight: new Set<string>(),
    } as any;
    const task = makeTask();

    await maybePublishReviewGateCiFailure(host, task, {
      lifecycle: 'open',
      rejected: false,
      statusText: 'Checks pending',
      url: 'https://github.com/owner/repo/pull/123',
      checks: { state: 'pending', failed: [] },
    }, '123');
    await maybePublishReviewGateCiFailure(host, task, {
      lifecycle: 'open',
      rejected: false,
      statusText: 'Merge conflict',
      url: 'https://github.com/owner/repo/pull/123',
      mergeState: 'dirty',
    }, '123');

    expect(publish).not.toHaveBeenCalled();
  });
});
