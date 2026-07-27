import { describe, expect, it, vi } from 'vitest';

import type {
  WorkerActionRecord,
  WorkerActionWrite,
  WorkflowMutationPriority,
} from '@invoker/data-store';
import {
  createAutoFixAttemptLedger,
  createAutoFixRecoveryTick,
} from '@invoker/execution-engine';
import { Orchestrator, type TaskState } from '@invoker/workflow-core';
import { InMemoryBus, InMemoryPersistence } from '@invoker/test-kit';

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  child: vi.fn(),
};

function resetAutoFixBudgetRows(
  actions: Map<string, WorkerActionRecord>,
  taskIds: readonly string[],
): void {
  for (const taskId of taskIds) {
    for (const externalKey of [`retry-cap:${taskId}`, `autofix:retry:${taskId}`]) {
      const key = `autofix:${externalKey}`;
      const existing = actions.get(key);
      if (existing) {
        actions.set(key, { ...existing, attemptCount: 0 });
      }
    }
  }
}

function makeFailedTask(task: TaskState, generation: number): void {
  task.status = 'failed';
  task.execution = {
    generation,
    selectedAttemptId: `attempt-${generation}`,
    branch: 'feature/build',
    error: 'Merge conflict merging experiment/wf-1/build',
  };
  task.taskStateVersion = generation;
}

describe('recreate-class auto-fix eligibility', () => {
  it('recreate and rebase-recreate restore exhausted auto-fix eligibility', async () => {
    const persistence = new InMemoryPersistence();
    const actions = new Map<string, WorkerActionRecord>();
    const store = Object.assign(persistence, {
      listWorkflowMutationIntents: () => [],
      getWorkerAction: (workerKind: string, externalKey: string) =>
        actions.get(`${workerKind}:${externalKey}`),
      upsertWorkerAction: (write: WorkerActionWrite) => {
        const key = `${write.workerKind}:${write.externalKey}`;
        const existing = actions.get(key);
        const saved: WorkerActionRecord = {
          ...write,
          id: existing?.id ?? write.id,
          attemptCount: write.attemptCount ?? 0,
          createdAt: existing?.createdAt ?? '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        };
        actions.set(key, saved);
        return saved;
      },
    });
    const resetBudgets = (taskIds: readonly string[]) => resetAutoFixBudgetRows(actions, taskIds);
    const orchestrator = new Orchestrator({
      persistence: store,
      messageBus: new InMemoryBus(),
      maxConcurrency: 0,
      onRecreateTasksReset: resetBudgets,
    } as never);
    orchestrator.loadPlan({
      name: 'recreate resets auto-fix eligibility',
      onFinish: 'none',
      tasks: [{ id: 'build', description: 'build', command: 'pnpm build' }],
    });
    const workflowId = orchestrator.getWorkflowIds()[0]!;
    const taskId = `${workflowId}/build`;
    const submit = vi.fn((_workflowId: string, _priority: WorkflowMutationPriority) => 99);
    const tick = createAutoFixRecoveryTick({
      store,
      submitter: { submit },
      logger,
      attemptLedger: createAutoFixAttemptLedger(),
      defaultAutoFixRetries: 1,
      getAutoFixAgent: () => 'codex',
    });

    for (let generation = 1; generation <= 2; generation += 1) {
      const task = orchestrator.getTask(taskId)!;
      makeFailedTask(task, generation);
      persistence.updateTask(taskId, {
        status: task.status,
        execution: task.execution,
        taskStateVersion: task.taskStateVersion,
      });
      await tick({ reason: 'poll' } as never);
    }
    expect(submit).toHaveBeenCalledTimes(1);

    for (const recreate of [
      () => orchestrator.recreateWorkflow(workflowId),
      () => orchestrator.recreateWorkflowFromFreshBase(workflowId),
    ]) {
      await recreate();
      const task = orchestrator.getTask(taskId)!;
      makeFailedTask(task, (task.execution.generation ?? 0) + 1);
      persistence.updateTask(taskId, {
        status: task.status,
        execution: task.execution,
        taskStateVersion: task.taskStateVersion,
      });
      submit.mockClear();
      await tick({ reason: 'poll' } as never);
      expect(submit).toHaveBeenCalledTimes(1);
    }
  });
});
