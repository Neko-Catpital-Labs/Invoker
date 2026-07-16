import { afterEach, describe, expect, it, vi } from 'vitest';
import { SQLiteAdapter } from '@invoker/data-store';
import { InMemoryBus } from '@invoker/test-kit';
import { Orchestrator, type PlanDefinition } from '@invoker/workflow-core';
import { LaunchDispatcher } from '../launch-dispatcher.js';

/**
 * Live-shaped scale (snapshot of ~/.invoker/invoker.db):
 *   ~51 workflows, ~162 tasks, avg ~3.2 tasks/wf, longest ~9.
 * Scheduler/pool under test: expectedCap=13.
 */
const EXPECTED_CAP = 13;
const WORKFLOW_COUNT = 51;
const TARGET_TASK_COUNT = 162;

function chainPlan(name: string, depth: number): PlanDefinition {
  const tasks: PlanDefinition['tasks'] = [];
  for (let i = 0; i < depth; i += 1) {
    tasks.push({
      id: `t${i}`,
      description: `${name}/t${i}`,
      command: 'sleep 3600',
      ...(i > 0 ? { dependencies: [`t${i - 1}`] } : {}),
    });
  }
  return { name, tasks };
}

/** Distribute ~162 tasks across 51 workflows like the live DB (many 3s, some longer). */
function liveShapedWorkflowDepths(): number[] {
  const depths: number[] = [];
  // One long workflow (~9) like the live top
  depths.push(9);
  // Several 5s and 4s
  for (let i = 0; i < 4; i += 1) depths.push(5);
  for (let i = 0; i < 6; i += 1) depths.push(4);
  // Fill remaining with 3-task chains (dominant live pattern)
  while (depths.length < WORKFLOW_COUNT) depths.push(3);
  // Trim/pad to hit target task count without exploding workflow count.
  let total = depths.reduce((a, b) => a + b, 0);
  let idx = depths.length - 1;
  while (total > TARGET_TASK_COUNT && idx >= 0) {
    if (depths[idx]! > 2) {
      depths[idx]! -= 1;
      total -= 1;
    } else {
      idx -= 1;
    }
  }
  while (total < TARGET_TASK_COUNT) {
    depths[total % depths.length]! += 1;
    total += 1;
  }
  return depths.slice(0, WORKFLOW_COUNT);
}

function makeDispatcher(orchestrator: Orchestrator, persistence: SQLiteAdapter) {
  return new LaunchDispatcher({
    persistence,
    orchestrator: {
      prepareTaskForNewAttempt: (taskId, reason) =>
        orchestrator.prepareTaskForNewAttempt(taskId, reason),
      getTask: (taskId) => orchestrator.getTask(taskId),
      getTaskLaunchReadiness: (taskId) => orchestrator.getTaskLaunchReadiness(taskId),
      getExecutableReadyTasks: () => orchestrator.getExecutableReadyTasks(),
      getQueueStatus: () => orchestrator.getQueueStatus({ refresh: false }),
      isLaunchParked: (taskId, now) => orchestrator.isLaunchParked(taskId, now),
      startExecution: () => orchestrator.startExecution(),
    },
    ownerId: 'capacity-fill-owner',
    maxLeasesPerPoll: EXPECTED_CAP,
    taskRunnerProvider: () => ({
      executeTask: vi.fn().mockResolvedValue(undefined),
    }),
  });
}

function countReadyRoots(orchestrator: Orchestrator): number {
  return orchestrator.getExecutableReadyTasks().filter((task) => task.status === 'pending').length;
}

function workflowIds(orchestrator: Orchestrator): string[] {
  const ids = new Set<string>();
  for (const task of orchestrator.getAllTasks()) {
    if (task.config.workflowId) ids.add(task.config.workflowId);
  }
  return [...ids].sort();
}

