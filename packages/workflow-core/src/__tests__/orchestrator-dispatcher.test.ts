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
    if (existing && changes.status !== undefined) existing.status = changes.status;
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

  updateAttempt(attemptId: string, changes: Partial<Attempt>): void {
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

function makeOrchestrator(
  opts: { deferRunningUntilLaunch?: boolean } = {},
): { orchestrator: Orchestrator; persistence: InMemoryPersistence } {
  const persistence = new InMemoryPersistence();
  const orchestrator = new Orchestrator({
    persistence,
    messageBus: new InMemoryBus(),
    maxConcurrency: 4,
    deferRunningUntilLaunch: opts.deferRunningUntilLaunch,
  });
  return { orchestrator, persistence };
}

function taskIdBySuffix(orchestrator: Orchestrator, suffix: string): string {
  const task = orchestrator.getAllTasks().find((item) => item.id.endsWith(`/${suffix}`));
  if (!task) throw new Error(`Task with suffix "${suffix}" not found`);
  return task.id;
}

function respondForTask(
  orchestrator: Orchestrator,
  taskId: string,
  status: WorkResponse['status'],
  exitCode = 0,
): TaskState[] {
  const generation = orchestrator.getTask(taskId)?.execution.generation ?? 0;
  return orchestrator.handleWorkerResponse(makeResponse(taskId, status, generation, exitCode));
}

describe('Orchestrator launch claims', () => {
  it('startExecution returns each started task exactly once', () => {
    const { orchestrator } = makeOrchestrator();
    const plan: PlanDefinition = {
      name: 'claim-start',
      onFinish: 'none',
      tasks: [
        { id: 't1', description: 'first', command: 'echo one' },
        { id: 't2', description: 'second', command: 'echo two' },
      ],
    };

    expect(orchestrator.startExecution()).toHaveLength(0);

    orchestrator.loadPlan(plan);
    const started = orchestrator.startExecution();

    expect(started).toHaveLength(2);
    expect(new Set(started.map((task) => task.id)).size).toBe(2);
  });

  it('does not supersede an active launch claim when scheduling repeats', () => {
    const { orchestrator, persistence } = makeOrchestrator();
    orchestrator.loadPlan({
      name: 'claim-repeat',
      onFinish: 'none',
      tasks: [{ id: 't1', description: 'first', command: 'echo one' }],
    });

    const [started] = orchestrator.startExecution();
    const attemptId = started!.execution.selectedAttemptId!;
    const leaseExpiresAt = new Date(Date.now() + 60_000);
    persistence.updateAttempt(attemptId, {
      status: 'claimed',
      claimedAt: new Date(),
      lastHeartbeatAt: new Date(),
      leaseExpiresAt,
    });
    persistence.updateTask(started!.id, { status: 'pending' });
    orchestrator.syncAllFromDb();

    expect(orchestrator.startExecution()).toHaveLength(0);
    expect(persistence.loadAttempt(attemptId)?.status).toBe('claimed');
    expect(persistence.loadAttempt(attemptId)?.leaseExpiresAt).toEqual(leaseExpiresAt);
  });

  it('returns launch claims for restart/retry/recreate entrypoints', () => {
    const { orchestrator } = makeOrchestrator();
    orchestrator.loadPlan({
      name: 'claim-retry-paths',
      onFinish: 'none',
      tasks: [{ id: 't1', description: 'one', command: 'exit 1' }],
    });

    const taskId = taskIdBySuffix(orchestrator, 't1');
    const workflowId = orchestrator.getWorkflowIds()[0]!;

    orchestrator.startExecution();
    respondForTask(orchestrator, taskId, 'failed', 1);

    let started = orchestrator.retryTask(taskId);
    expect(started.map((task) => task.id)).toEqual([taskId]);

    respondForTask(orchestrator, taskId, 'failed', 1);
    started = orchestrator.retryWorkflow(workflowId);
    expect(started.map((task) => task.id)).toEqual([taskId]);

    respondForTask(orchestrator, taskId, 'failed', 1);
    started = orchestrator.recreateTask(taskId);
    expect(started.map((task) => task.id)).toEqual([taskId]);

    respondForTask(orchestrator, taskId, 'failed', 1);
    started = orchestrator.recreateWorkflow(workflowId);
    expect(started.map((task) => task.id)).toEqual([taskId]);
  });

  it('keeps recreated tasks pending until executor launch is confirmed', () => {
    const { orchestrator, persistence } = makeOrchestrator({ deferRunningUntilLaunch: true });
    orchestrator.loadPlan({
      name: 'truthful-recreate',
      onFinish: 'none',
      tasks: [{ id: 't1', description: 'one', command: 'echo one' }],
    });

    const taskId = taskIdBySuffix(orchestrator, 't1');
    const workflowId = orchestrator.getWorkflowIds()[0]!;

    let [claim] = orchestrator.startExecution();
    expect(claim!.status).toBe('pending');
    expect(persistence.loadAttempt(claim!.execution.selectedAttemptId!)?.status).toBe('claimed');
    expect(orchestrator.markTaskRunningAfterLaunch(taskId, claim!.execution.selectedAttemptId!)).toBe(true);
    respondForTask(orchestrator, taskId, 'completed');

    [claim] = orchestrator.recreateWorkflow(workflowId);
    const replacementAttemptId = claim!.execution.selectedAttemptId!;

    expect(claim!.status).toBe('pending');
    expect(orchestrator.getTask(taskId)?.status).toBe('pending');
    expect(persistence.loadAttempt(replacementAttemptId)?.status).toBe('claimed');
    expect(orchestrator.getLastInvalidationPlan()).toMatchObject({
      action: 'recreateWorkflow',
      mode: 'recreate',
      affectedTaskIds: [`__merge__${workflowId}`, taskId],
    });

    expect(orchestrator.markTaskRunningAfterLaunch(taskId, replacementAttemptId)).toBe(true);
    expect(orchestrator.getTask(taskId)?.status).toBe('running');
    expect(persistence.loadAttempt(replacementAttemptId)?.status).toBe('running');
  });

  it('rejects stale attempt completions after recreate advances lineage', () => {
    const { orchestrator } = makeOrchestrator({ deferRunningUntilLaunch: true });
    orchestrator.loadPlan({
      name: 'stale-recreate',
      onFinish: 'none',
      tasks: [{ id: 't1', description: 'one', command: 'echo one' }],
    });

    const taskId = taskIdBySuffix(orchestrator, 't1');
    const [firstClaim] = orchestrator.startExecution();
    const staleAttemptId = firstClaim!.execution.selectedAttemptId!;
    expect(orchestrator.markTaskRunningAfterLaunch(taskId, staleAttemptId)).toBe(true);

    const [replacementClaim] = orchestrator.recreateTask(taskId);
    const replacementAttemptId = replacementClaim!.execution.selectedAttemptId!;
    const generation = firstClaim!.execution.generation ?? 0;

    const staleResult = orchestrator.handleWorkerResponse({
      ...makeResponse(taskId, 'completed', generation),
      attemptId: staleAttemptId,
    });

    expect(staleResult).toEqual([]);
    expect(orchestrator.getTask(taskId)?.execution.selectedAttemptId).toBe(replacementAttemptId);
    expect(orchestrator.getTask(taskId)?.status).toBe('pending');
  });

  it('resumeWorkflow returns persisted pending launch claims', () => {
    const { orchestrator } = makeOrchestrator();
    orchestrator.loadPlan({
      name: 'claim-resume',
      onFinish: 'none',
      tasks: [{ id: 't1', description: 'one', command: 'echo one' }],
    });
    const workflowId = orchestrator.getWorkflowIds()[0]!;
    const taskId = taskIdBySuffix(orchestrator, 't1');

    const started = orchestrator.resumeWorkflow(workflowId);
    expect(started.map((task) => task.id)).toEqual([taskId]);
  });

  it('returns downstream launch claims from worker completion and approval cascades', async () => {
    const { orchestrator, persistence } = makeOrchestrator();
    orchestrator.loadPlan({
      name: 'claim-cascade',
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
    const startedAfterPrepare = respondForTask(orchestrator, prepareId, 'completed', 0);
    expect(startedAfterPrepare.map((task) => task.id)).toContain(downstreamId);

    persistence.updateTask(approvalRootId, { status: 'awaiting_approval' });
    orchestrator.syncAllFromDb();
    const startedAfterApprove = await orchestrator.approve(approvalRootId);
    expect(startedAfterApprove.map((task) => task.id)).toContain(approvalDownstreamId);
  });
});
