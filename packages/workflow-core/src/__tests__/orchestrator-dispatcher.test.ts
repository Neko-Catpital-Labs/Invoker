import { describe, expect, it } from 'vitest';
import { Orchestrator } from '../orchestrator.js';
import type {
  Attempt,
  OrchestratorMessageBus,
  OrchestratorPersistence,
  PlanDefinition,
} from '../orchestrator.js';
import type { TaskState, TaskStateChanges } from '../task-types.js';
import type { WorkResponse } from '@invoker/contracts';

class InMemoryPersistence implements OrchestratorPersistence {
  workflows = new Map<string, { id: string; name: string; status: string; createdAt: string; updatedAt: string }>();
  tasks = new Map<string, { workflowId: string; task: TaskState }>();
  private attempts = new Map<string, Attempt[]>();

  saveWorkflow(workflow: { id: string; name: string; status: string }): void {
    const now = new Date().toISOString();
    this.workflows.set(workflow.id, { ...workflow, createdAt: now, updatedAt: now });
  }

  updateWorkflow(workflowId: string, changes: { status?: string }): void {
    const existing = this.workflows.get(workflowId);
    if (existing && changes.status !== undefined) {
      existing.status = changes.status;
    }
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
    } as TaskState;
  }

  listWorkflows(): Array<{ id: string; name: string; status: string; createdAt: string; updatedAt: string }> {
    return Array.from(this.workflows.values());
  }

  loadTasks(workflowId: string): TaskState[] {
    return Array.from(this.tasks.values())
      .filter((entry) => entry.workflowId === workflowId)
      .map((entry) => entry.task);
  }

  saveAttempt(attempt: Attempt): void {
    const attempts = this.attempts.get(attempt.nodeId) ?? [];
    attempts.push(attempt);
    this.attempts.set(attempt.nodeId, attempts);
  }

  loadAttempts(nodeId: string): Attempt[] {
    return this.attempts.get(nodeId) ?? [];
  }

  loadAttempt(attemptId: string): Attempt | undefined {
    for (const attempts of this.attempts.values()) {
      const found = attempts.find((attempt) => attempt.id === attemptId);
      if (found) return found;
    }
    return undefined;
  }

  updateAttempt(
    attemptId: string,
    changes: Partial<Pick<Attempt, 'status' | 'claimedAt' | 'startedAt' | 'completedAt' | 'exitCode' | 'error' | 'lastHeartbeatAt' | 'leaseExpiresAt' | 'branch' | 'commit' | 'summary' | 'workspacePath' | 'agentSessionId' | 'containerId' | 'mergeConflict'>>,
  ): void {
    for (const attempts of this.attempts.values()) {
      const idx = attempts.findIndex((attempt) => attempt.id === attemptId);
      if (idx >= 0) {
        attempts[idx] = { ...attempts[idx], ...changes } as Attempt;
        return;
      }
    }
  }

  logEvent(): void {}
}

class InMemoryBus implements OrchestratorMessageBus {
  publish(): void {}
  subscribe(): () => void {
    return () => {};
  }
}

function makeResponse(
  actionId: string,
  status: WorkResponse['status'],
  executionGeneration: number,
  exitCode = 0,
): WorkResponse {
  return {
    requestId: `req-${actionId}`,
    actionId,
    executionGeneration,
    status,
    outputs: { exitCode },
  };
}

function makeOrchestrator(taskDispatcher?: (tasks: TaskState[]) => void): {
  orchestrator: Orchestrator;
  persistence: InMemoryPersistence;
} {
  const persistence = new InMemoryPersistence();
  const orchestrator = new Orchestrator({
    persistence,
    messageBus: new InMemoryBus(),
    taskDispatcher,
    maxConcurrency: 4,
  });
  return { orchestrator, persistence };
}

function taskIdBySuffix(orchestrator: Orchestrator, suffix: string): string {
  const task = orchestrator.getAllTasks().find((item) => item.id.endsWith(`/${suffix}`));
  if (!task) {
    throw new Error(`Task with suffix "${suffix}" not found`);
  }
  return task.id;
}

function respondForTask(
  orchestrator: Orchestrator,
  taskId: string,
  status: WorkResponse['status'],
  exitCode = 0,
): void {
  const generation = orchestrator.getTask(taskId)?.execution.generation ?? 0;
  orchestrator.handleWorkerResponse(makeResponse(taskId, status, generation, exitCode));
}

