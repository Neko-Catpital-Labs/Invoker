import { afterEach, describe, expect, it, vi } from 'vitest';
import { Channels } from '@invoker/transport';
import type { TaskState } from '@invoker/workflow-core';
import { startReviewGateStatusWorker } from '../review-gate-status-worker.js';
import { startSurfaceEventRelay } from '../surface-event-relay.js';


const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
};

function createRelayBus() {
  const handlers = new Map<string, (payload: unknown) => void>();
  return {
    bus: {
      publish: vi.fn(),
      subscribe: vi.fn((channel: string, handler: (payload: unknown) => void) => {
        handlers.set(channel, handler);
        return () => handlers.delete(channel);
      }),
    },
    emit(channel: string, payload: unknown) {
      handlers.get(channel)?.(payload);
    },
  };
}

function makeReviewGateTask(overrides: Partial<TaskState['execution']> = {}): TaskState {
  return {
    id: '__merge__wf-1',
    description: 'Review gate for wf-1',
    status: 'review_ready',
    dependencies: [],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    config: { workflowId: 'wf-1', isMergeNode: true },
    execution: {
      generation: 0,
      reviewId: 'owner/repo#1',
      reviewUrl: 'https://github.com/owner/repo/pull/1',
      reviewGate: {
        activeGeneration: 0,
        completion: { required: 'all', status: 'approved' },
        artifacts: [{
          id: 'owner/repo#1',
          providerId: 'owner/repo#1',
          required: true,
          status: 'open',
          generation: 0,
        }],
      },
      ...overrides,
    },
  } as TaskState;
}

describe('review-gate status worker', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('starts in owner mode', async () => {
    vi.useFakeTimers();
    const checkMergeGateStatuses = vi.fn().mockResolvedValue(undefined);

    const worker = startReviewGateStatusWorker({
      ownerMode: true,
      getTaskExecutor: () => ({ checkMergeGateStatuses }),
      logger,
      intervalMs: 1000,
    });

    expect(worker).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1000);
    expect(checkMergeGateStatuses).toHaveBeenCalledTimes(1);
    worker?.stop();
  });

  it('starts in owner mode even when startup auto-run is disabled', async () => {
    vi.useFakeTimers();
    const checkMergeGateStatuses = vi.fn().mockResolvedValue(undefined);

    const worker = startReviewGateStatusWorker({
      ownerMode: true,
      getTaskExecutor: () => ({ checkMergeGateStatuses }),
      logger,
      intervalMs: 1000,
    });

    await vi.advanceTimersByTimeAsync(1000);
    expect(checkMergeGateStatuses).toHaveBeenCalledTimes(1);
    worker?.stop();
  });

  it('does not start in follower or read-only mode', async () => {
    vi.useFakeTimers();
    const checkMergeGateStatuses = vi.fn().mockResolvedValue(undefined);

    const worker = startReviewGateStatusWorker({
      ownerMode: false,
      getTaskExecutor: () => ({ checkMergeGateStatuses }),
      logger,
      intervalMs: 1000,
    });

    expect(worker).toBeNull();
    await vi.advanceTimersByTimeAsync(3000);
    expect(checkMergeGateStatuses).not.toHaveBeenCalled();
  });

  it('does not overlap ticks', async () => {
    vi.useFakeTimers();
    let resolveFirst!: () => void;
    const firstTick = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    const checkMergeGateStatuses = vi.fn()
      .mockReturnValueOnce(firstTick)
      .mockResolvedValue(undefined);

    const worker = startReviewGateStatusWorker({
      ownerMode: true,
      getTaskExecutor: () => ({ checkMergeGateStatuses }),
      logger,
      intervalMs: 1000,
    });

    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(checkMergeGateStatuses).toHaveBeenCalledTimes(1);

    resolveFirst();
    await firstTick;
    await vi.advanceTimersByTimeAsync(1000);
    expect(checkMergeGateStatuses).toHaveBeenCalledTimes(2);
    worker?.stop();
  });

  it('continues after a tick error', async () => {
    vi.useFakeTimers();
    const checkMergeGateStatuses = vi.fn()
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValue(undefined);

    const worker = startReviewGateStatusWorker({
      ownerMode: true,
      getTaskExecutor: () => ({ checkMergeGateStatuses }),
      logger,
      intervalMs: 1000,
    });

    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);

    expect(checkMergeGateStatuses).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledWith('review-gate status worker tick failed', expect.any(Object));
    worker?.stop();
  });

  it('clears the interval on shutdown', async () => {
    vi.useFakeTimers();
    const checkMergeGateStatuses = vi.fn().mockResolvedValue(undefined);

    const worker = startReviewGateStatusWorker({
      ownerMode: true,
      getTaskExecutor: () => ({ checkMergeGateStatuses }),
      logger,
      intervalMs: 1000,
    });

    worker?.stop();
    await vi.advanceTimersByTimeAsync(3000);
    expect(checkMergeGateStatuses).not.toHaveBeenCalled();
  });
  it.each([
    ['review_open', makeReviewGateTask(), 'review open'],
    ['ci_pending', makeReviewGateTask({
      reviewGate: {
        activeGeneration: 0,
        completion: { required: 'all', status: 'approved' },
        artifacts: [{ id: 'owner/repo#1', providerId: 'owner/repo#1', required: true, status: 'open', generation: 0, checksState: 'pending' }],
      },
    }), 'CI pending'],
    ['ci_failing', makeReviewGateTask({
      reviewGate: {
        activeGeneration: 0,
        completion: { required: 'all', status: 'approved' },
        artifacts: [{ id: 'owner/repo#1', providerId: 'owner/repo#1', required: true, status: 'open', generation: 0, checksState: 'failure' }],
      },
    }), 'CI failing'],
    ['merge_conflict', makeReviewGateTask({
      reviewGate: {
        activeGeneration: 0,
        completion: { required: 'all', status: 'approved' },
        artifacts: [{ id: 'owner/repo#1', providerId: 'owner/repo#1', required: true, status: 'open', generation: 0, mergeState: 'dirty' }],
      },
    }), 'merge conflict'],
    ['fix_pending', makeReviewGateTask({ pendingFixError: 'lint failed' }), 'fix pending approval'],
    ['ready_to_land', makeReviewGateTask({
      reviewGate: {
        activeGeneration: 0,
        completion: { required: 'all', status: 'approved' },
        artifacts: [{ id: 'owner/repo#1', providerId: 'owner/repo#1', required: true, status: 'open', generation: 0, checksState: 'success' }],
      },
    }), 'ready to land'],
  ])('emits workflow progress review state for %s', async (_name, mergeTask, expected) => {
    vi.useFakeTimers();
    const relay = createRelayBus();
    const stop = startSurfaceEventRelay({
      messageBus: relay.bus as any,
      persistence: {
        loadTasks: vi.fn(() => [mergeTask]),
        loadWorkflow: vi.fn(() => ({ id: 'wf-1', name: 'Workflow 1' })),
      },
      orchestrator: {
        getWorkflowStatus: vi.fn(() => ({ total: 1, completed: 0 })),
      } as any,
      logWarn: vi.fn(),
    });

    relay.emit(Channels.TASK_DELTA, {
      type: 'updated',
      taskId: mergeTask.id,
      changes: { status: mergeTask.status },
      taskStateVersion: 1,
      previousTaskStateVersion: 0,
    });
    await vi.advanceTimersByTimeAsync(2500);

    expect(relay.bus.publish).toHaveBeenCalledWith(
      Channels.SURFACE_EVENT,
      expect.objectContaining({
        progress: expect.objectContaining({ reviewState: expected }),
      }),
    );
    stop();
  });
});
