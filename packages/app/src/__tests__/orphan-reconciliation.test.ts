/**
 * Tests for orphaned running task reconciliation on resume.
 *
 * Simulates the scenario where Electron restarts while tasks are running:
 * the DB still shows 'running' but the child processes are gone.
 * On resume, orphaned running tasks should be reset to pending and relaunched.
 */

import { describe, it, expect, beforeEach } from 'vitest';

import {
  Orchestrator,
  type PlanDefinition,
  type TaskState,
  type OrchestratorPersistence,
  type OrchestratorMessageBus,
} from '@invoker/core';
import type { WorkResponse } from '@invoker/protocol';

// ── Lightweight in-memory mocks ─────────────────────────────

class InMemoryPersistence implements OrchestratorPersistence {
  workflows = new Map<string, { id: string; name: string; status: string; createdAt: string; updatedAt: string }>();
  tasks = new Map<string, { workflowId: string; task: TaskState }>();

  saveWorkflow(workflow: { id: string; name: string; status: string }): void {
    const now = new Date().toISOString();
    this.workflows.set(workflow.id, { ...workflow, createdAt: (workflow as any).createdAt ?? now, updatedAt: (workflow as any).updatedAt ?? now });
  }
  updateWorkflow(workflowId: string, changes: { status?: string }): void {
    const wf = this.workflows.get(workflowId);
    if (wf && changes.status) wf.status = changes.status;
  }
  saveTask(workflowId: string, task: TaskState): void {
    this.tasks.set(task.id, { workflowId, task });
  }
  updateTask(taskId: string, changes: Partial<TaskState>): void {
    const entry = this.tasks.get(taskId);
    if (entry) entry.task = { ...entry.task, ...changes } as TaskState;
  }
  listWorkflows(): Array<{ id: string; name: string; status: string; createdAt: string; updatedAt: string }> {
    return Array.from(this.workflows.values());
  }
  loadTasks(workflowId: string): TaskState[] {
    return Array.from(this.tasks.values())
      .filter((e) => e.workflowId === workflowId)
      .map((e) => e.task);
  }
  logEvent(): void {}
}

class InMemoryBus implements OrchestratorMessageBus {
  publish(): void {}
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
 * Simulate the orphan reconciliation that main.ts performs on restart:
 * find all running tasks and call restartTask() to reset and relaunch them.
 */
function reconcileOrphans(orch: Orchestrator): TaskState[] {
  const restarted: TaskState[] = [];
  for (const task of orch.getAllTasks()) {
    if (task.status === 'running') {
      const started = orch.restartTask(task.id);
      restarted.push(...started.filter(t => t.status === 'running'));
    }
  }
  return restarted;
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
    const restarted = reconcileOrphans(orchestrator2);

    expect(restarted.length).toBe(1);
    expect(restarted[0].id).toBe('t1');
    expect(orchestrator2.getTask('t1')?.status).toBe('running');
    // Error and previous state should be cleared
    expect(orchestrator2.getTask('t1')?.error).toBeUndefined();
    expect(orchestrator2.getTask('t1')?.exitCode).toBeUndefined();
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

    const restarted = reconcileOrphans(orchestrator2);

    // t2 was orphaned running → relaunched; t1 stays completed
    expect(orchestrator2.getTask('t1')?.status).toBe('completed');
    expect(orchestrator2.getTask('t2')?.status).toBe('running');
    expect(restarted.length).toBe(1);
    expect(restarted[0].id).toBe('t2');
  });

  it('relaunched tasks can complete the full lifecycle', () => {
    orchestrator.loadPlan(plan);
    orchestrator.startExecution();

    // --- Simulate restart ---
    const orchestrator2 = new Orchestrator({ persistence, messageBus: new InMemoryBus() });
    orchestrator2.syncAllFromDb();

    // Reconcile t1 → relaunched
    const restarted = reconcileOrphans(orchestrator2);
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
    reconcileOrphans(orchestrator2);

    expect(orchestrator2.getTask('t1')?.status).toBe('running');
    expect(orchestrator2.getTask('t2')?.status).toBe('pending');
  });

  it('startExecution after reconciliation does not double-start relaunched tasks', () => {
    orchestrator.loadPlan(plan);
    orchestrator.startExecution();

    // Complete t1, t2 starts running
    orchestrator.handleWorkerResponse(
      makeResponse({ actionId: 't1', status: 'completed', outputs: { exitCode: 0 } }),
    );

    // --- Simulate restart (t2 is running, merge node may be pending) ---
    const orchestrator2 = new Orchestrator({ persistence, messageBus: new InMemoryBus() });
    orchestrator2.syncAllFromDb();

    // Reconcile: t2 gets relaunched
    const restarted = reconcileOrphans(orchestrator2);
    expect(restarted.length).toBe(1);
    expect(restarted[0].id).toBe('t2');

    // startExecution should not return t2 again (already running)
    const started = orchestrator2.startExecution();
    const startedIds = started.map(t => t.id);
    expect(startedIds).not.toContain('t2');
  });
});
