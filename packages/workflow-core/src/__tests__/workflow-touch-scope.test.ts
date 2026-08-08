import { describe, expect, it } from 'vitest';
import { Orchestrator, type OrchestratorMessageBus, type OrchestratorPersistence } from '../orchestrator.js';
import { computeWorkflowRollup } from '../task-types.js';
import type {
  Attempt,
  ExternalDependency,
  ExternalDependencyChange,
  TaskState,
  TaskStateChanges,
} from '../task-types.js';
import type { WorkResponse } from '@invoker/contracts';

type WorkflowRecord = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  repoUrl?: string;
  baseBranch?: string;
  featureBranch?: string;
  mergeMode?: 'manual' | 'automatic' | 'external_review' | 'no_op';
  externalDependencies?: ExternalDependency[];
  externalDependencyChanges?: ExternalDependencyChange[];
  generation?: number;
};

class RecordingPersistence implements OrchestratorPersistence {
  workflows = new Map<string, WorkflowRecord>();
  tasks = new Map<string, { workflowId: string; task: TaskState }>();
  attempts = new Map<string, Attempt[]>();
  updateWorkflowHistory: Array<{
    workflowId: string;
    changes: {
      updatedAt?: string;
      baseBranch?: string;
      generation?: number;
      mergeMode?: 'manual' | 'automatic' | 'external_review' | 'no_op';
      externalDependencies?: ExternalDependency[];
      externalDependencyChanges?: ExternalDependencyChange[];
    };
  }> = [];

  saveWorkflow(workflow: WorkflowRecord): void {
    const now = new Date().toISOString();
    this.workflows.set(workflow.id, {
      ...workflow,
      repoUrl: workflow.repoUrl ?? 'memory://test-repo',
      createdAt: workflow.createdAt ?? now,
      updatedAt: workflow.updatedAt ?? now,
      generation: workflow.generation ?? 0,
    });
  }

  updateWorkflow(
    workflowId: string,
    changes: {
      updatedAt?: string;
      baseBranch?: string;
      generation?: number;
      mergeMode?: 'manual' | 'automatic' | 'external_review' | 'no_op';
      externalDependencies?: ExternalDependency[];
      externalDependencyChanges?: ExternalDependencyChange[];
    },
  ): void {
    this.updateWorkflowHistory.push({ workflowId, changes: { ...changes } });
    const wf = this.workflows.get(workflowId);
    if (!wf) return;
    if (changes.updatedAt !== undefined) wf.updatedAt = changes.updatedAt;
    if (changes.baseBranch !== undefined) wf.baseBranch = changes.baseBranch;
    if (changes.generation !== undefined) wf.generation = changes.generation;
    if (changes.mergeMode !== undefined) wf.mergeMode = changes.mergeMode;
    if ('externalDependencies' in changes) wf.externalDependencies = changes.externalDependencies;
    if ('externalDependencyChanges' in changes) wf.externalDependencyChanges = changes.externalDependencyChanges;
  }

  saveTask(workflowId: string, task: TaskState): void {
    this.tasks.set(task.id, { workflowId, task });
  }

  updateTask(taskId: string, changes: TaskStateChanges): void {
    const entry = this.tasks.get(taskId);
    if (!entry) return;
    entry.task = {
      ...entry.task,
      ...(changes.status !== undefined ? { status: changes.status } : {}),
      ...(changes.dependencies !== undefined ? { dependencies: changes.dependencies } : {}),
      config: { ...entry.task.config, ...changes.config },
      execution: { ...entry.task.execution, ...changes.execution },
      taskStateVersion: (entry.task.taskStateVersion ?? 1) + 1,
    } as TaskState;
  }

  listWorkflows(): Array<WorkflowRecord & { status: string }> {
    return Array.from(this.workflows.values()).map((workflow) => ({
      ...workflow,
      status: computeWorkflowRollup(this.loadTasks(workflow.id)).status,
    }));
  }

  loadWorkflow(workflowId: string): (WorkflowRecord & { status: string }) | undefined {
    return this.listWorkflows().find((workflow) => workflow.id === workflowId);
  }

  loadTasks(workflowId: string): TaskState[] {
    return Array.from(this.tasks.values())
      .filter((entry) => entry.workflowId === workflowId)
      .map((entry) => entry.task);
  }

