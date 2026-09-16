import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskState } from '@invoker/workflow-core';
import { createRendererTaskFeed } from '../window/renderer-task-feed.js';

describe('headless db-poll executing stall tail classification', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fails a stalled task with the definitive infra class found in its output tail', async () => {
    const now = new Date('2026-08-23T08:00:00.000Z');
    vi.setSystemTime(now);

    const diskFullTask = {
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
      ...diskFullTask,
      id: 'wf-headless/plain-stall',
    } as unknown as TaskState;
    const tasks = [diskFullTask, plainTask];

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
        loadTasks: () => tasks,
        loadTasksForWorkflows: () => tasks,
        loadTask: (taskId: string) => tasks.find((task) => task.id === taskId),
        loadAttempt: () => ({
          status: 'running',
          leaseExpiresAt: new Date(now.getTime() - 5 * 60_000).toISOString(),
          lastHeartbeatAt: new Date(now.getTime() - 20 * 60_000).toISOString(),
        }),
        writeActivityLog: vi.fn(),
        appendOutputChunk: vi.fn(),
        getOutputTail: (taskId: string) => taskId === diskFullTask.id
          ? [{ data: 'write failed: No space left on device\n' }]
          : [],
        appendTaskOutput: vi.fn(),
      },
      messageBus: { publish: vi.fn() },
      getOrchestrator: () => ({
        getAllTasks: () => tasks,
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
    const responseFor = (actionId: string) =>
      handleWorkerResponse.mock.calls.map((call) => call[0]).find((response) => response.actionId === actionId);

    expect(responseFor(diskFullTask.id)).toMatchObject({
      status: 'failed',
      outputs: {
        error: 'write failed: No space left on device',
        failureClass: 'ssh-disk-full',
      },
    });

    const plainResponse = responseFor(plainTask.id);
    expect(plainResponse).toMatchObject({
      status: 'failed',
      outputs: { failureClass: 'liveness_stall' },
    });
    expect(String(plainResponse.outputs.error)).toContain('Execution stalled');
    expect(String(plainResponse.outputs.error)).toContain('attempt lease expired');
    expect(publishDelta).not.toHaveBeenCalled();

    handle.stop();
  });
});
