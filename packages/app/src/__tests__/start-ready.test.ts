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
  const workflowBaseBranches = new Map<string, string>();
  const freshBaseCommits = new Map<string, string>();
  for (const task of initialTasks) {
    if (task.config.workflowId && !workflowBaseBranches.has(task.config.workflowId)) {
      workflowBaseBranches.set(task.config.workflowId, 'main');
    }
  }
  const orchestrator = {
    syncAllFromDb: vi.fn(() => undefined),
    getAllTasks: vi.fn(() => tasks),
    getTask: vi.fn((taskId: string) => tasks.find((task) => task.id === taskId)),
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
    recreateWorkflowFromFreshBase: vi.fn(async (
      workflowId: string,
      options?: { refreshBase?: () => Promise<{ branch?: string; commit?: string } | undefined | void> },
    ) => {
      const freshBase = await options?.refreshBase?.();
      if (freshBase?.branch) workflowBaseBranches.set(workflowId, freshBase.branch);
      if (freshBase?.commit) freshBaseCommits.set(workflowId, freshBase.commit);
      return orchestrator.recreateWorkflow(workflowId);
    }),
    cancelWorkflow: vi.fn(() => ({ cancelled: [], runningCancelled: [] })),
    cascadeInvalidationToDownstream: vi.fn(() => []),
    getKnownFreshBaseCommit: vi.fn((workflowId: string) => freshBaseCommits.get(workflowId)),
    startExecution: vi.fn(() => [...readyTasks]),
    workflowBaseBranches,
  };
  return orchestrator;
}

function makeCommandService() {
  return {
    runSerializedForWorkflow: vi.fn(async (
      _workflowId: string | undefined,
      fn: () => Promise<unknown> | unknown,
    ) => ({
      ok: true as const,
      data: await fn(),
    })),
  } as any;
}

