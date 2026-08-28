/**
 * Repro: experiment spawn must base off upstream dependency tip, not bare
 * workflow baseBranch.
 *
 * Live failure (wf-1787953806664-1): discover committed cases.json on
 * experiment/.../discover at d42945d; pivot spawn stamped execution.branch
 * to plan baseBranch ("main") with no commit; mines branched from main tip
 * and failed `test -f work/sec-fraud-wave1/cases.json`.
 *
 * Root cause: handleSpawnExperimentsImpl sourceChanges forces
 * `{ execution: { branch: wf.baseBranch } }`, wiping dependency ancestry.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { sid } from './scoped-test-helpers.js';
import { Orchestrator } from '../orchestrator.js';
import type { PlanDefinition, OrchestratorPersistence, OrchestratorMessageBus } from '../orchestrator.js';
import { computeWorkflowRollup, type TaskState, type TaskStateChanges, type Attempt } from '../task-types.js';
import type { WorkResponse } from '@invoker/contracts';

class InMemoryPersistence implements OrchestratorPersistence {
  workflows = new Map<
    string,
    { id: string; name: string; status: string; createdAt: string; updatedAt: string; baseBranch?: string }
  >();
  tasks = new Map<string, { workflowId: string; task: TaskState }>();
  private attempts = new Map<string, Attempt[]>();

  saveWorkflow(workflow: { id: string; name: string; baseBranch?: string }): void {
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
          command: `test -f work/sec-fraud-wave1/cases.json && echo ${id}`,
        })),
      },
    },
  };
}

describe('repro: experiment spawn inherits upstream dependency base', () => {
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

  it.fails('after spawn, pivot execution carries the completed upstream dep tip (not bare main)', () => {
    const discoverBranch = 'experiment/wf-repro/discover-50-eligible-cases-abc12345';
    const discoverCommit = 'd42945d0deadbeefcafe00112233445566778899';

    const plan: PlanDefinition = {
      name: 'experiment-upstream-base-repro',
      baseBranch: 'main',
      tasks: [
        { id: 'discover', description: 'Write cases.json' },
        {
          id: 'pivot',
          description: 'Spawn mines',
          dependencies: ['discover'],
          pivot: true,
          experimentVariants: [
            { id: 'mine-00', description: 'Mine 0', command: 'echo 0' },
            { id: 'mine-01', description: 'Mine 1', command: 'echo 1' },
          ],
        },
      ],
    };

    orchestrator.loadPlan(plan);
    orchestrator.startExecution();

    const discoverId = sid(orchestrator, 0, 'discover');
    const pivotId = sid(orchestrator, 0, 'pivot');

    // Discover completes with a real branch+commit (artifact tip).
    orchestrator.handleWorkerResponse({
      requestId: 'req-discover',
      actionId: discoverId,
      executionGeneration: 0,
      status: 'completed',
      outputs: {
        exitCode: 0,
        branch: discoverBranch,
        commitHash: discoverCommit,
        summary: 'wrote cases.json',
      },
    });

    expect(orchestrator.getTask(discoverId)!.execution.branch).toBe(discoverBranch);
    expect(orchestrator.getTask(discoverId)!.execution.commit).toBe(discoverCommit);
    expect(orchestrator.getTask(pivotId)!.status).toBe('running');

    // Pivot spawn (commandless) — must not wipe ancestry to bare main.
    orchestrator.handleWorkerResponse(spawnResponse(pivotId, ['mine-00', 'mine-01']));

    const pivotAfter = orchestrator.getTask(pivotId)!;
    expect(pivotAfter.status).toBe('completed');
    expect(
      pivotAfter.execution.branch,
      'pivot branch must be the upstream discover tip, not workflow baseBranch',
    ).toBe(discoverBranch);
    expect(
      pivotAfter.execution.commit,
      'pivot commit must be the upstream discover tip so collectUpstreamBase works',
    ).toBe(discoverCommit);

    for (const local of ['pivot-exp-mine-00', 'pivot-exp-mine-01']) {
      const exp = orchestrator.getTask(sid(orchestrator, 0, local))!;
      expect(exp.dependencies).toContain(pivotId);
      expect(exp.dependencies, `${local} must also depend on discover`).toContain(discoverId);
      // Upstream tip visible via pivot (and optionally via direct discover dep).
      const upstreamTips = exp.dependencies
        .map((id) => orchestrator.getTask(id)!)
        .filter((t) => t.status === 'completed' && t.execution.branch && t.execution.commit)
        .map((t) => ({ branch: t.execution.branch, commit: t.execution.commit }));
      expect(
        upstreamTips.some((t) => t.branch === discoverBranch && t.commit === discoverCommit),
        `${local} must see discover tip via completed deps`,
      ).toBe(true);
    }
  });
});
