/**
 * Tests for orphaned running task reconciliation on resume.
 *
 * Simulates the scenario where Electron restarts while tasks are running:
 * the DB still shows 'running' but the child processes are gone.
 * On resume, orphaned running tasks should be failed so the user can restart them.
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

  it('running tasks become failed after simulated restart + reconciliation', () => {
    // Session 1: load plan and start t1
    orchestrator.loadPlan(plan);
    orchestrator.startExecution();

    const t1 = orchestrator.getTask('t1');
    expect(t1?.status).toBe('running');

    // --- Simulate app restart: create a new orchestrator from same DB ---
    const orchestrator2 = new Orchestrator({ persistence, messageBus: new InMemoryBus() });
    orchestrator2.syncAllFromDb();

    // t1 is still 'running' in the DB — orphaned
    const orphanedT1 = orchestrator2.getTask('t1');
    expect(orphanedT1?.status).toBe('running');

    // Reconcile: fail all running tasks (what main.ts resume handler does)
    for (const task of orchestrator2.getAllTasks()) {
      if (task.status === 'running') {
        orchestrator2.handleWorkerResponse({
          requestId: `orphan-${task.id}`,
          actionId: task.id,
          status: 'failed',
          outputs: { exitCode: 1, error: 'Interrupted by app restart' },
        });
      }
    }

    // t1 is now failed
    const reconciledT1 = orchestrator2.getTask('t1');
    expect(reconciledT1?.status).toBe('failed');
    expect(reconciledT1?.error).toBe('Interrupted by app restart');
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

    // Reconcile
    for (const task of orchestrator2.getAllTasks()) {
      if (task.status === 'running') {
        orchestrator2.handleWorkerResponse({
          requestId: `orphan-${task.id}`,
          actionId: task.id,
          status: 'failed',
          outputs: { exitCode: 1, error: 'Interrupted by app restart' },
        });
      }
    }

    // t1 stays completed, t2 is now failed
    expect(orchestrator2.getTask('t1')?.status).toBe('completed');
    expect(orchestrator2.getTask('t2')?.status).toBe('failed');
  });

  it('reconciled tasks can be restarted and re-executed', () => {
    orchestrator.loadPlan(plan);
    orchestrator.startExecution();

    // --- Simulate restart ---
    const orchestrator2 = new Orchestrator({ persistence, messageBus: new InMemoryBus() });
    orchestrator2.syncAllFromDb();

    // Reconcile t1
    for (const task of orchestrator2.getAllTasks()) {
      if (task.status === 'running') {
        orchestrator2.handleWorkerResponse({
          requestId: `orphan-${task.id}`,
          actionId: task.id,
          status: 'failed',
          outputs: { exitCode: 1, error: 'Interrupted by app restart' },
        });
      }
    }
    expect(orchestrator2.getTask('t1')?.status).toBe('failed');

    // Restart t1 → goes back to pending/running
    const restarted = orchestrator2.restartTask('t1');
    expect(restarted.length).toBeGreaterThan(0);
    expect(orchestrator2.getTask('t1')?.status).toBe('running');
  });

  it('dependents of orphaned tasks are blocked', () => {
    orchestrator.loadPlan(plan);
    orchestrator.startExecution();

    // t1 is running, t2 is pending (waiting on t1)
    expect(orchestrator.getTask('t1')?.status).toBe('running');
    expect(orchestrator.getTask('t2')?.status).toBe('pending');

    // --- Simulate restart ---
    const orchestrator2 = new Orchestrator({ persistence, messageBus: new InMemoryBus() });
    orchestrator2.syncAllFromDb();

    // Reconcile
    for (const task of orchestrator2.getAllTasks()) {
      if (task.status === 'running') {
        orchestrator2.handleWorkerResponse({
          requestId: `orphan-${task.id}`,
          actionId: task.id,
          status: 'failed',
          outputs: { exitCode: 1, error: 'Interrupted by app restart' },
        });
      }
    }

    // t2 should be blocked because t1 failed
    expect(orchestrator2.getTask('t1')?.status).toBe('failed');
    expect(orchestrator2.getTask('t2')?.status).toBe('blocked');
  });

  it('startExecution after reconciliation only starts ready pending tasks', () => {
    orchestrator.loadPlan(plan);
    orchestrator.startExecution();

    // Complete t1, t2 starts running
    orchestrator.handleWorkerResponse(
      makeResponse({ actionId: 't1', status: 'completed', outputs: { exitCode: 0 } }),
    );

    // --- Simulate restart (t2 is running, merge node is pending) ---
    const orchestrator2 = new Orchestrator({ persistence, messageBus: new InMemoryBus() });
    orchestrator2.syncAllFromDb();

    // Reconcile running tasks
    for (const task of orchestrator2.getAllTasks()) {
      if (task.status === 'running') {
        orchestrator2.handleWorkerResponse({
          requestId: `orphan-${task.id}`,
          actionId: task.id,
          status: 'failed',
          outputs: { exitCode: 1, error: 'Interrupted by app restart' },
        });
      }
    }

    // startExecution should not start anything new (t2 failed, merge blocked)
    const started = orchestrator2.startExecution();
    expect(started.length).toBe(0);
  });
});