function makeFreshBaseDeps(
  orchestrator: ReturnType<typeof harness>,
  options: { failWorkflowIds?: string[] } = {},
) {
  const failWorkflowIds = new Set(options.failWorkflowIds ?? []);
  return {
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    persistence: {
      loadWorkflow: vi.fn((workflowId: string) => ({
        id: workflowId,
        generation: 1,
        repoUrl: `https://example.test/${workflowId}.git`,
        baseBranch: orchestrator.workflowBaseBranches.get(workflowId) ?? 'main',
      })),
      updateWorkflow: vi.fn((workflowId: string, changes: { baseBranch?: string }) => {
        if (typeof changes.baseBranch === 'string') {
          orchestrator.workflowBaseBranches.set(workflowId, changes.baseBranch);
        }
      }),
    },
    commandService: makeCommandService(),
    taskExecutor: {
      preparePoolForRebaseRetry: vi.fn(async (workflowId: string) => {
        if (failWorkflowIds.has(workflowId)) {
          throw new Error(`fresh-base failed for ${workflowId}`);
        }
        return {
          branch: `fresh/${workflowId}`,
          commit: `commit-${workflowId}`,
        };
      }),
      killActiveExecution: vi.fn(async () => undefined),
    },
  } as any;
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

  it('routes fresh-base scopes through fresh-base workflow recreation', async () => {
    const failed = makeTask('wf-1/failed', 'failed');
    const pendingOnly = makeTask('wf-2/pending', 'pending');
    const runningOnly = makeTask('wf-3/running', 'running');
    const orchestrator = harness([failed, pendingOnly, runningOnly], []);
    const deps = makeFreshBaseDeps(orchestrator);

    const result = await runStartReady(orchestrator, {
      freshBase: true,
      freshBaseScope: 'failed_and_pending',
    }, deps);

    expect(orchestrator.recreateWorkflowFromFreshBase).toHaveBeenCalledWith(
      'wf-1',
      expect.objectContaining({ refreshBase: expect.any(Function) }),
    );
    expect(orchestrator.recreateWorkflowFromFreshBase).toHaveBeenCalledWith(
      'wf-2',
      expect.objectContaining({ refreshBase: expect.any(Function) }),
    );
    expect(orchestrator.recreateWorkflowFromFreshBase).not.toHaveBeenCalledWith(
      'wf-3',
      expect.anything(),
    );
    expect(deps.taskExecutor.preparePoolForRebaseRetry).toHaveBeenCalledWith(
      'wf-1',
      'https://example.test/wf-1.git',
      'main',
    );
    expect(result.freshBaseWorkflowIds).toEqual(['wf-1', 'wf-2']);
    expect(result.recreatedWorkflowIds).toEqual(['wf-1', 'wf-2']);
    expect(result.preview.freshBaseWorkflows).toEqual([
      { workflowId: 'wf-1', status: 'failed', baseBranch: 'main' },
      { workflowId: 'wf-2', status: 'pending', baseBranch: 'main' },
    ]);
    expect(result.partialOutcomes).toEqual([
      {
        workflowId: 'wf-1',
        ok: true,
        startedTaskIds: ['wf-1/recreated'],
        freshBaseBranch: 'fresh/wf-1',
        freshBaseCommit: 'commit-wf-1',
      },
      {
        workflowId: 'wf-2',
        ok: true,
        startedTaskIds: ['wf-2/recreated'],
        freshBaseBranch: 'fresh/wf-2',
        freshBaseCommit: 'commit-wf-2',
      },
    ]);
  });

  it('continues fresh-base recreation after a workflow failure and reports partial outcomes', async () => {
    const failed = makeTask('wf-1/failed', 'failed');
    const pendingOnly = makeTask('wf-2/pending', 'pending');
    const ready = makeTask('wf-3/ready', 'pending');
    const orchestrator = harness([failed, pendingOnly, ready], [ready]);
    const deps = makeFreshBaseDeps(orchestrator, { failWorkflowIds: ['wf-2'] });

    const result = await runStartReady(orchestrator, {
      freshBaseWorkflowIds: ['wf-1', 'wf-2'],
    }, deps);

    expect(orchestrator.recreateWorkflowFromFreshBase).toHaveBeenCalledWith(
      'wf-1',
      expect.objectContaining({ refreshBase: expect.any(Function) }),
    );
    expect(deps.taskExecutor.preparePoolForRebaseRetry).toHaveBeenCalledWith(
      'wf-2',
      'https://example.test/wf-2.git',
      'main',
    );
    expect(result.recreatedWorkflowIds).toEqual(['wf-1']);
    expect(result.partial).toBe(true);
    expect(result.partialOutcomes).toEqual([
      {
        workflowId: 'wf-1',
        ok: true,
        startedTaskIds: ['wf-1/recreated'],
        freshBaseBranch: 'fresh/wf-1',
        freshBaseCommit: 'commit-wf-1',
      },
      {
        workflowId: 'wf-2',
        ok: false,
        error: 'fresh-base failed for wf-2',
      },
    ]);
    expect(result.started.map((task) => task.id)).toEqual([
      'wf-1/recreated',
      'wf-3/ready',
    ]);
  });

  it('uses explicit fresh-base workflow ids instead of status scope selection', async () => {
    const failed = makeTask('wf-1/failed', 'failed');
    const pendingOnly = makeTask('wf-2/pending', 'pending');
    const runningOnly = makeTask('wf-3/running', 'running');
    const orchestrator = harness([failed, pendingOnly, runningOnly], []);
    const deps = makeFreshBaseDeps(orchestrator);

    const result = await runStartReady(orchestrator, {
      freshBaseScope: 'failed',
      freshBaseWorkflowIds: ['wf-3'],
    }, deps);

    expect(orchestrator.recreateWorkflowFromFreshBase).toHaveBeenCalledTimes(1);
    expect(orchestrator.recreateWorkflowFromFreshBase).toHaveBeenCalledWith(
      'wf-3',
      expect.objectContaining({ refreshBase: expect.any(Function) }),
    );
    expect(result.freshBaseWorkflowIds).toEqual(['wf-3']);
    expect(result.preview.freshBaseWorkflows).toEqual([
      { workflowId: 'wf-3', status: 'running', baseBranch: 'main' },
    ]);
  });
});
