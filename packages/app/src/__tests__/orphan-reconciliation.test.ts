/**
 * Tests for task reconciliation on app resume/restart.
 *
 * Covers two scenarios:
 * 1. Orphaned running tasks: DB shows 'running' but child processes are gone.
 *    These should be reset to pending and relaunched.
 * 2. Pending-but-ready tasks: tasks whose dependencies are satisfied but were
 *    never started (e.g. app crashed before startExecution). These should be
 *    picked up and started on resume.
 */

import { describe, it, expect, beforeEach } from 'vitest';

import {
  Orchestrator,
  type PlanDefinition,
  type TaskState,
  type OrchestratorMessageBus,
} from '@invoker/workflow-core';
import type { WorkResponse } from '@invoker/contracts';
import { InMemoryPersistence } from '@invoker/test-kit';

class InMemoryBus implements OrchestratorMessageBus {
  publish(): void {}
}

/** Match plan-local id against workflow-scoped runtime ids. */
function idEndsWithLocal(id: string, local: string): boolean {
  return id === local || id.endsWith(`/${local}`);
}

function makeResponse(overrides: Partial<WorkResponse>): WorkResponse {
  return {
    requestId: 'req-1',
    actionId: 't1',
    status: 'completed',
    outputs: { exitCode: 0 },
    ...overrides,
  };
}

/**
 * Simulate the relaunchOrphansAndStartReady() helper that main.ts
 * performs on startup: restart orphaned running tasks, then start any
 * pending-but-ready tasks via startExecution().
 */
function relaunchOrphansAndStartReady(orch: Orchestrator): TaskState[] {
  const orphanRestarted: TaskState[] = [];
  for (const task of orch.getAllTasks()) {
    if (task.status === 'running') {
      const started = orch.restartTask(task.id);
      orphanRestarted.push(...started.filter(t => t.status === 'running'));
    }
  }
  const readyStarted = orch.startExecution();
  return [...orphanRestarted, ...readyStarted];
}

// ── Tests ───────────────────────────────────────────────────

