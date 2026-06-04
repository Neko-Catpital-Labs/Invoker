import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Channels, LocalBus } from '@invoker/transport';
import type { TaskState } from '@invoker/workflow-core';

import { buildTaskUpdatedLifecycleEvent } from '../lifecycle-events.js';
import {
  buildExternalRecoveryContext,
  scanExternalRecoveryCandidates,
  startExternalRecoveryWorker,
} from '../external-recovery-worker.js';

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(() => logger),
};

function makeTask(overrides: Partial<TaskState> = {}): TaskState {
  const { config, execution, ...rest } = overrides;
  return {
    id: 'wf-1/task-a',
    description: 'Task A',
    status: 'failed',
    dependencies: [],
    createdAt: new Date('2026-06-04T00:00:00.000Z'),
    taskStateVersion: 3,
    ...rest,
    config: {
      workflowId: 'wf-1',
      ...config,
    },
    execution: {
      generation: 1,
      selectedAttemptId: 'attempt-1',
      lastHeartbeatAt: new Date('2026-06-04T00:00:00.000Z'),
      ...execution,
    },
  } as TaskState;
}

function makePersistence(tasks: TaskState[]) {
  return {
    listWorkflows: vi.fn(() => [{ id: 'wf-1' }]),
    loadTasks: vi.fn(() => tasks),
  };
}

describe('external-recovery-worker', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('launches external recovery only from worker scans on lifecycle wakeup', async () => {
    const bus = new LocalBus();
    const launchExternalRecovery = vi.fn(() => ({ status: 'launched' as const, pid: 123 }));
    const worker = startExternalRecoveryWorker({
      logger,
      messageBus: bus,
      persistence: makePersistence([makeTask()]),
      orchestrator: { syncFromDb: vi.fn() },
      repoRoot: '/repo',
      dbDir: '/db',
      getConfig: () => ({
        externalFailureRecovery: {
          enabled: true,
          command: 'bash scripts/prod-recreate-supervisor.sh',
          cooldownSeconds: 60,
        },
      } as any),
      launchExternalRecovery,
      pollIntervalMs: 0,
      startImmediately: false,
      signalNames: [],
    });

    expect(launchExternalRecovery).not.toHaveBeenCalled();
    bus.publish(Channels.WORKFLOW_LIFECYCLE, buildTaskUpdatedLifecycleEvent({
      workflowId: 'wf-1',
      taskId: 'wf-1/task-a',
      status: 'failed',
      previousStatus: 'running',
      taskStateVersion: 3,
      generation: 1,
      createdAt: '2026-06-04T00:00:00.000Z',
    }));
    await worker.waitForIdle();

    expect(launchExternalRecovery).toHaveBeenCalledWith(
      {
        failedTaskId: 'wf-1/task-a',
        failedWorkflowId: 'wf-1',
        repoRoot: '/repo',
        dbDir: '/db',
        reason: 'task_failed',
      },
      expect.objectContaining({
        trigger: expect.objectContaining({ kind: 'lifecycle' }),
        candidate: expect.objectContaining({ taskId: 'wf-1/task-a', reason: 'task_failed' }),
      }),
    );

    await worker.stop();
  });

  it('recovers missed lifecycle events by polling persisted failed tasks', async () => {
    vi.useFakeTimers();
    const bus = new LocalBus();
    const launchExternalRecovery = vi.fn(() => ({ status: 'launched' as const }));
    const worker = startExternalRecoveryWorker({
      logger,
      messageBus: bus,
      persistence: makePersistence([makeTask()]),
      repoRoot: '/repo',
      dbDir: '/db',
      getConfig: () => ({
        externalFailureRecovery: {
          enabled: true,
          command: 'recover',
        },
      } as any),
      launchExternalRecovery,
      pollIntervalMs: 1000,
      startImmediately: false,
      signalNames: [],
    });

    await vi.advanceTimersByTimeAsync(1000);
    await worker.waitForIdle();

    expect(launchExternalRecovery).toHaveBeenCalledWith(
      expect.objectContaining({ failedTaskId: 'wf-1/task-a', reason: 'task_failed' }),
      expect.objectContaining({ trigger: expect.objectContaining({ kind: 'poll' }) }),
    );

    await worker.stop();
  });

  it('finds configured stalled active tasks during persisted scans', () => {
    const staleRunning = makeTask({
      status: 'running',
      execution: {
        generation: 2,
        selectedAttemptId: 'attempt-2',
        lastHeartbeatAt: new Date('2026-06-04T00:00:00.000Z'),
      },
      taskStateVersion: 8,
    });

    const candidates = scanExternalRecoveryCandidates({
      logger,
      persistence: makePersistence([staleRunning]),
      getConfig: () => ({
        externalFailureRecovery: {
          enabled: true,
          command: 'recover',
          stalledTaskSeconds: 60,
        },
      } as any),
      now: () => new Date('2026-06-04T00:02:00.000Z'),
    }, {
      workerName: 'external-recovery',
      trigger: { kind: 'poll', at: new Date('2026-06-04T00:02:00.000Z') },
    });

    expect(candidates).toEqual([{
      workflowId: 'wf-1',
      taskId: 'wf-1/task-a',
      reason: 'task_stalled',
      taskStateVersion: 8,
      generation: 2,
      attemptId: 'attempt-2',
    }]);
  });

  it('does not scan candidates when the operator hook is disabled or missing command', () => {
    const task = makeTask();
    expect(scanExternalRecoveryCandidates({
      logger,
      persistence: makePersistence([task]),
      getConfig: () => ({} as any),
    }, {
      workerName: 'external-recovery',
      trigger: { kind: 'manual', at: new Date() },
    })).toEqual([]);
  });

  it('preserves the launcher context contract', () => {
    expect(buildExternalRecoveryContext({
      workflowId: 'wf-1',
      taskId: 'wf-1/task-a',
      reason: 'task_failed',
      taskStateVersion: 3,
      generation: 1,
    }, {
      repoRoot: '/repo',
      dbDir: '/db',
    })).toEqual({
      failedTaskId: 'wf-1/task-a',
      failedWorkflowId: 'wf-1',
      repoRoot: '/repo',
      dbDir: '/db',
      reason: 'task_failed',
    });
  });

  it('keeps failed-delta producers from importing external recovery launchers', () => {
    const sourcePath = join(dirname(fileURLToPath(import.meta.url)), '..', 'lifecycle-event-bridge.ts');
    const source = readFileSync(sourcePath, 'utf8');

    expect(source).not.toMatch(/external-failure-recovery/);
    expect(source).not.toMatch(/external-recovery-worker/);
    expect(source).not.toMatch(/launchExternalRecovery/);
  });
});
