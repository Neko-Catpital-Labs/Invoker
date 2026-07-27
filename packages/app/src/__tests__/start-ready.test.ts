import { describe, expect, it, vi } from 'vitest';
import type { TaskState } from '@invoker/workflow-core';

import { collectStartReadyPreview, runStartReady } from '../start-ready.js';

function makeTask(
  id: string,
  status: TaskState['status'],
  overrides: Partial<TaskState> = {},
): TaskState {
  return {
    id,
    description: id,
    status,
    dependencies: [],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    config: { workflowId: id.split('/')[0] ?? 'wf-1' },
    execution: {},
    taskStateVersion: 1,
    ...overrides,
  } as TaskState;
}

function harness(initialTasks: TaskState[], readyTasks: TaskState[], activeTaskIds: string[] = []) {
  let tasks = [...initialTasks];
  const orchestrator = {
    syncAllFromDb: vi.fn(() => undefined),
    getAllTasks: vi.fn(() => tasks),
    getPersistedActiveTaskIds: vi.fn(() => new Set(activeTaskIds)),
    getExecutableReadyTasks: vi.fn(() => readyTasks),
    prepareTaskForNewAttempt: vi.fn((taskId: string) => {
      tasks = tasks.map((task) => task.id === taskId
        ? { ...task, status: 'pending' as TaskState['status'], execution: {} }
        : task);
      return tasks.find((task) => task.id === taskId) as TaskState;
    }),
    recreateWorkflow: vi.fn((workflowId: string) => {
      const recreated = makeTask(`${workflowId}/recreated`, 'pending');
      tasks = tasks.filter((task) => task.config.workflowId !== workflowId
        || (task.status !== 'failed' && task.status !== 'pending' && (task.status as string) !== 'queued'));
      tasks.push(recreated);
      readyTasks.push(recreated);
      return [recreated];
    }),
    startExecution: vi.fn(() => [...readyTasks]),
  };
  return orchestrator;
}

