/**
 * Repro: plan-level poolId must win over Orchestrator defaultPoolId.
 *
 * Live bug: YAML declared poolId: local-mac-only at plan scope, but tasks
 * ran with config.poolId from defaultPoolId (mixed-local-ssh) because
 * parsePlan / loadPlan never applied the plan-level field.
 */
import { describe, it, expect } from 'vitest';
import { Orchestrator } from '../orchestrator.js';
import type { OrchestratorPersistence, OrchestratorMessageBus } from '../orchestrator.js';
import { parsePlan } from '../plan-parser.js';
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
}

class InMemoryBus implements OrchestratorMessageBus {
  publish(_msg: WorkResponse): void {}
  subscribe(_handler: (msg: WorkResponse) => void): () => void {
    return () => {};
  }
}

describe('repro: plan-level poolId honored over defaultPoolId', () => {
  it.fails('parsePlan + loadPlan keep plan poolId when defaultPoolId differs', () => {
    const plan = parsePlan(`
name: Plan Pool Wins
repoUrl: git@github.com:test/repo.git
poolId: local-mac-only
tasks:
  - id: t1
    description: Prompt task without task-level poolId
    prompt: do the work
`);

    expect(plan.poolId).toBe('local-mac-only');

    const orchestrator = new Orchestrator({
      persistence: new InMemoryPersistence(),
      messageBus: new InMemoryBus(),
      maxConcurrency: 3,
      defaultPoolId: 'mixed-local-ssh',
      availablePoolIds: ['local-mac-only', 'mixed-local-ssh'],
    });

    orchestrator.loadPlan(plan);
    const task = orchestrator.getTask('t1');
    expect(task!.config.poolId).toBe('local-mac-only');
  });

  it('task-level poolId still wins over defaultPoolId', () => {
    const orchestrator = new Orchestrator({
      persistence: new InMemoryPersistence(),
      messageBus: new InMemoryBus(),
      maxConcurrency: 3,
      defaultPoolId: 'mixed-local-ssh',
      availablePoolIds: ['local-mac-only', 'mixed-local-ssh'],
    });

    orchestrator.loadPlan({
      name: 'Task Pool Wins',
      repoUrl: 'git@github.com:test/repo.git',
      tasks: [
        {
          id: 't1',
          description: 'Task declares pool',
          prompt: 'do the work',
          poolId: 'local-mac-only',
        },
      ],
    });

    const task = orchestrator.getTask('t1');
    expect(task!.config.poolId).toBe('local-mac-only');
  });
});