describe('runner capacity fill guarantee', () => {
  const adapters: SQLiteAdapter[] = [];

  afterEach(() => {
    for (const adapter of adapters.splice(0)) {
      adapter.close();
    }
  });

  it('fills all 13 slots under a live-shaped ~51-workflow / ~162-task graph after churn', async () => {
    // Live-scale graph + recreate/cancel churn is intentionally heavy.
    const persistence = await SQLiteAdapter.create(':memory:');
    adapters.push(persistence);
    const orchestrator = new Orchestrator({
      persistence: persistence as any,
      messageBus: new InMemoryBus(),
      maxConcurrency: EXPECTED_CAP,
      deferRunningUntilLaunch: true,
    });
    const dispatcher = makeDispatcher(orchestrator, persistence);

    const depths = liveShapedWorkflowDepths();
    expect(depths.length).toBe(WORKFLOW_COUNT);
    const plannedTasks = depths.reduce((a, b) => a + b, 0);
    expect(plannedTasks).toBeGreaterThanOrEqual(150);
    expect(plannedTasks).toBeLessThanOrEqual(180);

    for (let i = 0; i < depths.length; i += 1) {
      orchestrator.loadPlan(chainPlan(`live-wf-${i}`, depths[i]!));
    }

    const allTasks = orchestrator.getAllTasks().filter((task) => !task.config.isMergeNode);
    expect(workflowIds(orchestrator).length).toBeGreaterThanOrEqual(WORKFLOW_COUNT);
    expect(allTasks.length).toBeGreaterThanOrEqual(150);

    // Enough independent roots to saturate 13 slots (each chain contributes one root).
    expect(countReadyRoots(orchestrator)).toBeGreaterThanOrEqual(EXPECTED_CAP);

    dispatcher.poll();
    let status = orchestrator.getQueueStatus({ refresh: true });
    expect(status.runningCount).toBe(EXPECTED_CAP);

    // Adverse churn matching operator habits: recreate many workflows, cancel some,
    // delete a few, then top up again.
    const ids = workflowIds(orchestrator);
    for (const workflowId of ids.slice(0, 20)) {
      orchestrator.recreateWorkflow(workflowId);
    }
    for (const workflowId of ids.slice(20, 28)) {
      orchestrator.cancelWorkflow(workflowId);
    }

    // Plant expired orphan leases like a restart left behind.
    for (let i = 0; i < 8; i += 1) {
      expect(persistence.claimExecutionResourceLease({
        resourceKey: `ssh:orphan-expired-${i}`,
        resourceType: 'ssh',
        holderId: `dead-holder-${i}`,
        leaseMs: -1,
      })).toBe(true);
    }

    dispatcher.poll();
    status = orchestrator.getQueueStatus({ refresh: true });

    const ready = countReadyRoots(orchestrator);
    if (ready >= EXPECTED_CAP) {
      expect(status.runningCount).toBe(EXPECTED_CAP);
    } else {
      // After heavy cancel, fewer roots may remain — still must use every free slot.
      expect(status.runningCount).toBe(ready);
    }
    expect(
      persistence.listExecutionResourceLeases().filter((lease) => lease.resourceKey.includes('orphan-expired')),
    ).toHaveLength(0);

    // Second wave: load more independent single-root workflows and demand full fill.
    for (let i = 0; i < EXPECTED_CAP; i += 1) {
      orchestrator.loadPlan(chainPlan(`topup-wf-${i}`, 1));
    }
    dispatcher.poll();
    status = orchestrator.getQueueStatus({ refresh: true });
    expect(status.runningCount).toBe(EXPECTED_CAP);
    expect(status.maxConcurrency).toBe(EXPECTED_CAP);
  }, 120_000);

  it('keeps fillable slots saturated across repeated recreate storms at live scale', async () => {
    const persistence = await SQLiteAdapter.create(':memory:');
    adapters.push(persistence);
    const orchestrator = new Orchestrator({
      persistence: persistence as any,
      messageBus: new InMemoryBus(),
      maxConcurrency: EXPECTED_CAP,
      deferRunningUntilLaunch: true,
    });
    const dispatcher = makeDispatcher(orchestrator, persistence);

    // Full live workflow count, shorter chains so recreate storm stays in budget.
    for (let i = 0; i < WORKFLOW_COUNT; i += 1) {
      orchestrator.loadPlan(chainPlan(`storm-wf-${i}`, 3));
    }

    for (let round = 0; round < 3; round += 1) {
      dispatcher.poll();
      const status = orchestrator.getQueueStatus({ refresh: true });
      const ready = countReadyRoots(orchestrator);
      expect(status.runningCount).toBe(Math.min(EXPECTED_CAP, ready));

      const ids = workflowIds(orchestrator);
      for (const workflowId of ids.slice(round * 8, round * 8 + 8)) {
        orchestrator.recreateWorkflow(workflowId);
      }
    }

    dispatcher.poll();
    const finalStatus = orchestrator.getQueueStatus({ refresh: true });
    const finalReady = countReadyRoots(orchestrator);
    expect(finalStatus.runningCount).toBe(Math.min(EXPECTED_CAP, finalReady));
  }, 120_000);
});