describe('start-ready', () => {
  it('previews ready, recoverable, failed, and gated work', () => {
    const ready = makeTask('wf-1/ready', 'pending');
    const recoverable = makeTask('wf-1/recoverable', 'pending', {
      execution: { selectedAttemptId: 'attempt-1', phase: 'launching' },
    });
    const failed = makeTask('wf-2/failed', 'failed');
    const approval = makeTask('wf-3/approval', 'awaiting_approval');
    const blocked = makeTask('wf-4/blocked', 'blocked');
    const orchestrator = harness([ready, recoverable, failed, approval, blocked], [ready]);

    expect(collectStartReadyPreview(orchestrator)).toEqual({
      readyTaskIds: ['wf-1/ready'],
      recoverableTaskIds: ['wf-1/recoverable'],
      failedWorkflowIds: ['wf-2'],
      pendingWorkflowIds: ['wf-1'],
      runningWorkflowIds: [],
      completedWorkflowIds: [],
      skipped: {
        awaitingApproval: 1,
        reviewReady: 0,
        blocked: 1,
        failedTasks: 1,
        pendingTasks: 2,
        runningTasks: 0,
        completedTasks: 0,
      },
    });
  });

  it('dry-run reports the preview without mutating work', async () => {
    const ready = makeTask('wf-1/ready', 'pending');
    const recoverable = makeTask('wf-1/recoverable', 'running');
    const orchestrator = harness([ready, recoverable], [ready]);

    const result = await runStartReady(orchestrator, { dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.started).toEqual([]);
    expect(orchestrator.prepareTaskForNewAttempt).not.toHaveBeenCalled();
    expect(orchestrator.startExecution).not.toHaveBeenCalled();
  });

  it('recovers interrupted claims and starts executable ready tasks', async () => {
    const ready = makeTask('wf-1/ready', 'pending');
    const recoverable = makeTask('wf-1/recoverable', 'running');
    const orchestrator = harness([ready, recoverable], [ready]);

    const result = await runStartReady(orchestrator);

    expect(orchestrator.syncAllFromDb).toHaveBeenCalledTimes(1);
    expect(orchestrator.prepareTaskForNewAttempt).toHaveBeenCalledWith('wf-1/recoverable', 'start_ready_recovery');
    expect(orchestrator.startExecution).toHaveBeenCalledTimes(1);
    expect(result.started.map((task) => task.id)).toEqual(['wf-1/ready']);
  });

  it('leaves actively executing tasks alone instead of superseding their attempts', async () => {
    const ready = makeTask('wf-1/ready', 'pending');
    const live = makeTask('wf-1/live', 'running', {
      execution: { selectedAttemptId: 'attempt-live' },
    });
    const orphaned = makeTask('wf-1/orphaned', 'running');
    const orchestrator = harness([ready, live, orphaned], [ready], ['wf-1/live']);

    const result = await runStartReady(orchestrator);

    expect(orchestrator.prepareTaskForNewAttempt).not.toHaveBeenCalledWith('wf-1/live', 'start_ready_recovery');
    expect(orchestrator.prepareTaskForNewAttempt).toHaveBeenCalledWith('wf-1/orphaned', 'start_ready_recovery');
    expect(result.preview.recoverableTaskIds).toEqual(['wf-1/orphaned']);
  });

  it('recreates failed workflows only when requested', async () => {
    const failed = makeTask('wf-1/failed', 'failed');
    const pendingOnly = makeTask('wf-2/pending', 'pending');
    const orchestrator = harness([failed, pendingOnly], []);

    const result = await runStartReady(orchestrator, { recreateFailed: true });

    expect(orchestrator.recreateWorkflow).toHaveBeenCalledWith('wf-1');
    expect(orchestrator.recreateWorkflow).not.toHaveBeenCalledWith('wf-2');
    expect(result.recreatedWorkflowIds).toEqual(['wf-1']);
    expect(result.started.map((task) => task.id)).toEqual(['wf-1/recreated']);
  });

  it('recreates failed and pending/queued workflows when requested', async () => {
    const failed = makeTask('wf-1/failed', 'failed');
    const pendingOnly = makeTask('wf-2/pending', 'pending');
    const queuedOnly = makeTask('wf-3/queued', 'queued' as TaskState['status']);
    const orchestrator = harness([failed, pendingOnly, queuedOnly], []);

    const result = await runStartReady(orchestrator, { recreateFailedAndPending: true });

    expect(orchestrator.recreateWorkflow).toHaveBeenCalledWith('wf-1');
    expect(orchestrator.recreateWorkflow).toHaveBeenCalledWith('wf-2');
    expect(orchestrator.recreateWorkflow).toHaveBeenCalledWith('wf-3');
    expect(result.recreatedWorkflowIds).toEqual(['wf-1', 'wf-2', 'wf-3']);
  });

  it('prefers failed-and-pending union when both recreate flags are set', async () => {
    const failed = makeTask('wf-1/failed', 'failed');
    const pendingOnly = makeTask('wf-2/pending', 'pending');
    const orchestrator = harness([failed, pendingOnly], []);

    const result = await runStartReady(orchestrator, {
      recreateFailed: true,
      recreateFailedAndPending: true,
    });

    expect(result.recreatedWorkflowIds).toEqual(['wf-1', 'wf-2']);
  });

  it('recreates failed, pending/queued, and running workflows when requested', async () => {
    const failed = makeTask('wf-1/failed', 'failed');
    const pendingOnly = makeTask('wf-2/pending', 'pending');
    const runningOnly = makeTask('wf-3/running', 'running');
    const approval = makeTask('wf-4/approval', 'awaiting_approval');
    const orchestrator = harness([failed, pendingOnly, runningOnly, approval], []);

    const result = await runStartReady(orchestrator, { recreateFailedPendingAndRunning: true });

    expect(orchestrator.recreateWorkflow).toHaveBeenCalledWith('wf-1');
    expect(orchestrator.recreateWorkflow).toHaveBeenCalledWith('wf-2');
    expect(orchestrator.recreateWorkflow).toHaveBeenCalledWith('wf-3');
    expect(orchestrator.recreateWorkflow).not.toHaveBeenCalledWith('wf-4');
    expect(result.recreatedWorkflowIds).toEqual(['wf-1', 'wf-2', 'wf-3']);
  });

  it('failed-and-pending does not recreate running-only workflows', async () => {
    const runningOnly = makeTask('wf-1/running', 'running');
    const orchestrator = harness([runningOnly], []);

    const result = await runStartReady(orchestrator, { recreateFailedAndPending: true });

    expect(orchestrator.recreateWorkflow).not.toHaveBeenCalled();
    expect(result.recreatedWorkflowIds).toEqual([]);
  });

  it('prefers failed-pending-and-running union when all recreate flags are set', async () => {
    const failed = makeTask('wf-1/failed', 'failed');
    const pendingOnly = makeTask('wf-2/pending', 'pending');
    const runningOnly = makeTask('wf-3/running', 'running');
    const orchestrator = harness([failed, pendingOnly, runningOnly], []);

    const result = await runStartReady(orchestrator, {
      recreateFailed: true,
      recreateFailedAndPending: true,
      recreateFailedPendingAndRunning: true,
    });

    expect(result.recreatedWorkflowIds).toEqual(['wf-1', 'wf-2', 'wf-3']);
  });

  it('recreates failed, pending/queued, running, and completed workflows when recreateAll is set', async () => {
    const failed = makeTask('wf-1/failed', 'failed');
    const pendingOnly = makeTask('wf-2/pending', 'pending');
    const runningOnly = makeTask('wf-3/running', 'running');
    const completedOnly = makeTask('wf-4/completed', 'completed');
    const approval = makeTask('wf-5/approval', 'awaiting_approval');
    const orchestrator = harness(
      [failed, pendingOnly, runningOnly, completedOnly, approval],
      [],
    );

    const result = await runStartReady(orchestrator, { recreateAll: true });

    expect(orchestrator.recreateWorkflow).toHaveBeenCalledWith('wf-1');
    expect(orchestrator.recreateWorkflow).toHaveBeenCalledWith('wf-2');
    expect(orchestrator.recreateWorkflow).toHaveBeenCalledWith('wf-3');
    expect(orchestrator.recreateWorkflow).toHaveBeenCalledWith('wf-4');
    expect(orchestrator.recreateWorkflow).not.toHaveBeenCalledWith('wf-5');
    expect(result.recreatedWorkflowIds).toEqual(['wf-1', 'wf-2', 'wf-3', 'wf-4']);
    expect(result.preview.completedWorkflowIds).toEqual(['wf-4']);
  });

  it('prefers recreateAll over narrower recreate flags', async () => {
    const failed = makeTask('wf-1/failed', 'failed');
    const completedOnly = makeTask('wf-2/completed', 'completed');
    const orchestrator = harness([failed, completedOnly], []);

    const result = await runStartReady(orchestrator, {
      recreateFailed: true,
      recreateAll: true,
    });

    expect(result.recreatedWorkflowIds).toEqual(['wf-1', 'wf-2']);
  });

  it('previews fresh-base workflows for requested scope variants', async () => {
    const failed = makeTask('wf-1/failed', 'failed');
    const pendingOnly = makeTask('wf-2/pending', 'pending');
    const queuedOnly = makeTask('wf-3/queued', 'queued' as TaskState['status']);
    const runningOnly = makeTask('wf-4/running', 'running');
    const completedOnly = makeTask('wf-5/completed', 'completed');
    const approval = makeTask('wf-6/approval', 'awaiting_approval');
    const tasks = [failed, pendingOnly, queuedOnly, runningOnly, completedOnly, approval];

    const failedPreview = await runStartReady(harness(tasks, []), {
      dryRun: true,
      freshBase: true,
      freshBaseScope: 'failed',
    });
    expect(failedPreview.preview.freshBaseWorkflowIds).toEqual(['wf-1']);
    expect(failedPreview.preview.freshBaseWorkflows).toEqual([
      { workflowId: 'wf-1', status: 'failed' },
    ]);

    const failedAndPendingPreview = await runStartReady(harness(tasks, []), {
      dryRun: true,
      freshBase: true,
      freshBaseScope: 'failed_and_pending',
    });
    expect(failedAndPendingPreview.preview.freshBaseWorkflowIds).toEqual(['wf-1', 'wf-2', 'wf-3']);

    const failedPendingAndRunningPreview = await runStartReady(harness(tasks, []), {
      dryRun: true,
      freshBase: true,
      freshBaseScope: 'failed_pending_and_running',
    });
    expect(failedPendingAndRunningPreview.preview.freshBaseWorkflowIds).toEqual([
      'wf-1',
      'wf-2',
      'wf-3',
      'wf-4',
    ]);

    const allPreview = await runStartReady(harness(tasks, []), {
      dryRun: true,
      freshBase: true,
      freshBaseScope: 'all',
    });
    expect(allPreview.preview.freshBaseWorkflowIds).toEqual(['wf-1', 'wf-2', 'wf-3', 'wf-4', 'wf-5']);
  });

  it('runs fresh-base recreates with continue-on-error partial outcomes', async () => {
    const failed = makeTask('wf-1/failed', 'failed');
    const pendingOnly = makeTask('wf-2/pending', 'pending');
    const runningOnly = makeTask('wf-3/running', 'running');
    const orchestrator = harness([failed, pendingOnly, runningOnly], []);
    const recreateWorkflowFromFreshBase = vi.fn(async (workflowId: string) => {
      if (workflowId === 'wf-2') throw new Error('fresh-base failed');
      return {
        started: [makeTask(`${workflowId}/fresh`, 'pending')],
        freshBaseBranch: `fresh/${workflowId}`,
        freshBaseCommit: `${workflowId}-sha`,
      };
    });

    const result = await runStartReady(
      orchestrator,
      { freshBase: true, freshBaseScope: 'failed_pending_and_running' },
      { recreateWorkflowFromFreshBase },
    );

    expect(orchestrator.recreateWorkflow).not.toHaveBeenCalled();
    expect(recreateWorkflowFromFreshBase).toHaveBeenCalledWith('wf-1');
    expect(recreateWorkflowFromFreshBase).toHaveBeenCalledWith('wf-2');
    expect(recreateWorkflowFromFreshBase).toHaveBeenCalledWith('wf-3');
    expect(result.freshBaseWorkflowIds).toEqual(['wf-1', 'wf-2', 'wf-3']);
    expect(result.recreatedWorkflowIds).toEqual(['wf-1', 'wf-3']);
    expect(result.started.map((task) => task.id)).toEqual(['wf-1/fresh', 'wf-3/fresh']);
    expect(result.partial).toBe(true);
    expect(result.partialOutcomes).toEqual([
      {
        workflowId: 'wf-1',
        ok: true,
        startedTaskIds: ['wf-1/fresh'],
        freshBaseBranch: 'fresh/wf-1',
        freshBaseCommit: 'wf-1-sha',
      },
      {
        workflowId: 'wf-2',
        ok: false,
        error: 'fresh-base failed',
      },
      {
        workflowId: 'wf-3',
        ok: true,
        startedTaskIds: ['wf-3/fresh'],
        freshBaseBranch: 'fresh/wf-3',
        freshBaseCommit: 'wf-3-sha',
      },
    ]);
  });
});
