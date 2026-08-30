/**
 * Repro: selectExperiment with a short variant id must resolve the experiment
 * task and stamp recon branch/commit so downstream aggregate can prepare.
 *
 * Live failure (wf-1787985528105-14):
 *   headless select …/pivot-mine-catalog-queue-reconciliation mine-02
 *   → selected_experiment='mine-02', recon.branch='', recon.commit_hash=''
 *   while exp-mine-02 had branch experiment/.../exp-mine-02/... and a commit
 *   → aggregate failed: "completed without branch metadata"
 *
 * Root cause: selectExperiment does stateGetTask(experimentId) only. Short
 * variant ids (mine-02) miss the scoped task id (...-exp-mine-02), so winner
 * is undefined and branch/commit are never stamped.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { reconciliationNeedsInputWorkResponse } from './reconciliation-needs-input-shim.js';
import { rid, sid } from './scoped-test-helpers.js';
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

  updateAttempt(): void {}
  logEvent(): void {}
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

function completedResponse(actionId: string): WorkResponse {
  return {
    requestId: `req-${actionId}`,
    actionId,
    executionGeneration: 0,
    status: 'completed',
    outputs: { exitCode: 0 },
  };
}

describe('repro: selectExperiment short variant id stamps recon branch', () => {
  let orchestrator: Orchestrator;
  let persistence: InMemoryPersistence;

  beforeEach(() => {
    persistence = new InMemoryPersistence();
    orchestrator = new Orchestrator({
      persistence,
      messageBus: new InMemoryBus(),
      maxConcurrency: 10,
    });
  });

  it.fails(
    'select with short variant id resolves experiment and stamps recon branch/commit',
    () => {
      const plan: PlanDefinition = {
        name: 'select-short-id-branch',
        baseBranch: 'main',
        tasks: [
          { id: 'setup', description: 'Setup' },
          {
            id: 'pivot',
            description: 'Spawn mines',
            dependencies: ['setup'],
            pivot: true,
            experimentVariants: [
              { id: 'mine-02', description: 'Mine 02', command: 'echo 02' },
              { id: 'mine-03', description: 'Mine 03', command: 'echo 03' },
            ],
          },
          {
            id: 'aggregate',
            description: 'Aggregate',
            dependencies: ['pivot'],
          },
        ],
      };

      orchestrator.loadPlan(plan);
      orchestrator.startExecution();

      const setupId = sid(orchestrator, 0, 'setup');
      const pivotId = sid(orchestrator, 0, 'pivot');
      orchestrator.handleWorkerResponse(completedResponse(setupId));
      orchestrator.handleWorkerResponse(spawnResponse(pivotId, ['mine-02', 'mine-03']));

      const winnerId = sid(orchestrator, 0, 'pivot-exp-mine-02');
      const otherId = sid(orchestrator, 0, 'pivot-exp-mine-03');
      expect(orchestrator.getTask(winnerId)).toBeDefined();
      orchestrator.handleWorkerResponse(completedResponse(winnerId));
      orchestrator.handleWorkerResponse(completedResponse(otherId));
      orchestrator.handleWorkerResponse(
        reconciliationNeedsInputWorkResponse(rid(orchestrator, 0, 'pivot')),
      );

      persistence.updateTask(winnerId, {
        execution: {
          branch: 'experiment/wf/pivot-exp-mine-02/g0',
          commit: '4dab7cd6c7df8c36dcc4fb88beedf79b01aa36c1',
        },
      });

      // Live headless select used the variant id, not the scoped task id.
      orchestrator.selectExperiment(rid(orchestrator, 0, 'pivot'), 'mine-02');

      const recon = orchestrator.getTask(rid(orchestrator, 0, 'pivot'))!;
      expect(recon.status).toBe('completed');
      expect(recon.execution.selectedExperiment).toBe(winnerId);
      expect(recon.execution.branch).toBe('experiment/wf/pivot-exp-mine-02/g0');
      expect(recon.execution.commit).toBe('4dab7cd6c7df8c36dcc4fb88beedf79b01aa36c1');
    },
  );
});
