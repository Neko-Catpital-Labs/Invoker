/**
 * Evaluator-owned behavioural checks for the architecture-as-memory trial task.
 *
 * This file is never present in a trial workspace. It is injected into a clean
 * evaluator copy at grading time, after the trial's final diff has been applied.
 * Every `it` name is a stable check id consumed by run.py.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Orchestrator, TaskState } from '@invoker/workflow-core';
import type { SQLiteAdapter } from '@invoker/data-store';
import type { TaskRunner } from '@invoker/execution-engine';
import {
  WorkflowMutationFacade,
  type WorkflowMutationFacadeDeps,
} from '../workflow-mutation-facade.js';

const TARGET_TASK_ID = 'wf-1/task-a';
const TARGET_WORKFLOW_ID = 'wf-1';

function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    id: TARGET_TASK_ID,
    status: 'review_ready' as const,
    description: 'idle task',
    dependencies: [],
    createdAt: new Date(),
    config: { workflowId: TARGET_WORKFLOW_ID },
    execution: {},
    ...overrides,
  } as unknown as TaskState;
}

type Harness = {
  facade: WorkflowMutationFacade & { closeIdleTask?: (taskId: string) => Promise<unknown> };
  deps: WorkflowMutationFacadeDeps;
  closeIdleTask: ReturnType<typeof vi.fn>;
  closeWorkflowReview: ReturnType<typeof vi.fn>;
  startExecution: ReturnType<typeof vi.fn>;
};

function makeHarness(
  closeIdleTaskResult: { ok: true; data: unknown } | { ok: false; error: { code: string; message: string } } = {
    ok: true,
    data: makeTask({ status: 'closed' }),
  },
): Harness {
  const topupTask = makeTask({ id: 'wf-1/topup', status: 'running' });
  const startExecution = vi.fn(() => [topupTask]);
  const closeWorkflowReview = vi.fn(async () => undefined);
  const closeIdleTask = vi.fn(async () => closeIdleTaskResult);

  const orchestrator = {
    getTask: vi.fn(() => makeTask()),
    getAllTasks: vi.fn(() => [makeTask()]),
    startExecution,
    closeIdleTask: vi.fn(() => makeTask({ status: 'closed' })),
    cancelTask: vi.fn(() => ({ cancelled: [TARGET_TASK_ID], runningCancelled: [] })),
  };
  const persistence = {
    loadWorkflow: vi.fn(() => ({ id: TARGET_WORKFLOW_ID, generation: 1 })),
    updateWorkflow: vi.fn(),
    loadTasks: vi.fn(() => []),
  };
  const taskExecutor = {
    executeTasks: vi.fn(),
    killActiveExecution: vi.fn(),
    closeWorkflowReview,
  };
  const commandService = {
    closeIdleTask,
    runSerializedForTask: vi.fn(
      async (_taskId: string | undefined, fn: () => Promise<unknown> | unknown) => ({
        ok: true as const,
        data: await fn(),
      }),
    ),
    runSerializedForWorkflow: vi.fn(
      async (_workflowId: string | undefined, fn: () => Promise<unknown> | unknown) => ({
        ok: true as const,
        data: await fn(),
      }),
    ),
  };

  const deps = {
    orchestrator: orchestrator as unknown as Orchestrator,
    persistence: persistence as unknown as SQLiteAdapter,
    commandService: commandService as unknown as WorkflowMutationFacadeDeps['commandService'],
    taskExecutor: taskExecutor as unknown as TaskRunner,
  } as WorkflowMutationFacadeDeps;

  return {
    facade: new WorkflowMutationFacade(deps) as Harness['facade'],
    deps,
    closeIdleTask,
    closeWorkflowReview,
    startExecution,
  };
}

function callOrder(spy: ReturnType<typeof vi.fn>): number {
  const orders = (spy as unknown as { mock: { invocationCallOrder: number[] } }).mock.invocationCallOrder;
  expect(orders.length).toBeGreaterThan(0);
  return orders[0];
}

describe('architecture-memory close-idle-task checks', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = makeHarness();
  });

  it('check:exposes-close-idle-task', async () => {
    expect(typeof harness.facade.closeIdleTask).toBe('function');
    const result = (await harness.facade.closeIdleTask!(TARGET_TASK_ID)) as Record<string, unknown>;
    expect(result).toBeTruthy();
    expect(Array.isArray(result.started)).toBe(true);
    expect(Array.isArray(result.runnable)).toBe(true);
    expect(Array.isArray(result.topup)).toBe(true);
  });

  it('check:routes-through-command-service', async () => {
    expect(typeof harness.facade.closeIdleTask).toBe('function');
    await harness.facade.closeIdleTask!(TARGET_TASK_ID);

    expect(harness.closeIdleTask).toHaveBeenCalledTimes(1);
    const envelope = harness.closeIdleTask.mock.calls[0][0] as {
      commandId?: string;
      scope?: string;
      payload?: { taskId?: string };
    };
    expect(envelope?.payload?.taskId).toBe(TARGET_TASK_ID);
    expect(envelope?.commandId).toBe('facade.close-idle-task');
    expect(envelope?.scope).toBe('task');
  });

  it('check:closes-review-before-mutation', async () => {
    expect(typeof harness.facade.closeIdleTask).toBe('function');
    await harness.facade.closeIdleTask!(TARGET_TASK_ID);

    expect(harness.closeWorkflowReview).toHaveBeenCalledWith(TARGET_WORKFLOW_ID);
    expect(harness.closeIdleTask).toHaveBeenCalledTimes(1);
    expect(callOrder(harness.closeWorkflowReview)).toBeLessThan(callOrder(harness.closeIdleTask));
  });

  it('check:runs-scoped-dispatch-and-topup', async () => {
    expect(typeof harness.facade.closeIdleTask).toBe('function');
    const result = (await harness.facade.closeIdleTask!(TARGET_TASK_ID)) as {
      topup: TaskState[];
    };

    expect(harness.startExecution).toHaveBeenCalled();
    expect(result.topup.map((task) => task.id)).toContain('wf-1/topup');
  });

  it('check:propagates-command-service-failure', async () => {
    const failing = makeHarness({
      ok: false,
      error: { code: 'CLOSE_IDLE_TASK_FAILED', message: 'task is running' },
    });
    expect(typeof failing.facade.closeIdleTask).toBe('function');

    await expect(failing.facade.closeIdleTask!(TARGET_TASK_ID)).rejects.toThrow();
  });
});