  logEvent(): void {}

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
      const found = list.find((attempt) => attempt.id === attemptId);
      if (found) return found;
    }
    return undefined;
  }

  updateAttempt(attemptId: string, changes: Partial<Attempt>): void {
    for (const list of this.attempts.values()) {
      const index = list.findIndex((attempt) => attempt.id === attemptId);
      if (index !== -1) {
        list[index] = { ...list[index], ...changes };
        return;
      }
    }
  }
}

class InMemoryBus implements OrchestratorMessageBus {
  publish<T>(_channel: string, _message: T): void {}
}

function makeOrchestrator(persistence: RecordingPersistence): Orchestrator {
  return new Orchestrator({
    persistence,
    messageBus: new InMemoryBus(),
    maxConcurrency: 8,
  });
}

function makeResponse(overrides: Partial<WorkResponse>): WorkResponse {
  return {
    requestId: 'req-1',
    actionId: 'task-1',
    executionGeneration: 0,
    status: 'completed',
    outputs: { exitCode: 0 },
    ...overrides,
  };
}

function findTask(orchestrator: Orchestrator, localId: string): TaskState {
  return orchestrator.getAllTasks().find((task) => task.id.endsWith(`/${localId}`))!;
}

describe('workflow updatedAt touch scope', () => {
  it('does not touch an unrelated active bystander workflow when one task completes', () => {
    const persistence = new RecordingPersistence();
    const orchestrator = makeOrchestrator(persistence);

    orchestrator.loadPlan({
      name: 'driver',
      tasks: [{ id: 'driver-task', description: 'driver task' }],
    });
    orchestrator.loadPlan({
      name: 'bystander',
      tasks: [
        { id: 'bystander-root', description: 'unrelated running task' },
        { id: 'bystander-leaf', description: 'unrelated blocked task', dependencies: ['bystander-root'] },
      ],
    });

    const driverTaskId = findTask(orchestrator, 'driver-task').id;
    const bystanderWorkflowId = findTask(orchestrator, 'bystander-root').config.workflowId!;

    orchestrator.startExecution();
    persistence.updateWorkflowHistory = [];

    orchestrator.handleWorkerResponse(makeResponse({ actionId: driverTaskId, status: 'completed' }));

    expect(persistence.updateWorkflowHistory.some((call) => call.workflowId === bystanderWorkflowId)).toBe(false);
  });

  it('still wakes a downstream workflow gated on the upstream merge gate', () => {
    const persistence = new RecordingPersistence();
    const orchestrator = makeOrchestrator(persistence);

    orchestrator.loadPlan({
      name: 'upstream',
      tasks: [{ id: 'upstream-task', description: 'upstream task' }],
    });
    const upstreamTaskId = findTask(orchestrator, 'upstream-task').id;
    const upstreamWorkflowId = upstreamTaskId.split('/')[0]!;
    const upstreamMergeId = `__merge__${upstreamWorkflowId}`;

    orchestrator.loadPlan({
      name: 'downstream',
      tasks: [
        {
          id: 'downstream-leaf',
          description: 'leaf waits for upstream merge gate',
          externalDependencies: [{ workflowId: upstreamWorkflowId, gatePolicy: 'completed' }],
        },
      ],
    });
    const downstreamTaskId = findTask(orchestrator, 'downstream-leaf').id;

    const initiallyStarted = orchestrator.startExecution();
    expect(initiallyStarted.map((task) => task.id)).toContain(upstreamTaskId);
    expect(initiallyStarted.map((task) => task.id)).not.toContain(downstreamTaskId);
    expect(orchestrator.getTask(downstreamTaskId)!.status).toBe('pending');

    const afterUpstreamTask = orchestrator.handleWorkerResponse(
      makeResponse({ actionId: upstreamTaskId, status: 'completed' }),
    );
    expect(afterUpstreamTask.map((task) => task.id)).toContain(upstreamMergeId);
    expect(afterUpstreamTask.map((task) => task.id)).not.toContain(downstreamTaskId);
    expect(orchestrator.getTask(downstreamTaskId)!.status).toBe('pending');

    const afterMergeGate = orchestrator.handleWorkerResponse(
      makeResponse({ actionId: upstreamMergeId, status: 'completed' }),
    );
    expect(afterMergeGate.map((task) => task.id)).toContain(downstreamTaskId);
    expect(orchestrator.getTask(downstreamTaskId)!.status).toBe('running');
  });
});
