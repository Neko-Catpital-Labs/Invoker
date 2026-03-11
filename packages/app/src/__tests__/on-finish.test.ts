/**
 * Tests for shouldRunOnFinish and onFinish integration.
 *
 * Unit tests: pure function shouldRunOnFinish
 * Integration test: orchestrator completes all tasks → shouldRunOnFinish returns true
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import { shouldRunOnFinish } from '../workflow-finish.js';
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
  subscribe(): () => void {
    return () => {};
  }
}

// ── Helpers ─────────────────────────────────────────────────

function makeResponse(overrides: Partial<WorkResponse>): WorkResponse {
  return {
    requestId: 'req-1',
    actionId: 't1',
    status: 'completed',
    outputs: { exitCode: 0 },
    ...overrides,
  };
}

const allCompleted = { running: 0, pending: 0, failed: 0, total: 3 };
const mergePlan: PlanDefinition = {
  name: 'Test',
  onFinish: 'merge',
  baseBranch: 'main',
  featureBranch: 'feat/test',
  tasks: [],
};

// ── Unit Tests ──────────────────────────────────────────────

describe('shouldRunOnFinish', () => {
  it('returns false when plan is null', () => {
    expect(shouldRunOnFinish(allCompleted, null)).toBe(false);
  });

  it('returns false when total is 0', () => {
    expect(shouldRunOnFinish({ ...allCompleted, total: 0 }, mergePlan)).toBe(false);
  });

  it('returns false when tasks still running', () => {
    expect(shouldRunOnFinish({ ...allCompleted, running: 1 }, mergePlan)).toBe(false);
  });

  it('returns false when tasks still pending', () => {
    expect(shouldRunOnFinish({ ...allCompleted, pending: 2 }, mergePlan)).toBe(false);
  });

  it('returns false when tasks failed', () => {
    expect(shouldRunOnFinish({ ...allCompleted, failed: 1 }, mergePlan)).toBe(false);
  });

  it('returns false when onFinish is none', () => {
    const plan = { ...mergePlan, onFinish: 'none' as const };
    expect(shouldRunOnFinish(allCompleted, plan)).toBe(false);
  });

  it('returns false when onFinish is undefined', () => {
    const plan = { ...mergePlan, onFinish: undefined };
    expect(shouldRunOnFinish(allCompleted, plan)).toBe(false);
  });

  it('returns true when all completed and onFinish is merge', () => {
    expect(shouldRunOnFinish(allCompleted, mergePlan)).toBe(true);
  });

  it('returns true when all completed and onFinish is pull_request', () => {
    const plan = { ...mergePlan, onFinish: 'pull_request' as const };
    expect(shouldRunOnFinish(allCompleted, plan)).toBe(true);
  });
});

// ── Integration Test ────────────────────────────────────────

describe('onFinish integration', () => {
  let orchestrator: Orchestrator;

  beforeEach(() => {
    const persistence = new InMemoryPersistence();
    const bus = new InMemoryBus();
    orchestrator = new Orchestrator({ persistence, messageBus: bus });
  });

  it('shouldRunOnFinish returns true only after merge node completes', () => {
    const plan: PlanDefinition = {
      name: 'Finish Test',
      onFinish: 'merge',
      baseBranch: 'main',
      featureBranch: 'feat/test',
      tasks: [
        { id: 't1', description: 'First', command: 'echo 1' },
        { id: 't2', description: 'Second', command: 'echo 2' },
      ],
    };

    orchestrator.loadPlan(plan);
    orchestrator.startExecution();

    // Complete t1
    orchestrator.handleWorkerResponse(
      makeResponse({ actionId: 't1', status: 'completed', outputs: { exitCode: 0 } }),
    );

    let status = orchestrator.getWorkflowStatus();
    expect(shouldRunOnFinish(status, plan)).toBe(false);

    // Complete t2 — merge node auto-starts
    orchestrator.handleWorkerResponse(
      makeResponse({ actionId: 't2', status: 'completed', outputs: { exitCode: 0 } }),
    );

    // Merge node is running — not settled yet
    const mergeNode = orchestrator.getAllTasks().find(t => t.isMergeNode);
    expect(mergeNode).toBeDefined();
    expect(mergeNode!.status).toBe('running');
    status = orchestrator.getWorkflowStatus();
    expect(shouldRunOnFinish(status, plan)).toBe(false);

    // Complete merge node
    orchestrator.handleWorkerResponse(
      makeResponse({ actionId: mergeNode!.id, status: 'completed', outputs: { exitCode: 0 } }),
    );

    status = orchestrator.getWorkflowStatus();
    expect(shouldRunOnFinish(status, plan)).toBe(true);
  });

  it('shouldRunOnFinish returns false when a task fails', () => {
    const plan: PlanDefinition = {
      name: 'Fail Test',
      onFinish: 'merge',
      baseBranch: 'main',
      featureBranch: 'feat/test',
      tasks: [
        { id: 't1', description: 'First', command: 'echo 1' },
        { id: 't2', description: 'Second', command: 'echo 2' },
      ],
    };

    orchestrator.loadPlan(plan);
    orchestrator.startExecution();

    orchestrator.handleWorkerResponse(
      makeResponse({ actionId: 't1', status: 'completed', outputs: { exitCode: 0 } }),
    );
    orchestrator.handleWorkerResponse(
      makeResponse({ actionId: 't2', status: 'failed', outputs: { exitCode: 1, error: 'broke' } }),
    );

    // Merge node is blocked because t2 failed
    const status = orchestrator.getWorkflowStatus();
    expect(status.failed).toBeGreaterThan(0);
    expect(shouldRunOnFinish(status, plan)).toBe(false);
  });

  it('proves Slack bug: same status returns false with null plan, true with plan', () => {
    const plan: PlanDefinition = {
      name: 'Slack Plan',
      onFinish: 'merge',
      baseBranch: 'main',
      featureBranch: 'feat/x',
      tasks: [{ id: 't1', description: 'Task', command: 'echo 1' }],
    };

    orchestrator.loadPlan(plan);
    orchestrator.startExecution();
    orchestrator.handleWorkerResponse(
      makeResponse({ actionId: 't1', status: 'completed', outputs: { exitCode: 0 } }),
    );

    // Complete the merge node that was auto-started after t1
    const mergeNode = orchestrator.getAllTasks().find(t => t.isMergeNode);
    orchestrator.handleWorkerResponse(
      makeResponse({ actionId: mergeNode!.id, status: 'completed', outputs: { exitCode: 0 } }),
    );

    const status = orchestrator.getWorkflowStatus();
    expect(shouldRunOnFinish(status, plan)).toBe(true);
    expect(shouldRunOnFinish(status, null)).toBe(false);
  });

  it('per-workflow merge gate: only triggers for completed workflow', () => {
    const planA: PlanDefinition = {
      name: 'Workflow A',
      onFinish: 'merge',
      baseBranch: 'main',
      featureBranch: 'feat/a',
      tasks: [{ id: 'a1', description: 'A Task', command: 'echo a' }],
    };
    const planB: PlanDefinition = {
      name: 'Workflow B',
      onFinish: 'pull_request',
      baseBranch: 'main',
      featureBranch: 'feat/b',
      tasks: [{ id: 'b1', description: 'B Task', command: 'echo b' }],
    };

    orchestrator.loadPlan(planA);
    orchestrator.loadPlan(planB);
    orchestrator.startExecution();

    // Complete a1 — its merge node auto-starts
    orchestrator.handleWorkerResponse(
      makeResponse({ actionId: 'a1', status: 'completed', outputs: { exitCode: 0 } }),
    );

    // Complete workflow A's merge node
    const mergeA = orchestrator.getAllTasks().find(t =>
      t.isMergeNode && t.workflowId === orchestrator.getWorkflowIds()[0] && t.status === 'running',
    );
    orchestrator.handleWorkerResponse(
      makeResponse({ actionId: mergeA!.id, status: 'completed', outputs: { exitCode: 0 } }),
    );

    const [wfA, wfB] = orchestrator.getWorkflowIds();
    const statusA = orchestrator.getWorkflowStatus(wfA);
    const statusB = orchestrator.getWorkflowStatus(wfB);

    expect(shouldRunOnFinish(statusA, planA)).toBe(true);
    expect(shouldRunOnFinish(statusB, planB)).toBe(false); // b1 still running
  });

  it('MergeConfig works with shouldRunOnFinish (no PlanDefinition needed)', () => {
    const config = { onFinish: 'merge' as const, baseBranch: 'main', featureBranch: 'feat/x', name: 'Test' };
    expect(shouldRunOnFinish(allCompleted, config)).toBe(true);
    expect(shouldRunOnFinish(allCompleted, { onFinish: 'none' })).toBe(false);
    expect(shouldRunOnFinish(allCompleted, {})).toBe(false);
  });
});
