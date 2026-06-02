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

interface LoggedEvent {
  taskId: string;
  eventType: string;
  payload?: unknown;
}

interface LaunchDispatchRow {
  id: number;
  taskId: string;
  attemptId: string;
  workflowId: string;
  priority: 'high' | 'normal' | 'low';
  generation: number;
}

class InMemoryPersistence implements OrchestratorPersistence {
  workflows = new Map<string, { id: string; name: string; status: string; createdAt: string; updatedAt: string }>();
  tasks = new Map<string, { workflowId: string; task: TaskState }>();
  events: LoggedEvent[] = [];
  launchDispatchRows: LaunchDispatchRow[] = [];
  enqueueLaunchDispatchEnabled = false;
  private attempts = new Map<string, Attempt[]>();
  private nextDispatchId = 1;

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

  logEvent(taskId: string, eventType: string, payload?: unknown): void {
    this.events.push({ taskId, eventType, payload });
  }

  enqueueLaunchDispatch(input: {
    taskId: string;
    attemptId: string;
    workflowId: string;
    priority?: 'high' | 'normal' | 'low';
    generation: number;
  }): { id: number } {
    if (!this.enqueueLaunchDispatchEnabled) {
      throw new Error('enqueueLaunchDispatch called when not enabled');
    }
    const existing = this.launchDispatchRows.find((row) => row.attemptId === input.attemptId);
    if (existing) return { id: existing.id };
    const row: LaunchDispatchRow = {
      id: this.nextDispatchId++,
      taskId: input.taskId,
      attemptId: input.attemptId,
      workflowId: input.workflowId,
      priority: input.priority ?? 'normal',
      generation: input.generation,
    };
    this.launchDispatchRows.push(row);
    return { id: row.id };
  }
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
  opts: {
    deferRunningUntilLaunch?: boolean;
    maxConcurrency?: number;
    launchOutboxMode?: 'disabled' | 'observe' | 'active';
    enqueueLaunchDispatchEnabled?: boolean;
  } = {},
): { orchestrator: Orchestrator; persistence: InMemoryPersistence } {
  const persistence = new InMemoryPersistence();
  persistence.enqueueLaunchDispatchEnabled = opts.enqueueLaunchDispatchEnabled ?? false;
  const orchestrator = new Orchestrator({
    persistence,
    messageBus: new InMemoryBus(),
    maxConcurrency: opts.maxConcurrency ?? 4,
    deferRunningUntilLaunch: opts.deferRunningUntilLaunch,
    launchOutboxMode: opts.launchOutboxMode,
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

function seedStaleLaunchMetadata(
  persistence: InMemoryPersistence,
  taskId: string,
  status: TaskState['status'] = 'failed',
): void {
  const staleAt = new Date('2026-05-16T00:00:00.000Z');
  persistence.updateTask(taskId, {
    status,
    execution: {
      phase: 'launching',
      launchStartedAt: staleAt,
      launchCompletedAt: staleAt,
      startedAt: staleAt,
      completedAt: staleAt,
      error: 'old launch failure',
      exitCode: 1,
    },
  });
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

  it('rejects a response carrying the live attempt id but a stale executionGeneration', () => {
    const { orchestrator, persistence } = makeOrchestrator({ deferRunningUntilLaunch: true });
    orchestrator.loadPlan({
      name: 'stale-generation-live-attempt',
      onFinish: 'none',
      tasks: [{ id: 't1', description: 'one', command: 'echo one' }],
    });

    const taskId = taskIdBySuffix(orchestrator, 't1');
    const [claim] = orchestrator.startExecution();
    const attemptId = claim!.execution.selectedAttemptId!;
    expect(orchestrator.markTaskRunningAfterLaunch(taskId, attemptId)).toBe(true);

    // Advance the live execution generation while keeping the SAME selected
    // attempt id, and pin a known branch/workspacePath so we can prove the
    // stale response never overwrites live lineage.
    const staleGeneration = orchestrator.getTask(taskId)?.execution.generation ?? 0;
    const liveGeneration = staleGeneration + 1;
    persistence.updateTask(taskId, {
      execution: { generation: liveGeneration, branch: 'live-branch', workspacePath: '/live/ws' },
    });
    orchestrator.syncAllFromDb();

    const liveTask = orchestrator.getTask(taskId)!;
    expect(liveTask.execution.selectedAttemptId).toBe(attemptId);
    expect(liveTask.execution.generation).toBe(liveGeneration);

    // Response presents the live attempt id (passes the attempt guard) but a
    // stale generation — both fields are present, so both must match.
    const staleResult = orchestrator.handleWorkerResponse({
      ...makeResponse(taskId, 'completed', staleGeneration),
      attemptId,
      outputs: { exitCode: 0, branch: 'stale-branch' },
    });

    expect(staleResult).toEqual([]);
    const afterTask = orchestrator.getTask(taskId)!;
    expect(afterTask.status).toBe('running');
    expect(afterTask.execution.selectedAttemptId).toBe(attemptId);
    expect(afterTask.execution.branch).toBe('live-branch');
    expect(afterTask.execution.workspacePath).toBe('/live/ws');
  });

  it('clears stale launch metadata from dependency-blocked tasks during recreateWorkflow reset', () => {
    const { orchestrator, persistence } = makeOrchestrator();
    orchestrator.loadPlan({
      name: 'clear-recreate-workflow-launch-metadata',
      onFinish: 'none',
      tasks: [
        { id: 'a', description: 'upstream', command: 'echo a' },
        { id: 'b', description: 'downstream', command: 'echo b', dependencies: ['a'] },
      ],
    });

    const workflowId = orchestrator.getWorkflowIds()[0]!;
    const upstreamId = taskIdBySuffix(orchestrator, 'a');
    const downstreamId = taskIdBySuffix(orchestrator, 'b');
    seedStaleLaunchMetadata(persistence, upstreamId, 'completed');
    seedStaleLaunchMetadata(persistence, downstreamId, 'failed');
    orchestrator.syncAllFromDb();

    orchestrator.recreateWorkflow(workflowId);

    const downstream = orchestrator.getTask(downstreamId)!;
    expect(downstream.status).toBe('pending');
    expect(downstream.execution.phase).toBeUndefined();
    expect(downstream.execution.launchStartedAt).toBeUndefined();
    expect(downstream.execution.launchCompletedAt).toBeUndefined();
  });

  it('clears stale launch metadata from downstream tasks during recreateTask reset', () => {
    const { orchestrator, persistence } = makeOrchestrator();
    orchestrator.loadPlan({
      name: 'clear-recreate-task-launch-metadata',
      onFinish: 'none',
      tasks: [
        { id: 'a', description: 'upstream', command: 'echo a' },
        { id: 'b', description: 'downstream', command: 'echo b', dependencies: ['a'] },
      ],
    });

    const upstreamId = taskIdBySuffix(orchestrator, 'a');
    const downstreamId = taskIdBySuffix(orchestrator, 'b');
    seedStaleLaunchMetadata(persistence, upstreamId, 'failed');
    seedStaleLaunchMetadata(persistence, downstreamId, 'failed');
    orchestrator.syncAllFromDb();

    orchestrator.recreateTask(upstreamId);

    const downstream = orchestrator.getTask(downstreamId)!;
    expect(downstream.status).toBe('pending');
    expect(downstream.execution.phase).toBeUndefined();
    expect(downstream.execution.launchStartedAt).toBeUndefined();
    expect(downstream.execution.launchCompletedAt).toBeUndefined();
  });

  it('clears stale launch metadata during retryWorkflow reset', () => {
    const { orchestrator, persistence } = makeOrchestrator();
    orchestrator.loadPlan({
      name: 'clear-retry-workflow-launch-metadata',
      onFinish: 'none',
      tasks: [
        { id: 'a', description: 'upstream', command: 'echo a' },
        { id: 'b', description: 'downstream', command: 'echo b', dependencies: ['a'] },
      ],
    });

    const workflowId = orchestrator.getWorkflowIds()[0]!;
    const downstreamId = taskIdBySuffix(orchestrator, 'b');
    seedStaleLaunchMetadata(persistence, downstreamId, 'failed');
    orchestrator.syncAllFromDb();

    orchestrator.retryWorkflow(workflowId);

    const downstream = orchestrator.getTask(downstreamId)!;
    expect(downstream.status).toBe('pending');
    expect(downstream.execution.phase).toBeUndefined();
    expect(downstream.execution.launchStartedAt).toBeUndefined();
    expect(downstream.execution.launchCompletedAt).toBeUndefined();
  });

  it('ignores responses for a selected attempt row that has been superseded', () => {
    const { orchestrator, persistence } = makeOrchestrator();
    orchestrator.loadPlan({
      name: 'superseded-response',
      onFinish: 'none',
      tasks: [{ id: 't1', description: 'one', command: 'echo one' }],
    });

    const taskId = taskIdBySuffix(orchestrator, 't1');
    const [started] = orchestrator.startExecution();
    const attemptId = started!.execution.selectedAttemptId!;
    persistence.updateAttempt(attemptId, { status: 'superseded' });

    const result = orchestrator.handleWorkerResponse({
      ...makeResponse(taskId, 'completed', started!.execution.generation ?? 0),
      attemptId,
    });

    expect(result).toEqual([]);
    expect(orchestrator.getTask(taskId)?.status).toBe('running');
    expect(persistence.loadAttempt(attemptId)?.status).toBe('superseded');
  });

  it('rejects launch finalization for a superseded selected attempt', () => {
    const { orchestrator, persistence } = makeOrchestrator({ deferRunningUntilLaunch: true });
    orchestrator.loadPlan({
      name: 'superseded-launch',
      onFinish: 'none',
      tasks: [{ id: 't1', description: 'one', command: 'echo one' }],
    });

    const taskId = taskIdBySuffix(orchestrator, 't1');
    const [claim] = orchestrator.startExecution();
    const attemptId = claim!.execution.selectedAttemptId!;
    persistence.updateAttempt(attemptId, { status: 'superseded' });

    expect(orchestrator.markTaskRunningAfterLaunch(taskId, attemptId)).toBe(false);
    expect(orchestrator.getTask(taskId)?.status).toBe('pending');
    expect(persistence.loadAttempt(attemptId)?.status).toBe('superseded');
  });

  it('creates a fresh attempt instead of claiming a superseded queued job', () => {
    const { orchestrator, persistence } = makeOrchestrator({ maxConcurrency: 1 });
    orchestrator.loadPlan({
      name: 'superseded-queued',
      onFinish: 'none',
      tasks: [
        { id: 't1', description: 'first', command: 'echo one' },
        { id: 't2', description: 'second', command: 'echo two' },
      ],
    });

    const [started] = orchestrator.startExecution();
    const firstTaskId = taskIdBySuffix(orchestrator, 't1');
    const secondTaskId = taskIdBySuffix(orchestrator, 't2');
    expect(started!.id).toBe(firstTaskId);

    const queuedAttemptId = orchestrator.getTask(secondTaskId)!.execution.selectedAttemptId!;
    persistence.updateAttempt(queuedAttemptId, { status: 'superseded' });

    orchestrator.handleWorkerResponse({
      ...makeResponse(firstTaskId, 'completed', started!.execution.generation ?? 0),
      attemptId: started!.execution.selectedAttemptId,
    });

    const secondTask = orchestrator.getTask(secondTaskId)!;
    const freshAttemptId = secondTask.execution.selectedAttemptId!;
    expect(secondTask.status).toBe('running');
    expect(freshAttemptId).not.toBe(queuedAttemptId);
    expect(persistence.loadAttempt(queuedAttemptId)?.status).toBe('superseded');
    expect(persistence.loadAttempt(freshAttemptId)?.status).toBe('running');
    expect(persistence.loadAttempt(freshAttemptId)?.supersedesAttemptId).toBe(queuedAttemptId);
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

  describe('launch-outbox observer wiring (Phase A)', () => {
    function loadPlanForLaunchOutbox(orchestrator: Orchestrator): { taskId: string } {
      orchestrator.loadPlan({
        name: 'launch-outbox-observer',
        onFinish: 'none',
        tasks: [{ id: 't1', description: 'one', command: 'echo one' }],
      });
      return { taskId: taskIdBySuffix(orchestrator, 't1') };
    }

    it("does not write outbox rows when launchOutboxMode='disabled'", () => {
      const { orchestrator, persistence } = makeOrchestrator({
        deferRunningUntilLaunch: true,
        enqueueLaunchDispatchEnabled: true,
        launchOutboxMode: 'disabled',
      });
      loadPlanForLaunchOutbox(orchestrator);
      orchestrator.startExecution();

      expect(persistence.launchDispatchRows).toEqual([]);
      expect(
        persistence.events.find((event) => event.eventType === 'task.dispatch_enqueued'),
      ).toBeUndefined();
      expect(
        persistence.events.find((event) => event.eventType === 'task.launch_claimed'),
      ).toBeDefined();
    });

    it("writes one outbox row per claimed attempt when launchOutboxMode='observe' and still emits task.launch_claimed", () => {
      const { orchestrator, persistence } = makeOrchestrator({
        deferRunningUntilLaunch: true,
        enqueueLaunchDispatchEnabled: true,
        launchOutboxMode: 'observe',
        maxConcurrency: 4,
      });
      orchestrator.loadPlan({
        name: 'launch-outbox-observer',
        onFinish: 'none',
        tasks: [
          { id: 't1', description: 'one', command: 'echo one' },
          { id: 't2', description: 'two', command: 'echo two' },
        ],
      });
      const started = orchestrator.startExecution();

      expect(started).toHaveLength(2);
      expect(persistence.launchDispatchRows).toHaveLength(2);
      const claimedAttemptIds = new Set(started.map((task) => task.execution.selectedAttemptId));
      const dispatchedAttemptIds = new Set(
        persistence.launchDispatchRows.map((row) => row.attemptId),
      );
      expect(dispatchedAttemptIds).toEqual(claimedAttemptIds);
      expect(
        persistence.events.filter((event) => event.eventType === 'task.launch_claimed'),
      ).toHaveLength(2);
      const enqueueEvents = persistence.events.filter(
        (event) => event.eventType === 'task.dispatch_enqueued',
      );
      expect(enqueueEvents).toHaveLength(2);
      for (const event of enqueueEvents) {
        const payload = event.payload as { dispatchId?: number };
        expect(typeof payload?.dispatchId).toBe('number');
      }
    });

    it("treats launchOutboxMode='active' the same as observe in Phase A (active behavior lands in CB)", () => {
      const { orchestrator, persistence } = makeOrchestrator({
        deferRunningUntilLaunch: true,
        enqueueLaunchDispatchEnabled: true,
        launchOutboxMode: 'active',
      });
      loadPlanForLaunchOutbox(orchestrator);
      orchestrator.startExecution();

      expect(persistence.launchDispatchRows).toHaveLength(1);
      expect(
        persistence.events.find((event) => event.eventType === 'task.dispatch_enqueued'),
      ).toBeDefined();
    });

    it("tolerates missing enqueueLaunchDispatch without throwing when launchOutboxMode='observe'", () => {
      const { orchestrator, persistence } = makeOrchestrator({
        deferRunningUntilLaunch: true,
        enqueueLaunchDispatchEnabled: false,
        launchOutboxMode: 'observe',
      });
      (persistence as unknown as { enqueueLaunchDispatch?: unknown }).enqueueLaunchDispatch = undefined;
      loadPlanForLaunchOutbox(orchestrator);
      expect(() => orchestrator.startExecution()).not.toThrow();
      expect(persistence.launchDispatchRows).toEqual([]);
    });
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
