import { afterEach, describe, expect, it } from 'vitest';
import { SQLiteAdapter } from '@invoker/data-store';
import {
  DISPATCH_LEASE_MS,
  LAUNCH_STUCK_ABANDON_MS,
} from '@invoker/contracts';
import { InMemoryBus } from '@invoker/test-kit';
import { Orchestrator, type PlanDefinition, type TaskDelta, type TaskState } from '@invoker/workflow-core';
import { LaunchDispatcher } from '../launch-dispatcher.js';
import { taskNeedsExecutingStallCheck } from '../executing-stall.js';
import { applyDelta, recoverQuarantinedTask, TaskSnapshotCache } from '../delta-merge.js';
import { WorkflowRollupProjection } from '../workflow-rollup-projection.js';

function makeTask(
  id: string,
  workflowId: string,
  status: TaskState['status'] = 'pending',
  overrides: Partial<TaskState> = {},
): TaskState {
  const { config, execution, ...rest } = overrides;
  return {
    id,
    description: `Task ${id}`,
    status,
    dependencies: [],
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    config: {
      workflowId,
      command: `echo ${id}`,
      runnerKind: 'ssh',
      poolId: 'mixed-local-ssh',
      ...config,
    },
    execution: {
      generation: 0,
      ...execution,
    },
    taskStateVersion: 1,
    ...rest,
  } as TaskState;
}

function buildSingleTaskPlan(name: string, taskId: string): PlanDefinition {
  return {
    name,
    tasks: [
      {
        id: taskId,
        description: taskId,
        command: `echo ${taskId}`,
      },
    ],
  };
}

async function makeHarness(maxConcurrency = 4) {
  const persistence = await SQLiteAdapter.create(':memory:');
  const orchestrator = new Orchestrator({
    persistence: persistence as any,
    messageBus: new InMemoryBus(),
    maxConcurrency,
    deferRunningUntilLaunch: true,
  });
  const dispatcher = new LaunchDispatcher({
    persistence,
    orchestrator: {
      prepareTaskForNewAttempt: (taskId, reason) => orchestrator.prepareTaskForNewAttempt(taskId, reason),
      getTask: (taskId) => orchestrator.getTask(taskId),
      startExecution: () => orchestrator.startExecution(),
      syncFromDb: (workflowId) => orchestrator.syncFromDb(workflowId),
      getTaskLaunchReadiness: (taskId) => orchestrator.getTaskLaunchReadiness(taskId),
    },
    ownerId: 'dispatch-invariants-owner',
    maxLeasesPerPoll: maxConcurrency,
  });
  return { persistence, orchestrator, dispatcher };
}

function claimAllLaunches(persistence: SQLiteAdapter, count: number, nowIso: string) {
  const claimed: Array<{ id: number; taskId: string; attemptId: string }> = [];
  for (let i = 0; i < count; i += 1) {
    const row = persistence.claimLaunchDispatchAtomic({
      ownerId: 'dispatch-invariants-owner',
      nowIso,
    });
    if (!row) {
      throw new Error(`Expected leased dispatch row ${i + 1}/${count}`);
    }
    claimed.push({ id: row.id, taskId: row.taskId, attemptId: row.attemptId });
  }
  return claimed;
}

function latestTaskId(persistence: SQLiteAdapter) {
  const taskId = persistence.getAllTaskIds().at(-1);
  if (!taskId) {
    throw new Error('Expected at least one task id');
  }
  return taskId;
}

function loadSingleTaskWorkflow(orchestrator: Orchestrator, persistence: SQLiteAdapter, name: string, taskId: string) {
  orchestrator.loadPlan(buildSingleTaskPlan(name, taskId));
  return latestTaskId(persistence);
}


function forceDispatchAge(
  persistence: SQLiteAdapter,
  dispatchId: number,
  { enqueuedAt, fencedUntil }: { enqueuedAt: string; fencedUntil?: string },
) {
  const db = (persistence as any).db;
  db.run(
    `UPDATE task_launch_dispatch
        SET enqueued_at = ?, fenced_until = ?, leased_at = ?, attempts_count = 1
      WHERE id = ?`,
    [enqueuedAt, fencedUntil ?? null, enqueuedAt, dispatchId],
  );
}