describe('orphan reconciliation on resume', () => {
  let persistence: InMemoryPersistence;
  let orchestrator: Orchestrator;

  const plan: PlanDefinition = {
    name: 'Resume Test',
    onFinish: 'merge',
    baseBranch: 'main',
    featureBranch: 'feat/test',
    tasks: [
      { id: 't1', description: 'First', command: 'echo 1' },
      { id: 't2', description: 'Second', command: 'echo 2', dependencies: ['t1'] },
    ],
  };

  beforeEach(() => {
    persistence = new InMemoryPersistence();
    orchestrator = new Orchestrator({ persistence, messageBus: new InMemoryBus() });
  });

  it('orphaned running tasks are relaunched after simulated restart', () => {
    orchestrator.loadPlan(plan);
    orchestrator.startExecution();

    const t1 = orchestrator.getTask('t1');
    expect(t1?.status).toBe('running');

    // --- Simulate app restart: create a new orchestrator from same DB ---
    const orchestrator2 = new Orchestrator({ persistence, messageBus: new InMemoryBus() });
    orchestrator2.syncAllFromDb();

    // t1 is still 'running' in the DB — orphaned
    expect(orchestrator2.getTask('t1')?.status).toBe('running');

    // Reconcile: restartTask resets to pending, then auto-starts (deps met)
    const restarted = relaunchOrphansAndStartReady(orchestrator2);

    expect(restarted.length).toBe(1);
    expect(idEndsWithLocal(restarted[0].id, 't1')).toBe(true);
    expect(orchestrator2.getTask('t1')?.status).toBe('running');
    // Error and previous state should be cleared
    expect(orchestrator2.getTask('t1')?.execution?.error).toBeUndefined();
    expect(orchestrator2.getTask('t1')?.execution?.exitCode).toBeUndefined();
  });

  it('pending and completed tasks are not affected by reconciliation', () => {
    orchestrator.loadPlan(plan);
    orchestrator.startExecution();

    // Complete t1 → t2 starts running
    orchestrator.handleWorkerResponse(
      makeResponse({ actionId: 't1', status: 'completed', outputs: { exitCode: 0 } }),
    );

    expect(orchestrator.getTask('t1')?.status).toBe('completed');
    expect(orchestrator.getTask('t2')?.status).toBe('running');

    // --- Simulate restart ---
    const orchestrator2 = new Orchestrator({ persistence, messageBus: new InMemoryBus() });
    orchestrator2.syncAllFromDb();

    const restarted = relaunchOrphansAndStartReady(orchestrator2);

    // t2 was orphaned running → relaunched; t1 stays completed
    expect(orchestrator2.getTask('t1')?.status).toBe('completed');
    expect(orchestrator2.getTask('t2')?.status).toBe('running');
    expect(restarted.length).toBe(1);
    expect(idEndsWithLocal(restarted[0].id, 't2')).toBe(true);
  });

  it('relaunched tasks can complete the full lifecycle', () => {
    orchestrator.loadPlan(plan);
    orchestrator.startExecution();

    // --- Simulate restart ---
    const orchestrator2 = new Orchestrator({ persistence, messageBus: new InMemoryBus() });
    orchestrator2.syncAllFromDb();

    // Reconcile t1 → relaunched
    const restarted = relaunchOrphansAndStartReady(orchestrator2);
    expect(restarted.length).toBe(1);
    expect(orchestrator2.getTask('t1')?.status).toBe('running');

    // Complete t1 → t2 becomes ready and starts
    orchestrator2.handleWorkerResponse(
      makeResponse({ actionId: 't1', status: 'completed', outputs: { exitCode: 0 } }),
    );
    expect(orchestrator2.getTask('t1')?.status).toBe('completed');
    expect(orchestrator2.getTask('t2')?.status).toBe('running');

    // Complete t2
    orchestrator2.handleWorkerResponse(
      makeResponse({ actionId: 't2', status: 'completed', outputs: { exitCode: 0 } }),
    );
    expect(orchestrator2.getTask('t2')?.status).toBe('completed');
  });

  it('dependents of orphaned tasks stay pending (not blocked)', () => {
    orchestrator.loadPlan(plan);
    orchestrator.startExecution();

    // t1 is running, t2 is pending (waiting on t1)
    expect(orchestrator.getTask('t1')?.status).toBe('running');
    expect(orchestrator.getTask('t2')?.status).toBe('pending');

    // --- Simulate restart ---
    const orchestrator2 = new Orchestrator({ persistence, messageBus: new InMemoryBus() });
    orchestrator2.syncAllFromDb();

    // Reconcile — t1 is relaunched, t2 stays pending
    relaunchOrphansAndStartReady(orchestrator2);

    expect(orchestrator2.getTask('t1')?.status).toBe('running');
    expect(orchestrator2.getTask('t2')?.status).toBe('pending');
  });

  it('pending-but-ready tasks across multiple workflows are started on resume', () => {
    const planA: PlanDefinition = {
      name: 'Workflow A',
      onFinish: 'none',
      tasks: [
        { id: 'a1', description: 'Task A1', command: 'echo a1' },
        { id: 'a2', description: 'Task A2', command: 'echo a2', dependencies: ['a1'] },
      ],
    };
    orchestrator.loadPlan(planA);
    orchestrator.startExecution();
    expect(orchestrator.getTask('a1')?.status).toBe('running');

    const planB: PlanDefinition = {
      name: 'Workflow B',
      onFinish: 'none',
      tasks: [
        { id: 'b1', description: 'Task B1', command: 'echo b1' },
        { id: 'b2', description: 'Task B2', command: 'echo b2', dependencies: ['b1'] },
      ],
    };
    orchestrator.loadPlan(planB);
    orchestrator.startExecution();
    expect(orchestrator.getTask('b1')?.status).toBe('running');

    const orchestrator2 = new Orchestrator({
      persistence,
      messageBus: new InMemoryBus(),
      maxConcurrency: 10,
    });
    orchestrator2.syncAllFromDb();

    expect(orchestrator2.getTask('a1')?.status).toBe('running');
    expect(orchestrator2.getTask('b1')?.status).toBe('running');

    const started = relaunchOrphansAndStartReady(orchestrator2);
    const startedIds = started.map(t => t.id).sort();

    expect(startedIds.some((id) => idEndsWithLocal(id, 'a1'))).toBe(true);
    expect(startedIds.some((id) => idEndsWithLocal(id, 'b1'))).toBe(true);
    expect(orchestrator2.getTask('a1')?.status).toBe('running');
    expect(orchestrator2.getTask('b1')?.status).toBe('running');
    expect(orchestrator2.getTask('a2')?.status).toBe('pending');
    expect(orchestrator2.getTask('b2')?.status).toBe('pending');
  });

  it('pending root tasks from other workflows are started even with no orphans', () => {
    const planA: PlanDefinition = {
      name: 'Completed Workflow',
      onFinish: 'none',
      tasks: [
        { id: 'done1', description: 'Already done', command: 'echo done' },
      ],
    };
    orchestrator.loadPlan(planA);
    orchestrator.startExecution();
    orchestrator.handleWorkerResponse(
      makeResponse({ actionId: 'done1', status: 'completed', outputs: { exitCode: 0 } }),
    );
    expect(orchestrator.getTask('done1')?.status).toBe('completed');

    const planB: PlanDefinition = {
      name: 'Never Started Workflow',
      onFinish: 'none',
      tasks: [
        { id: 'fresh1', description: 'Fresh root task', command: 'echo fresh' },
        { id: 'fresh2', description: 'Depends on fresh1', command: 'echo fresh2', dependencies: ['fresh1'] },
      ],
    };
    orchestrator.loadPlan(planB);

    expect(orchestrator.getTask('fresh1')?.status).toBe('pending');

    const orchestrator2 = new Orchestrator({
      persistence,
      messageBus: new InMemoryBus(),
      maxConcurrency: 10,
    });
    orchestrator2.syncAllFromDb();

    const started = relaunchOrphansAndStartReady(orchestrator2);
    const startedIds = started.map(t => t.id);

    expect(startedIds.some((id) => idEndsWithLocal(id, 'fresh1'))).toBe(true);
    expect(orchestrator2.getTask('fresh1')?.status).toBe('running');
    expect(orchestrator2.getTask('fresh2')?.status).toBe('pending');
  });

  it('pending tasks with completed deps across workflows are started on resume', () => {
    orchestrator.loadPlan(plan);
    orchestrator.startExecution();

    orchestrator.handleWorkerResponse(
      makeResponse({ actionId: 't1', status: 'completed', outputs: { exitCode: 0 } }),
    );
    expect(orchestrator.getTask('t2')?.status).toBe('running');

    const planB: PlanDefinition = {
      name: 'Ready Workflow',
      onFinish: 'none',
      tasks: [
        { id: 'r1', description: 'Root', command: 'echo r1' },
      ],
    };
    orchestrator.loadPlan(planB);

    const orchestrator2 = new Orchestrator({
      persistence,
      messageBus: new InMemoryBus(),
      maxConcurrency: 10,
    });
    orchestrator2.syncAllFromDb();

    const started = relaunchOrphansAndStartReady(orchestrator2);
    const startedIds = started.map(t => t.id).sort();

    expect(startedIds.some((id) => idEndsWithLocal(id, 't2'))).toBe(true);
    expect(startedIds.some((id) => idEndsWithLocal(id, 'r1'))).toBe(true);
    expect(orchestrator2.getTask('t2')?.status).toBe('running');
    expect(orchestrator2.getTask('r1')?.status).toBe('running');
  });

  it('extra startExecution after relaunch does not double-start tasks', () => {
    orchestrator.loadPlan(plan);
    orchestrator.startExecution();

    orchestrator.handleWorkerResponse(
      makeResponse({ actionId: 't1', status: 'completed', outputs: { exitCode: 0 } }),
    );

    const orchestrator2 = new Orchestrator({ persistence, messageBus: new InMemoryBus() });
    orchestrator2.syncAllFromDb();

    const restarted = relaunchOrphansAndStartReady(orchestrator2);
    expect(restarted.length).toBe(1);
    expect(idEndsWithLocal(restarted[0].id, 't2')).toBe(true);

    const started = orchestrator2.startExecution();
    const startedIds = started.map(t => t.id);
    expect(startedIds.some((id) => idEndsWithLocal(id, 't2'))).toBe(false);
  });

  // ── disableAutoRunOnStartup guard tests ─────────────────────

  it('orphaned running tasks are NOT relaunched when disableAutoRunOnStartup is true', () => {
    orchestrator.loadPlan(plan);
    orchestrator.startExecution();
    expect(orchestrator.getTask('t1')?.status).toBe('running');

    // --- Simulate app restart with disableAutoRunOnStartup ---
    const orchestrator2 = new Orchestrator({ persistence, messageBus: new InMemoryBus() });
    orchestrator2.syncAllFromDb();

    // t1 is in DB as 'running' — orphaned
    expect(orchestrator2.getTask('t1')?.status).toBe('running');

    // Simulate the disableAutoRunOnStartup guard (main.ts line 944):
    // relaunchOrphansAndStartReady is NOT called.
    // Only startExecution runs, which won't pick up already-running tasks.
    const readyOnly = orchestrator2.startExecution();
    expect(readyOnly).toEqual([]); // t1 is already 'running', t2 is blocked
    // t1 stays in its orphaned 'running' state — no restart occurred
    expect(orchestrator2.getTask('t1')?.status).toBe('running');
    expect(orchestrator2.getTask('t2')?.status).toBe('pending');
  });

  it('after resume-workflow, orphaned tasks CAN be restarted', () => {
    orchestrator.loadPlan(plan);
    orchestrator.startExecution();

    const orchestrator2 = new Orchestrator({ persistence, messageBus: new InMemoryBus() });
    orchestrator2.syncAllFromDb();

    // Simulate resume-workflow IPC calling relaunchOrphansAndStartReady,
    // which restarts orphaned running tasks and starts ready pending tasks.
    const allStarted = relaunchOrphansAndStartReady(orchestrator2);
    expect(allStarted.length).toBe(1);
    expect(idEndsWithLocal(allStarted[0].id, 't1')).toBe(true);
  });
});