describe('Orchestrator taskDispatcher', () => {
  it('startExecution dispatches each started task exactly once', () => {
    const dispatched: string[] = [];
    const { orchestrator } = makeOrchestrator((tasks) => tasks.forEach((task) => dispatched.push(task.id)));
    const plan: PlanDefinition = {
      name: 'dispatcher-start',
      onFinish: 'none',
      tasks: [
        { id: 't1', description: 'first', command: 'echo one' },
        { id: 't2', description: 'second', command: 'echo two' },
      ],
    };

    const started = orchestrator.startExecution();
    expect(started).toHaveLength(0);

    orchestrator.loadPlan(plan);
    const startedAfterLoad = orchestrator.startExecution();

    expect(startedAfterLoad).toHaveLength(2);
    expect(dispatched).toHaveLength(2);
    expect(new Set(dispatched).size).toBe(2);
  });

  it('dispatches tasks for restart/retry/recreate entrypoints', () => {
    const dispatched: string[] = [];
    const { orchestrator } = makeOrchestrator((tasks) => tasks.forEach((task) => dispatched.push(task.id)));
    orchestrator.loadPlan({
      name: 'dispatcher-retry-paths',
      onFinish: 'none',
      tasks: [{ id: 't1', description: 'one', command: 'exit 1' }],
    });

    const taskId = taskIdBySuffix(orchestrator, 't1');
    const workflowId = orchestrator.getWorkflowIds()[0]!;

    orchestrator.startExecution();
    respondForTask(orchestrator, taskId, 'failed', 1);

    dispatched.length = 0;
    orchestrator.restartTask(taskId);
    expect(dispatched).toEqual([taskId]);

    respondForTask(orchestrator, taskId, 'failed', 1);
    dispatched.length = 0;
    orchestrator.retryWorkflow(workflowId);
    expect(dispatched).toEqual([taskId]);

    respondForTask(orchestrator, taskId, 'failed', 1);
    dispatched.length = 0;
    orchestrator.recreateTask(taskId);
    expect(dispatched).toEqual([taskId]);

    respondForTask(orchestrator, taskId, 'failed', 1);
    dispatched.length = 0;
    orchestrator.recreateWorkflow(workflowId);
    expect(dispatched).toEqual([taskId]);

  });

  it('resumeWorkflow dispatches persisted pending tasks', () => {
    const dispatched: string[] = [];
    const { orchestrator } = makeOrchestrator((tasks) => tasks.forEach((task) => dispatched.push(task.id)));
    orchestrator.loadPlan({
      name: 'dispatcher-resume',
      onFinish: 'none',
      tasks: [{ id: 't1', description: 'one', command: 'echo one' }],
    });
    const workflowId = orchestrator.getWorkflowIds()[0]!;
    const taskId = taskIdBySuffix(orchestrator, 't1');

    orchestrator.resumeWorkflow(workflowId);
    expect(dispatched).toEqual([taskId]);
  });

  it('dispatches downstream tasks from handleWorkerResponse and approval cascades', async () => {
    const dispatched: string[] = [];
    const { orchestrator, persistence } = makeOrchestrator((tasks) => tasks.forEach((task) => dispatched.push(task.id)));
    orchestrator.loadPlan({
      name: 'dispatcher-cascade',
      onFinish: 'none',
      tasks: [
        { id: 'prepare', description: 'prepare', command: 'echo prepare' },
        { id: 'downstream', description: 'downstream', command: 'echo downstream', dependencies: ['prepare'] },
        { id: 'approval-downstream', description: 'approval downstream', command: 'echo approval', dependencies: ['approval-root'] },
        { id: 'approval-root', description: 'approval root', command: 'echo approval-root' },
      ],
    });

    const prepareId = taskIdBySuffix(orchestrator, 'prepare');
    const downstreamId = taskIdBySuffix(orchestrator, 'downstream');
    const approvalRootId = taskIdBySuffix(orchestrator, 'approval-root');
    const approvalDownstreamId = taskIdBySuffix(orchestrator, 'approval-downstream');

    orchestrator.startExecution();
    dispatched.length = 0;
    respondForTask(orchestrator, prepareId, 'completed', 0);
    expect(dispatched).toContain(downstreamId);

    persistence.updateTask(approvalRootId, { status: 'awaiting_approval' });
    orchestrator.syncAllFromDb();
    dispatched.length = 0;
    await orchestrator.approve(approvalRootId);
    expect(dispatched).toContain(approvalDownstreamId);
  });

  it('keeps behavior unchanged when taskDispatcher is not configured', () => {
    const { orchestrator } = makeOrchestrator();
    orchestrator.loadPlan({
      name: 'dispatcher-optional',
      onFinish: 'none',
      tasks: [{ id: 't1', description: 'one', command: 'echo one' }],
    });

    const started = orchestrator.startExecution();
    expect(started).toHaveLength(1);
    expect(started[0]?.status).toBe('running');
    expect(started[0]?.execution.phase).toBe('launching');
  });
});
