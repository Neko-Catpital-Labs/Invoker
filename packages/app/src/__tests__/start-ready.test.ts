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
      tasks = tasks.filter((task) => task.config.workflowId !== workflowId || task.status !== 'failed');
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
      skipped: {
        awaitingApproval: 1,
        reviewReady: 0,
        blocked: 1,
        failedTasks: 1,
      },
    });
  });

  it('dry-run reports the preview without mutating work', () => {
    const ready = makeTask('wf-1/ready', 'pending');
    const recoverable = makeTask('wf-1/recoverable', 'running');
    const orchestrator = harness([ready, recoverable], [ready]);

    const result = runStartReady(orchestrator, { dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.started).toEqual([]);
    expect(orchestrator.prepareTaskForNewAttempt).not.toHaveBeenCalled();
    expect(orchestrator.startExecution).not.toHaveBeenCalled();
  });

  it('recovers interrupted claims and starts executable ready tasks', () => {
    const ready = makeTask('wf-1/ready', 'pending');
    const recoverable = makeTask('wf-1/recoverable', 'running');
    const orchestrator = harness([ready, recoverable], [ready]);

    const result = runStartReady(orchestrator);

    expect(orchestrator.syncAllFromDb).toHaveBeenCalledTimes(1);
    expect(orchestrator.prepareTaskForNewAttempt).toHaveBeenCalledWith('wf-1/recoverable', 'start_ready_recovery');
    expect(orchestrator.startExecution).toHaveBeenCalledTimes(1);
    expect(result.started.map((task) => task.id)).toEqual(['wf-1/ready']);
  });

  it('leaves actively executing tasks alone instead of superseding their attempts', () => {
    const ready = makeTask('wf-1/ready', 'pending');
    const live = makeTask('wf-1/live', 'running', {
      execution: { selectedAttemptId: 'attempt-live' },
    });
    const orphaned = makeTask('wf-1/orphaned', 'running');
    const orchestrator = harness([ready, live, orphaned], [ready], ['wf-1/live']);

    const result = runStartReady(orchestrator);

    expect(orchestrator.prepareTaskForNewAttempt).not.toHaveBeenCalledWith('wf-1/live', 'start_ready_recovery');
    expect(orchestrator.prepareTaskForNewAttempt).toHaveBeenCalledWith('wf-1/orphaned', 'start_ready_recovery');
    expect(result.preview.recoverableTaskIds).toEqual(['wf-1/orphaned']);
  });

  it('recreates failed workflows only when requested', () => {
    const failed = makeTask('wf-1/failed', 'failed');
    const orchestrator = harness([failed], []);

    const result = runStartReady(orchestrator, { recreateFailed: true });

    expect(orchestrator.recreateWorkflow).toHaveBeenCalledWith('wf-1');
    expect(result.recreatedWorkflowIds).toEqual(['wf-1']);
    expect(result.started.map((task) => task.id)).toEqual(['wf-1/recreated']);
  });
});
