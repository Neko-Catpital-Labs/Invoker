/**
 * Repro: experiment variants must inherit the pivot's pool/executor routing.
 *
 * Live failure (wf-1787905292477-3): pivot had poolId + runnerKind=ssh (plan
 * pools are labeled ssh at load time), spawn copied runnerKind but dropped
 * poolId → selectExecutor threw "runnerKind=ssh but no poolMemberId".
 *
 * Root cause: handleSpawnExperimentsImpl / applyGraphMutationImpl omit poolId.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { sid } from './scoped-test-helpers.js';
import { Orchestrator } from '../orchestrator.js';
import type { PlanDefinition, OrchestratorPersistence, OrchestratorMessageBus } from '../orchestrator.js';
import { computeWorkflowRollup, type TaskState, type TaskStateChanges, type Attempt } from '../task-types.js';
import type { WorkResponse } from '@invoker/contracts';

class InMemoryPersistence implements OrchestratorPersistence {
  workflows = new Map<string, { id: string; name: string; status: string; createdAt: string; updatedAt: string }>();
  tasks = new Map<string, { workflowId: string; task: TaskState }>();
  private attempts = new Map<string, Attempt[]>();

  saveWorkflow(workflow: { id: string; name: string }): void {
    const now = new Date().toISOString();
    this.workflows.set(workflow.id, {
      ...workflow,
      status: 'pending',
      createdAt: (workflow as { createdAt?: string }).createdAt ?? now,
      updatedAt: (workflow as { updatedAt?: string }).updatedAt ?? now,
    });
  }

  updateWorkflow(_workflowId: string, _changes: { updatedAt?: string }): void {}

  listWorkflows(): Array<{ id: string; name: string; status: string; createdAt: string; updatedAt: string }> {
    return Array.from(this.workflows.values()).map((workflow) => ({
      ...workflow,
      status: computeWorkflowRollup(this.loadTasks(workflow.id)).status,
    }));
  }

  saveTask(workflowId: string, task: TaskState): void {
    this.tasks.set(task.id, { workflowId, task });
  }

  updateTask(taskId: string, changes: TaskStateChanges): void {
    const entry = this.tasks.get(taskId);
    if (entry) {
      entry.task = {
        ...entry.task,
        ...(changes.status !== undefined ? { status: changes.status } : {}),
        ...(changes.dependencies !== undefined ? { dependencies: changes.dependencies } : {}),
        config: { ...entry.task.config, ...changes.config },
        execution: { ...entry.task.execution, ...changes.execution },
      } as TaskState;
    }
  }

  loadTasks(workflowId: string): TaskState[] {
    return Array.from(this.tasks.values())
      .filter((e) => e.workflowId === workflowId)
      .map((e) => e.task);
  }

  loadWorkflow(workflowId: string): { repoUrl?: string; baseBranch?: string } | undefined {
    return this.workflows.get(workflowId) as { repoUrl?: string; baseBranch?: string } | undefined;
  }

  saveAttempt(attempt: Attempt): void {
    const list = this.attempts.get(attempt.nodeId) ?? [];
    list.push(attempt);
    this.attempts.set(attempt.nodeId, list);
  }

  loadAttempts(nodeId: string): Attempt[] {
    return this.attempts.get(nodeId) ?? [];
  }

  loadAttempt(attemptId: string): Attempt | undefined {
    for (const list of this.attempts.values()) {
      const found = list.find((a) => a.id === attemptId);
      if (found) return found;
    }
    return undefined;
  }

  updateAttempt(
    attemptId: string,
    changes: Partial<Pick<Attempt, 'status' | 'startedAt' | 'completedAt' | 'exitCode' | 'error'>>,
  ): void {
    for (const list of this.attempts.values()) {
      const idx = list.findIndex((a) => a.id === attemptId);
      if (idx !== -1) {
        list[idx] = { ...list[idx], ...changes } as Attempt;
        return;
      }
    }
  }
}

class InMemoryBus implements OrchestratorMessageBus {
  publish(): void {}
  subscribe(): () => void {
    return () => {};
  }
}

function spawnResponse(actionId: string, variantIds: string[]): WorkResponse {
  return {
    requestId: `req-${actionId}`,
    actionId,
    executionGeneration: 0,
    status: 'spawn_experiments',
    outputs: { exitCode: 0 },
    dagMutation: {
      spawnExperiments: {
        description: `Experiment variants for ${actionId}`,
        variants: variantIds.map((id) => ({
          id,
          prompt: `Try ${id}`,
          description: `Variant ${id}`,
          command: `echo ${id}`,
        })),
      },
    },
  };
}

describe('repro: experiment spawn inherits pivot pool executor', () => {
  let orchestrator: Orchestrator;

  beforeEach(() => {
    orchestrator = new Orchestrator({
      persistence: new InMemoryPersistence(),
      messageBus: new InMemoryBus(),
      maxConcurrency: 10,
      availablePoolIds: ['local-mac-only'],
      defaultPoolId: 'local-mac-only',
    });
  });

  it.fails('spawned experiment tasks keep the pivot poolId (and runnerKind)', () => {
    const plan: PlanDefinition = {
      name: 'experiment-pool-inherit-repro',
      baseBranch: 'main',
      tasks: [
        {
          id: 'pivot',
          description: 'Pivot with pool',
          pivot: true,
          poolId: 'local-mac-only',
          experimentVariants: [
            { id: 'mine-00', description: 'Mine 0', command: 'echo 0' },
            { id: 'mine-01', description: 'Mine 1', command: 'echo 1' },
          ],
        },
      ],
    };

    orchestrator.loadPlan(plan);
    orchestrator.startExecution();

    const pivotId = sid(orchestrator, 0, 'pivot');
    const pivot = orchestrator.getTask(pivotId)!;
    expect(pivot.config.poolId).toBe('local-mac-only');
    // Plan pools are currently stamped runnerKind=ssh at load; selectExecutor
    // remaps via pool members when poolId is present.
    expect(pivot.config.runnerKind).toBe('ssh');

    orchestrator.handleWorkerResponse(spawnResponse(pivotId, ['mine-00', 'mine-01']));

    for (const local of ['pivot-exp-mine-00', 'pivot-exp-mine-01']) {
      const exp = orchestrator.getTask(sid(orchestrator, 0, local))!;
      expect(exp.config.runnerKind, `${local} runnerKind`).toBe(pivot.config.runnerKind);
      expect(exp.config.poolId, `${local} poolId`).toBe(pivot.config.poolId);
    }
  });
});
