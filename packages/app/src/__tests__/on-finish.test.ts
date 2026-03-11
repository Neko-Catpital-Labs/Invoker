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
  workflows = new Map<string, { id: string; name: string; status: string }>();
  tasks = new Map<string, { workflowId: string; task: TaskState }>();

  saveWorkflow(workflow: { id: string; name: string; status: string }): void {
    this.workflows.set(workflow.id, workflow);
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

  it('shouldRunOnFinish returns true after all tasks complete', () => {
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

    // After t1: t2 is now running, not settled yet
    let status = orchestrator.getWorkflowStatus();
    expect(shouldRunOnFinish(status, plan)).toBe(false);

    // Complete t2
    orchestrator.handleWorkerResponse(
      makeResponse({ actionId: 't2', status: 'completed', outputs: { exitCode: 0 } }),
    );

    // Now all settled
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

    // Complete t1
    orchestrator.handleWorkerResponse(
      makeResponse({ actionId: 't1', status: 'completed', outputs: { exitCode: 0 } }),
    );

    // Fail t2
    orchestrator.handleWorkerResponse(
      makeResponse({ actionId: 't2', status: 'failed', outputs: { exitCode: 1, error: 'broke' } }),
    );

    const status = orchestrator.getWorkflowStatus();
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
    const status = orchestrator.getWorkflowStatus();

    // GUI path: currentPlan is set → onFinish triggers
    expect(shouldRunOnFinish(status, plan)).toBe(true);

    // Slack path: currentPlan is null → onFinish NEVER triggers (THE BUG)
    expect(shouldRunOnFinish(status, null)).toBe(false);
  });
});
