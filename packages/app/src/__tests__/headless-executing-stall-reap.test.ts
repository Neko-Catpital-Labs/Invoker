import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskState } from '@invoker/workflow-core';
import { createRendererTaskFeed } from '../window/renderer-task-feed.js';

describe('headless db-poll executing stall', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reaps an expired-lease running task when getMainWindow() is null', async () => {
    const now = new Date('2026-08-23T08:00:00.000Z');
    vi.setSystemTime(now);

    const staleTask = {
      id: 'wf-headless/disk-full-tail',
      status: 'running',
      config: {
        workflowId: 'wf-headless',
        runnerKind: 'worktree',
      },
      execution: {
        phase: 'executing',
        generation: 0,
        selectedAttemptId: 'attempt-stale',
        startedAt: new Date(now.getTime() - 30 * 60_000).toISOString(),
        lastHeartbeatAt: new Date(now.getTime() - 20 * 60_000).toISOString(),
      },
    } as unknown as TaskState;
    const plainTask = {
      ...staleTask,
      id: 'wf-headless/plain-stall',
    } as unknown as TaskState;

    const handleWorkerResponse = vi.fn();
    const publishDelta = vi.fn();
    const requestWorkflowMetadataPublish = vi.fn();
    const pollLaunchDispatcher = vi.fn();

    const feed = createRendererTaskFeed({
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
      persistence: {
        listWorkflows: () => [{ id: 'wf-headless', status: 'running' } as never],
        loadTasks: () => [staleTask, plainTask],
        loadTasksForWorkflows: () => [staleTask, plainTask],
        loadTask: () => staleTask,
        loadAttempt: () => ({
          status: 'running',
          leaseExpiresAt: new Date(now.getTime() - 5 * 60_000).toISOString(),
          lastHeartbeatAt: new Date(now.getTime() - 20 * 60_000).toISOString(),
        }),
        writeActivityLog: vi.fn(),
        appendOutputChunk: vi.fn(),
        getOutputTail: (taskId: string) => taskId === staleTask.id
          ? [{ data: 'write failed: No space left on device\n' }]
          : [],
        appendTaskOutput: vi.fn(),
      },
      messageBus: { publish: vi.fn() },
      getOrchestrator: () => ({
        getAllTasks: () => [staleTask, plainTask],
        getMergeNode: () => undefined,
        syncAllFromDb: vi.fn(),
        handleWorkerResponse,
        reclaimStalledFixSession: vi.fn(),
      }),
      taskHandles: { has: () => false },
      taskGraphEventPublisher: { publishDelta },
      getMainWindow: () => null,
      setStartupWorkflowId: vi.fn(),
      requestWorkflowMetadataPublish,
      scheduleAutoFix: vi.fn(),
      logAutoFixDebug: vi.fn(),
      uiPerfStats: {
        mainDeltaToUi: 0,
        dbPollCreated: 0,
        dbPollUpdatedAsCreated: 0,
        workflowMetadataPublishes: 0,
        workflowMetadataCoalescedRequests: 0,
      },
      traceUiDeltaFlow: false,
      traceDbPollPerTask: false,
      traceTaskOutput: false,
      executingStallTimeoutMs: 120_000,
      pollLaunchDispatcher,
    });

    const handle = feed.startDbPolling();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(handleWorkerResponse).toHaveBeenCalledTimes(2);
    const diskFullResponse = handleWorkerResponse.mock.calls[0]?.[0];
    expect(diskFullResponse).toMatchObject({
      actionId: 'wf-headless/disk-full-tail',
      status: 'failed',
      outputs: {
        error: 'write failed: No space left on device',
        failureClass: 'ssh-disk-full',
      },
    });
    const plainResponse = handleWorkerResponse.mock.calls[1]?.[0];
    expect(plainResponse).toMatchObject({
      actionId: 'wf-headless/plain-stall',
      status: 'failed',
      outputs: { failureClass: 'liveness_stall' },
    });
    expect(String(plainResponse.outputs.error)).toContain('attempt lease expired');
    expect(publishDelta).not.toHaveBeenCalled();
    expect(requestWorkflowMetadataPublish).not.toHaveBeenCalled();
    expect(pollLaunchDispatcher).toHaveBeenCalled();

    handle.stop();
  });
});