describe('dispatch capacity invariants', () => {
  const adapters: SQLiteAdapter[] = [];

  afterEach(() => {
    for (const adapter of adapters.splice(0)) {
      adapter.close();
    }
  });

  it('reports active executions separately from launching slots', async () => {
    const { persistence, orchestrator } = await makeHarness(4);
    adapters.push(persistence);
    const now = new Date('2026-07-01T00:00:00.000Z');

    for (let i = 0; i < 4; i += 1) {
      loadSingleTaskWorkflow(orchestrator, persistence, `wf-${i}`, `task-${i}`);
    }
    orchestrator.startExecution();
    const claimed = claimAllLaunches(persistence, 4, now.toISOString());
    const runningRow = claimed[0]!;
    expect(orchestrator.markTaskRunningAfterLaunch(runningRow.taskId, runningRow.attemptId, now)).toBe(true);

    const status = orchestrator.getQueueStatus();
    expect(status.runningCount).toBe(4);
    expect(status.activeExecutionCount).toBe(1);
    expect(status.launchingCount).toBe(3);
    expect(status.running).toHaveLength(4);
  });

  it('abandons old launching slots by age and frees capacity for a ready root', async () => {
    const { persistence, orchestrator, dispatcher } = await makeHarness(3);
    adapters.push(persistence);
    const now = new Date('2026-07-01T00:20:00.000Z');
    const claimTime = new Date(now.getTime() - DISPATCH_LEASE_MS - 60_000);
    const oldEnqueuedAt = new Date(now.getTime() - LAUNCH_STUCK_ABANDON_MS - 1_000).toISOString();

    for (let i = 0; i < 2; i += 1) {
      loadSingleTaskWorkflow(orchestrator, persistence, `stuck-${i}`, `stuck-${i}`);
    }
    orchestrator.startExecution();
    const stuckRows = claimAllLaunches(persistence, 2, claimTime.toISOString());
    for (const row of stuckRows) {
      forceDispatchAge(persistence, row.id, {
        enqueuedAt: oldEnqueuedAt,
        fencedUntil: new Date(claimTime.getTime() + DISPATCH_LEASE_MS).toISOString(),
      });
    }

    const rootTaskId = loadSingleTaskWorkflow(orchestrator, persistence, 'ready-root', 'root');

    expect(dispatcher.abandonStuckLeases(now.toISOString())).toBe(2);
    const abandoned = persistence.listLaunchDispatchesByState(['abandoned']);
    expect(abandoned).toHaveLength(2);
    const superseded = persistence.loadAttempts(stuckRows[0]!.taskId).find((attempt) => attempt.status === 'superseded');
    expect(superseded).toBeDefined();

    const started = orchestrator.startExecution();
    expect(started.map((task) => task.id)).toContain(rootTaskId);
    const rootTask = orchestrator.getTask(rootTaskId);
    expect(rootTask?.execution.selectedAttemptId).toBeTruthy();
    const rootDispatch = persistence.loadLaunchDispatchByAttempt(rootTask!.execution.selectedAttemptId!);
    expect(rootDispatch?.state).toBe('enqueued');
  });

  it('abandons a stuck lease by age before max dispatch attempts but keeps recent leases', async () => {
    const { persistence, orchestrator, dispatcher } = await makeHarness(2);
    adapters.push(persistence);
    const now = new Date('2026-07-01T00:20:00.000Z');
    const claimTime = new Date(now.getTime() - DISPATCH_LEASE_MS - 60_000);

    loadSingleTaskWorkflow(orchestrator, persistence, 'old', 'old');
    loadSingleTaskWorkflow(orchestrator, persistence, 'recent', 'recent');
    orchestrator.startExecution();

    const claimed = claimAllLaunches(persistence, 2, claimTime.toISOString());
    const oldRow = claimed.find((row) => row.taskId.endsWith('/old'));
    const recentRow = claimed.find((row) => row.taskId.endsWith('/recent'));
    expect(oldRow).toBeDefined();
    expect(recentRow).toBeDefined();

    forceDispatchAge(persistence, oldRow!.id, {
      enqueuedAt: new Date(now.getTime() - LAUNCH_STUCK_ABANDON_MS - 1_000).toISOString(),
      fencedUntil: new Date(claimTime.getTime() + DISPATCH_LEASE_MS).toISOString(),
    });
    forceDispatchAge(persistence, recentRow!.id, {
      enqueuedAt: new Date(now.getTime() - 1_000).toISOString(),
      fencedUntil: new Date(claimTime.getTime() + DISPATCH_LEASE_MS).toISOString(),
    });

    expect(dispatcher.abandonStuckLeases(now.toISOString())).toBe(1);
    expect(persistence.loadLaunchDispatchById(oldRow!.id)?.state).toBe('abandoned');
    expect(persistence.loadLaunchDispatchById(recentRow!.id)?.state).toBe('leased');
  });

  it('gates executing-stall checks to running, fixing, and pending+launching tasks', () => {
    expect(taskNeedsExecutingStallCheck(makeTask('wf/t-running', 'wf', 'running'))).toBe(true);
    expect(taskNeedsExecutingStallCheck(makeTask('wf/t-fixing', 'wf', 'fixing_with_ai'))).toBe(true);
    expect(taskNeedsExecutingStallCheck(makeTask('wf/t-launching', 'wf', 'pending', {
      execution: { phase: 'launching' } as any,
    }))).toBe(true);
    expect(taskNeedsExecutingStallCheck(makeTask('wf/t-pending', 'wf', 'pending'))).toBe(false);
    expect(taskNeedsExecutingStallCheck(makeTask('wf/t-completed', 'wf', 'completed'))).toBe(false);
    expect(taskNeedsExecutingStallCheck(makeTask('wf/t-failed', 'wf', 'failed'))).toBe(false);
  });

  it('keeps workflow rollups and quarantine recovery aligned through a delta burst', () => {
    const cache = new TaskSnapshotCache();
    const projection = new WorkflowRollupProjection();
    const persisted = new Map<string, TaskState>([
      ['wf-1/a', makeTask('wf-1/a', 'wf-1', 'running', { taskStateVersion: 1 })],
      ['wf-2/b', makeTask('wf-2/b', 'wf-2', 'pending', { taskStateVersion: 1 })],
    ]);

    projection.replaceAll([...persisted.values()]);
    for (const task of persisted.values()) {
      cache.set(task.id, JSON.stringify(task));
    }

    const createDelta: TaskDelta = {
      type: 'created',
      task: makeTask('wf-3/c', 'wf-3', 'running', { taskStateVersion: 1 }),
    };
    persisted.set(createDelta.task.id, createDelta.task);
    const createResult = applyDelta(createDelta, cache);
    expect(createResult.accepted).toBe(true);
    const createPatches = projection.applyDelta(createDelta);
    expect(createPatches).toHaveLength(1);

    const gapDelta: TaskDelta = {
      type: 'updated',
      taskId: 'wf-2/b',
      changes: { status: 'running' },
      previousTaskStateVersion: 4,
      taskStateVersion: 5,
    };
    const gapResult = applyDelta(gapDelta, cache);
    expect(gapResult.quarantined).toEqual(['wf-2/b']);
    expect(cache.isQuarantined('wf-2/b')).toBe(true);

    const removedDelta: TaskDelta = {
      type: 'removed',
      taskId: 'wf-3/c',
      previousTaskStateVersion: 1,
    };
    persisted.delete('wf-3/c');
    const removeResult = applyDelta(removedDelta, cache);
    expect(removeResult.accepted).toBe(true);
    const removePatches = projection.applyDelta(removedDelta);
    expect(removePatches).toHaveLength(1);

    const recovery = recoverQuarantinedTask(cache, 'wf-2/b', {
      loadTask: (taskId) => persisted.get(taskId),
      getMergeNode: () => undefined,
    });
    expect(recovery.rendererDelta).toEqual({ type: 'created', task: persisted.get('wf-2/b')! });
    const recoveryPatches = projection.applyDelta(recovery.rendererDelta);
    expect(recoveryPatches).toHaveLength(1);
    expect(cache.isQuarantined('wf-2/b')).toBe(false);

    const finalTasks = [...persisted.values()];
    projection.replaceAll(finalTasks);
    const workflowIds = new Set(finalTasks.map((task) => task.config.workflowId));
    expect(workflowIds).toEqual(new Set(['wf-1', 'wf-2']));
    expect(projection.patchFor('wf-1').rollup.countsByStatus.running).toBe(1);
    expect(projection.patchFor('wf-2').rollup.countsByStatus.pending).toBe(1);
  });
});
