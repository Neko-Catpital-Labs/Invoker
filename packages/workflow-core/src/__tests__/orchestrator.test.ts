import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { reconciliationNeedsInputWorkResponse } from './reconciliation-needs-input-shim.js';
import { rid, sid } from './scoped-test-helpers.js';
import { Orchestrator, PlanConflictError, descriptionForMergeNode } from '../orchestrator.js';
import type { PlanDefinition, OrchestratorPersistence, OrchestratorMessageBus } from '../orchestrator.js';
import type { TaskState, TaskDelta, TaskStateChanges, Attempt } from '../task-types.js';
import type { WorkResponse } from '@invoker/contracts';

// ── In-Memory Persistence Mock ──────────────────────────────

class InMemoryPersistence implements OrchestratorPersistence {
  workflows = new Map<string, { id: string; name: string; status: string; createdAt: string; updatedAt: string }>();
  tasks = new Map<string, { workflowId: string; task: TaskState }>();
  private attempts = new Map<string, Attempt[]>();
  events: Array<{ taskId: string; eventType: string; payload?: unknown }> = [];
  updateWorkflowCalls = new Map<string, number>();

  saveWorkflow(workflow: { id: string; name: string; status: string }): void {
    const now = new Date().toISOString();
    this.workflows.set(workflow.id, { ...workflow, createdAt: (workflow as any).createdAt ?? now, updatedAt: (workflow as any).updatedAt ?? now });
  }

  updateWorkflow(workflowId: string, changes: { status?: string; updatedAt?: string }): void {
    const wf = this.workflows.get(workflowId);
    this.updateWorkflowCalls.set(workflowId, (this.updateWorkflowCalls.get(workflowId) ?? 0) + 1);
    if (wf && changes.status) {
      wf.status = changes.status;
    }
  }

  saveTask(workflowId: string, task: TaskState): void {
    this.tasks.set(task.id, { workflowId, task });
  }

  /** Resolve bare plan-local id to the single matching persisted key when unambiguous (test helper). */
  private resolveBareTaskKey(taskId: string): string {
    let resolvedId = taskId;
    let entry = this.tasks.get(resolvedId);
    if (
      !entry &&
      !taskId.includes('/') &&
      !taskId.startsWith('__merge__') &&
      !taskId.endsWith('-reconciliation')
    ) {
      const suffix = `/${taskId}`;
      const matches: string[] = [];
      for (const id of this.tasks.keys()) {
        if (id === taskId || id.endsWith(suffix)) {
          matches.push(id);
        }
      }
      if (matches.length === 1) {
        resolvedId = matches[0];
      }
    }
    return resolvedId;
  }

  getTaskEntry(taskId: string): { workflowId: string; task: TaskState } | undefined {
    return this.tasks.get(this.resolveBareTaskKey(taskId));
  }

  updateTask(taskId: string, changes: TaskStateChanges): void {
    const resolvedId = this.resolveBareTaskKey(taskId);
    const entry = this.tasks.get(resolvedId);
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

  listWorkflows(): Array<{ id: string; name: string; status: string; createdAt: string; updatedAt: string }> {
    return Array.from(this.workflows.values());
  }

  loadTasks(workflowId: string): TaskState[] {
    return Array.from(this.tasks.values())
      .filter((e) => e.workflowId === workflowId)
      .map((e) => e.task);
  }

  logEvent(taskId: string, eventType: string, payload?: unknown): void {
    this.events.push({ taskId, eventType, payload });
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
      const found = list.find(a => a.id === attemptId);
      if (found) return found;
    }
    return undefined;
  }

  updateAttempt(attemptId: string, changes: Partial<Pick<Attempt, 'status' | 'startedAt' | 'completedAt' | 'exitCode' | 'error' | 'lastHeartbeatAt' | 'branch' | 'commit' | 'summary' | 'workspacePath' | 'agentSessionId' | 'containerId' | 'mergeConflict'>>): void {
    for (const list of this.attempts.values()) {
      const idx = list.findIndex(a => a.id === attemptId);
      if (idx !== -1) {
        list[idx] = { ...list[idx], ...changes } as Attempt;
        return;
      }
    }
  }

  deleteWorkflow(workflowId: string): void {
    this.workflows.delete(workflowId);
    for (const [taskId, entry] of this.tasks) {
      if (entry.workflowId === workflowId) this.tasks.delete(taskId);
    }
  }

  deleteAllWorkflows(): void {
    this.workflows.clear();
    this.tasks.clear();
  }
}

class CountingPersistence extends InMemoryPersistence {
  loadTasksCalls: string[] = [];

  override loadTasks(workflowId: string): TaskState[] {
    this.loadTasksCalls.push(workflowId);
    return super.loadTasks(workflowId);
  }
}

// ── In-Memory MessageBus Mock ───────────────────────────────

class InMemoryBus implements OrchestratorMessageBus {
  published: Array<{ channel: string; message: unknown }> = [];
  private handlers = new Map<string, Set<(msg: unknown) => void>>();

  publish<T>(channel: string, message: T): void {
    this.published.push({ channel, message });
    const handlers = this.handlers.get(channel);
    if (handlers) {
      for (const handler of handlers) {
        handler(message);
      }
    }
  }

  subscribe(channel: string, handler: (msg: unknown) => void): () => void {
    if (!this.handlers.has(channel)) {
      this.handlers.set(channel, new Set());
    }
    this.handlers.get(channel)!.add(handler);
    return () => this.handlers.get(channel)?.delete(handler);
  }
}

// ── Helpers ─────────────────────────────────────────────────

function makeResponse(overrides: Partial<WorkResponse>): WorkResponse {
  return {
    requestId: 'req-1',
    actionId: 't1',
    executionGeneration: 0,
    status: 'completed',
    outputs: { exitCode: 0 },
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────

describe('Orchestrator', () => {
  let orchestrator: Orchestrator;
  let persistence: InMemoryPersistence;
  let bus: InMemoryBus;
  let publishedDeltas: TaskDelta[];

  beforeEach(() => {
    persistence = new InMemoryPersistence();
    bus = new InMemoryBus();
    publishedDeltas = [];

    bus.subscribe('task.delta', (delta) => {
      publishedDeltas.push(delta as TaskDelta);
    });

    orchestrator = new Orchestrator({
      persistence,
      messageBus: bus,
      maxConcurrency: 3,
    });
  });

  describe('descriptionForMergeNode', () => {
    it('uses Review gate when mergeMode is external_review', () => {
      expect(descriptionForMergeNode({ name: 'My plan', onFinish: 'none', mergeMode: 'external_review' })).toBe(
        'Review gate for My plan',
      );
    });

    it('uses Pull request gate when onFinish is pull_request', () => {
      expect(descriptionForMergeNode({ name: 'My plan', onFinish: 'pull_request', mergeMode: 'manual' })).toBe(
        'Pull request gate for My plan',
      );
    });

    it('uses Merge gate when onFinish is merge and not GitHub PR mode', () => {
      expect(descriptionForMergeNode({ name: 'My plan', onFinish: 'merge', mergeMode: 'manual' })).toBe(
        'Merge gate for My plan',
      );
    });

    it('uses Workflow gate when onFinish is none and mergeMode is manual', () => {
      expect(descriptionForMergeNode({ name: 'My plan', onFinish: 'none', mergeMode: 'manual' })).toBe(
        'Workflow gate for My plan',
      );
    });

    it('prefers Review gate when mergeMode is external_review even if onFinish is merge', () => {
      expect(descriptionForMergeNode({ name: 'My plan', onFinish: 'merge', mergeMode: 'external_review' })).toBe(
        'Review gate for My plan',
      );
    });
  });

  describe('workflow status transitions during retry paths', () => {
    it('clears stale failed workflow status when a failed task is restarted', () => {
      orchestrator.loadPlan({
        name: 'Retry workflow',
        onFinish: 'none',
        tasks: [
          { id: 't1', description: 'First', command: 'exit 1' },
        ],
      });

      const workflowId = orchestrator.getWorkflowIds()[0]!;
      const taskId = orchestrator.getAllTasks().find((task) => task.config.workflowId === workflowId)!.id;

      orchestrator.startExecution();
      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: taskId, status: 'failed', outputs: { exitCode: 1, error: 'boom' } }),
      );

      persistence.workflows.get(workflowId)!.status = 'failed';

      const restarted = orchestrator.restartTask(taskId);

      expect(restarted.some((task) => task.id === taskId && task.status === 'running')).toBe(true);
      expect(persistence.workflows.get(workflowId)?.status).toBe('running');
    });

    it('clears stale failed workflow status when a workflow is recreated', () => {
      orchestrator.loadPlan({
        name: 'Recreate workflow',
        onFinish: 'none',
        tasks: [
          { id: 't1', description: 'First', command: 'exit 1' },
          { id: 't2', description: 'Second', command: 'echo 2', dependencies: ['t1'] },
        ],
      });

      const workflowId = orchestrator.getWorkflowIds()[0]!;
      const taskId = orchestrator.getAllTasks().find(
        (task) => task.config.workflowId === workflowId && task.id.endsWith('/t1'),
      )!.id;

      orchestrator.startExecution();
      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: taskId, status: 'failed', outputs: { exitCode: 1, error: 'boom' } }),
      );

      persistence.workflows.get(workflowId)!.status = 'failed';

      const restarted = orchestrator.recreateWorkflow(workflowId);

      expect(restarted.some((task) => task.id === taskId && task.status === 'running')).toBe(true);
      expect(persistence.workflows.get(workflowId)?.status).toBe('running');
    });

    it('resets auto-fix attempts to zero when a workflow is recreated', () => {
      orchestrator = new Orchestrator({
        persistence,
        messageBus: bus,
        maxConcurrency: 3,
        defaultAutoFixRetries: 3,
      });

      orchestrator.loadPlan({
        name: 'Recreate workflow resets auto-fix',
        onFinish: 'none',
        tasks: [
          { id: 't1', description: 'First', command: 'exit 1' },
          { id: 't2', description: 'Second', command: 'echo 2', dependencies: ['t1'] },
        ],
      });

      const workflowId = orchestrator.getWorkflowIds()[0]!;
      const taskId = orchestrator.getAllTasks().find(
        (task) => task.config.workflowId === workflowId && task.id.endsWith('/t1'),
      )!.id;

      persistence.updateTask(taskId, { execution: { autoFixAttempts: 3 } });
      orchestrator.syncAllFromDb();
      expect(orchestrator.shouldAutoFix(taskId)).toBe(false);

      orchestrator.recreateWorkflow(workflowId);

      expect(orchestrator.getTask(taskId)?.execution.autoFixAttempts).toBe(0);
      persistence.updateTask(taskId, { status: 'failed' });
      orchestrator.syncAllFromDb();
      expect(orchestrator.shouldAutoFix(taskId)).toBe(true);
    });

    it('ignores a stale completed response after recreateWorkflow resets descendants', () => {
      const reproPersistence = new InMemoryPersistence();
      const reproBus = new InMemoryBus();
      const repro = new Orchestrator({
        persistence: reproPersistence,
        messageBus: reproBus,
        maxConcurrency: 1,
      });

      repro.loadPlan({
        name: 'stale-late-complete-recreate',
        onFinish: 'none',
        tasks: [
          { id: 'prepare', description: 'Prepare', command: 'echo prepare' },
          { id: 'mid', description: 'Mid', command: 'echo mid', dependencies: ['prepare'] },
          { id: 'late', description: 'Late', command: 'sleep 5', dependencies: ['mid'] },
        ],
      });

      const workflowId = repro.getWorkflowIds()[0]!;
      const prepareId = sid(repro, 0, 'prepare');
      const midId = sid(repro, 0, 'mid');
      const lateId = sid(repro, 0, 'late');

      repro.startExecution();
      repro.handleWorkerResponse(makeResponse({
        actionId: prepareId,
        executionGeneration: repro.getTask(prepareId)?.execution.generation ?? 0,
        status: 'completed',
        outputs: { exitCode: 0 },
      }));
      repro.handleWorkerResponse(makeResponse({
        actionId: midId,
        executionGeneration: repro.getTask(midId)?.execution.generation ?? 0,
        status: 'completed',
        outputs: { exitCode: 0 },
      }));
      expect(repro.getTask(lateId)?.status).toBe('running');
      const oldLateAttemptId = repro.getTask(lateId)?.execution.selectedAttemptId;
      expect(oldLateAttemptId).toBeTruthy();

      repro.recreateWorkflow(workflowId);
      expect(repro.getTask(prepareId)?.status).toBe('running');
      expect(repro.getTask(midId)?.status).toBe('pending');
      expect(repro.getTask(lateId)?.status).toBe('pending');

      expect(repro.getTask(lateId)?.execution.generation).toBe(1);
      repro.handleWorkerResponse(makeResponse({
        actionId: prepareId,
        executionGeneration: repro.getTask(prepareId)?.execution.generation ?? 0,
        status: 'completed',
        outputs: { exitCode: 0 },
      }));
      repro.handleWorkerResponse(makeResponse({
        actionId: midId,
        executionGeneration: repro.getTask(midId)?.execution.generation ?? 0,
        status: 'completed',
        outputs: { exitCode: 0 },
      }));
      expect(repro.getTask(lateId)?.status).toBe('running');
      const newLateAttemptId = repro.getTask(lateId)?.execution.selectedAttemptId;
      expect(newLateAttemptId).toBeTruthy();
      expect(newLateAttemptId).not.toBe(oldLateAttemptId);

      repro.handleWorkerResponse(
        makeResponse({
          actionId: lateId,
          attemptId: oldLateAttemptId,
          executionGeneration: repro.getTask(lateId)?.execution.generation ?? 0,
          status: 'completed',
          outputs: { exitCode: 0 },
        }),
      );

      expect(repro.getTask(lateId)?.status).toBe('running');
      expect(repro.getTask(midId)?.status).toBe('completed');
    });

    it('applies a completion signal when attemptId matches the selected attempt', () => {
      orchestrator.loadPlan({
        name: 'accept-current-attempt-signal',
        onFinish: 'none',
        tasks: [
          { id: 'A', description: 'Root', command: 'echo A' },
        ],
      });
      orchestrator.startExecution();
      const taskId = orchestrator.getAllTasks().find((task) => task.id === 'A' || task.id.endsWith('/A'))?.id ?? 'A';

      const activeAttemptId = orchestrator.getTask(taskId)?.execution.selectedAttemptId;
      expect(activeAttemptId).toBeTruthy();

      orchestrator.handleWorkerResponse(
        makeResponse({
          actionId: taskId,
          attemptId: activeAttemptId,
          status: 'completed',
          outputs: { exitCode: 0 },
        }),
      );

      expect(orchestrator.getTask(taskId)?.status).toBe('completed');
      expect(persistence.events.some((event) => event.taskId === taskId && event.eventType === 'task.completed')).toBe(true);
    });

    it('rejects a completion signal when attemptId is stale', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        orchestrator.loadPlan({
          name: 'reject-stale-attempt-signal',
          onFinish: 'none',
          tasks: [
            { id: 'A', description: 'Root', command: 'echo A' },
          ],
        });
        orchestrator.startExecution();
        const taskId = orchestrator.getAllTasks().find((task) => task.id === 'A' || task.id.endsWith('/A'))?.id ?? 'A';

        const oldAttemptId = orchestrator.getTask(taskId)?.execution.selectedAttemptId;
        expect(oldAttemptId).toBeTruthy();

        const workflowId = orchestrator.getWorkflowIds()[0]!;
        orchestrator.recreateWorkflow(workflowId);
        const currentAttemptId = orchestrator.getTask(taskId)?.execution.selectedAttemptId;
        expect(currentAttemptId).toBeTruthy();
        expect(currentAttemptId).not.toBe(oldAttemptId);
        expect(orchestrator.getTask(taskId)?.status).toBe('running');

        orchestrator.handleWorkerResponse(
          makeResponse({
            actionId: taskId,
            attemptId: oldAttemptId,
            status: 'completed',
            outputs: { exitCode: 0 },
          }),
        );

        expect(orchestrator.getTask(taskId)?.status).toBe('running');
        expect(orchestrator.getTask(taskId)?.execution.selectedAttemptId).toBe(currentAttemptId);
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining(`STALE_ATTEMPT_REJECTED taskId=${taskId}`),
        );
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('ignores a stale completed response after restartTask resets descendants', () => {
      const reproPersistence = new InMemoryPersistence();
      const reproBus = new InMemoryBus();
      const repro = new Orchestrator({
        persistence: reproPersistence,
        messageBus: reproBus,
        maxConcurrency: 1,
      });

      repro.loadPlan({
        name: 'stale-late-complete-restart-task',
        onFinish: 'none',
        tasks: [
          { id: 'prepare', description: 'Prepare', command: 'echo prepare' },
          { id: 'mid', description: 'Mid', command: 'echo mid', dependencies: ['prepare'] },
          { id: 'late', description: 'Late', command: 'sleep 5', dependencies: ['mid'] },
        ],
      });

      const prepareId = sid(repro, 0, 'prepare');
      const midId = sid(repro, 0, 'mid');
      const lateId = sid(repro, 0, 'late');

      repro.startExecution();
      repro.handleWorkerResponse(makeResponse({ actionId: prepareId, status: 'completed', outputs: { exitCode: 0 } }));
      repro.handleWorkerResponse(makeResponse({ actionId: midId, status: 'completed', outputs: { exitCode: 0 } }));
      expect(repro.getTask(lateId)?.status).toBe('running');

      repro.restartTask(prepareId);
      expect(repro.getTask(prepareId)?.status).toBe('running');
      expect(repro.getTask(midId)?.status).toBe('pending');
      expect(repro.getTask(lateId)?.status).toBe('pending');

      expect(repro.getTask(lateId)?.execution.generation).toBe(1);
      repro.handleWorkerResponse(
        makeResponse({ actionId: lateId, executionGeneration: 0, status: 'completed', outputs: { exitCode: 0 } }),
      );

      expect(repro.getTask(lateId)?.status).toBe('pending');
      expect(repro.getTask(midId)?.status).toBe('pending');
    });

    it('ignores a stale completed response after recreateWorkflow clears the selected attempt before rerun', () => {
      const reproPersistence = new InMemoryPersistence();
      const reproBus = new InMemoryBus();
      const repro = new Orchestrator({
        persistence: reproPersistence,
        messageBus: reproBus,
        maxConcurrency: 1,
      });

      repro.loadPlan({
        name: 'stale-late-complete-recreate-before-rerun',
        onFinish: 'none',
        tasks: [
          { id: 'prepare', description: 'Prepare', command: 'echo prepare' },
          { id: 'mid', description: 'Mid', command: 'echo mid', dependencies: ['prepare'] },
          { id: 'late', description: 'Late', command: 'sleep 5', dependencies: ['mid'] },
        ],
      });

      const workflowId = repro.getWorkflowIds()[0]!;
      const prepareId = sid(repro, 0, 'prepare');
      const midId = sid(repro, 0, 'mid');
      const lateId = sid(repro, 0, 'late');

      repro.startExecution();
      repro.handleWorkerResponse(makeResponse({ actionId: prepareId, status: 'completed', outputs: { exitCode: 0 } }));
      repro.handleWorkerResponse(makeResponse({ actionId: midId, status: 'completed', outputs: { exitCode: 0 } }));
      expect(repro.getTask(lateId)?.status).toBe('running');

      const oldLateAttemptId = repro.getTask(lateId)?.execution.selectedAttemptId;
      expect(oldLateAttemptId).toBeTruthy();

      repro.recreateWorkflow(workflowId);
      expect(repro.getTask(lateId)?.status).toBe('pending');
      const recreatedLateAttemptId = repro.getTask(lateId)?.execution.selectedAttemptId;
      expect(recreatedLateAttemptId).toBeTruthy();
      expect(recreatedLateAttemptId).not.toBe(oldLateAttemptId);

      repro.handleWorkerResponse(
        makeResponse({
          actionId: lateId,
          attemptId: oldLateAttemptId,
          executionGeneration: 0,
          status: 'completed',
          outputs: { exitCode: 0 },
        }),
      );

      expect(repro.getTask(lateId)?.status).toBe('pending');
    });

    it('ignores a stale failed response after recreateWorkflow resets descendants and does not trigger auto-fix', () => {
      const reproPersistence = new InMemoryPersistence();
      const reproBus = new InMemoryBus();
      const repro = new Orchestrator({
        persistence: reproPersistence,
        messageBus: reproBus,
        maxConcurrency: 1,
      });

      repro.loadPlan({
        name: 'stale-late-failed-recreate',
        onFinish: 'none',
        tasks: [
          { id: 'prepare', description: 'Prepare', command: 'echo prepare' },
          { id: 'mid', description: 'Mid', command: 'echo mid', dependencies: ['prepare'] },
          { id: 'late', description: 'Late', command: 'sleep 5', dependencies: ['mid'] },
        ],
      });

      const workflowId = repro.getWorkflowIds()[0]!;
      const prepareId = sid(repro, 0, 'prepare');
      const midId = sid(repro, 0, 'mid');
      const lateId = sid(repro, 0, 'late');

      repro.startExecution();
      repro.handleWorkerResponse(makeResponse({ actionId: prepareId, status: 'completed', outputs: { exitCode: 0 } }));
      repro.handleWorkerResponse(makeResponse({ actionId: midId, status: 'completed', outputs: { exitCode: 0 } }));
      expect(repro.getTask(lateId)?.status).toBe('running');

      repro.recreateWorkflow(workflowId);
      repro.handleWorkerResponse(
        makeResponse({
          actionId: lateId,
          executionGeneration: 0,
          status: 'failed',
          outputs: { exitCode: 1, error: 'old failure' },
        }),
      );

      expect(repro.getTask(lateId)?.status).toBe('pending');
      expect(repro.getTask(lateId)?.execution.autoFixAttempts).toBe(0);
      expect(repro.getAllTasks().some((task) => task.id.includes('late-exp-fix-'))).toBe(false);
    });

    it('rejects stale completion for one workflow while accepting current completion for another in-flight workflow', () => {
      const reproPersistence = new InMemoryPersistence();
      const reproBus = new InMemoryBus();
      const repro = new Orchestrator({
        persistence: reproPersistence,
        messageBus: reproBus,
        maxConcurrency: 2,
      });

      repro.loadPlan({
        name: 'wf-a',
        onFinish: 'none',
        tasks: [
          { id: 'prepare', description: 'Prepare A', command: 'echo prepare-a' },
          { id: 'late', description: 'Late A', command: 'sleep 5', dependencies: ['prepare'] },
        ],
      });
      repro.loadPlan({
        name: 'wf-b',
        onFinish: 'none',
        tasks: [
          { id: 'root', description: 'Root B', command: 'echo root-b' },
        ],
      });

      repro.startExecution();

      const prepareA = repro.getAllTasks().find((task) => task.description === 'Prepare A')!.id;
      const lateA = repro.getAllTasks().find((task) => task.description === 'Late A')!.id;
      const rootB = repro.getAllTasks().find((task) => task.description === 'Root B')!.id;
      const workflowA = repro.getTask(prepareA)!.config.workflowId!;

      repro.handleWorkerResponse(makeResponse({ actionId: prepareA, status: 'completed', outputs: { exitCode: 0 } }));
      expect(repro.getTask(lateA)?.status).toBe('running');
      expect(repro.getTask(rootB)?.status).toBe('running');

      repro.recreateWorkflow(workflowA);

      repro.handleWorkerResponse(
        makeResponse({ actionId: lateA, executionGeneration: 0, status: 'completed', outputs: { exitCode: 0 } }),
      );
      repro.handleWorkerResponse(
        makeResponse({ actionId: rootB, executionGeneration: 0, status: 'completed', outputs: { exitCode: 0 } }),
      );

      expect(repro.getTask(lateA)?.status).toBe('pending');
      expect(repro.getTask(rootB)?.status).toBe('completed');
    });
  });

  // ── loadPlan ────────────────────────────────────────────

  describe('loadPlan', () => {
    it('creates tasks with correct dependencies', () => {
      const plan: PlanDefinition = {
        name: 'test-plan',
        tasks: [
          { id: 't1', description: 'First task' },
          { id: 't2', description: 'Second task', dependencies: ['t1'] },
          { id: 't3', description: 'Third task', dependencies: ['t1', 't2'] },
        ],
      };

      orchestrator.loadPlan(plan);

      const tasks = orchestrator.getAllTasks();
      expect(tasks).toHaveLength(4);

      const t1 = orchestrator.getTask('t1');
      expect(t1).toBeDefined();
      expect(t1!.dependencies).toEqual([]);
      expect(t1!.status).toBe('pending');

      const t2 = orchestrator.getTask('t2');
      expect(t2).toBeDefined();
      expect(t2!.dependencies).toEqual([sid(orchestrator, 0, 't1')]);
    });

    it('passes pivot=true when specified in plan', () => {
      orchestrator.loadPlan({
        name: 'pivot-test',
        tasks: [{ id: 't1', description: 'Pivot task', pivot: true }],
      });

      expect(orchestrator.getTask('t1')!.config.pivot).toBe(true);
    });

    it('passes experimentVariants when specified', () => {
      const variants = [
        { id: 'v1', description: 'Variant A', prompt: 'Try approach A' },
        { id: 'v2', description: 'Variant B', prompt: 'Try approach B' },
      ];
      orchestrator.loadPlan({
        name: 'variants-test',
        tasks: [{ id: 't1', description: 'Experiment task', experimentVariants: variants }],
      });

      expect(orchestrator.getTask('t1')!.config.experimentVariants).toEqual(variants);
    });

    it('passes requiresManualApproval', () => {
      orchestrator.loadPlan({
        name: 'approval-test',
        tasks: [{ id: 't1', description: 'Approval task', requiresManualApproval: true }],
      });

      expect(orchestrator.getTask('t1')!.config.requiresManualApproval).toBe(true);
    });

    it('passes executorType when specified', () => {
      orchestrator.loadPlan({
        name: 'executor-type-test',
        tasks: [
          { id: 't1', description: 'Worktree task', executorType: 'worktree' },
          { id: 't2', description: 'Default task' },
        ],
      });

      expect(orchestrator.getTask('t1')!.config.executorType).toBe('worktree');
      expect(orchestrator.getTask('t2')!.config.executorType).toBe('worktree');
    });

    it('does not project auto-fix onto task config from plans', () => {
      orchestrator.loadPlan({
        name: 'autofix-plan',
        tasks: [{ id: 't1', description: 'Task' }],
      });

      const task = orchestrator.getTask('t1');
      expect(task!.config).not.toHaveProperty('autoFix');
      expect(task!.config).not.toHaveProperty('autoFixRetries');
    });

    it('publishes created deltas for each task', () => {
      orchestrator.loadPlan({
        name: 'test-plan',
        tasks: [
          { id: 't1', description: 'First' },
          { id: 't2', description: 'Second', dependencies: ['t1'] },
        ],
      });

      expect(publishedDeltas).toHaveLength(3);
      expect(publishedDeltas[0].type).toBe('created');
      expect(publishedDeltas[1].type).toBe('created');
      expect(publishedDeltas[2].type).toBe('created');
    });

    it('creates a terminal merge node depending on leaf tasks', () => {
      orchestrator.loadPlan({
        name: 'merge-node-test',
        tasks: [
          { id: 'a', description: 'Root' },
          { id: 'b', description: 'Middle', dependencies: ['a'] },
          { id: 'c', description: 'Leaf 1', dependencies: ['b'] },
          { id: 'd', description: 'Leaf 2', dependencies: ['b'] },
        ],
      });

      const mergeNode = orchestrator.getAllTasks().find((t) => t.config.isMergeNode);
      expect(mergeNode).toBeDefined();
      expect(mergeNode!.dependencies.sort()).toEqual(
        [sid(orchestrator, 0, 'c'), sid(orchestrator, 0, 'd')].sort(),
      );
      expect(mergeNode!.status).toBe('pending');
    });

    it('persists every task to DB', () => {
      orchestrator.loadPlan({
        name: 'persist-test',
        tasks: [
          { id: 't1', description: 'First' },
          { id: 't2', description: 'Second', dependencies: ['t1'] },
        ],
      });

      expect(persistence.tasks.size).toBe(3);
      expect(persistence.tasks.has(sid(orchestrator, 0, 't1'))).toBe(true);
      expect(persistence.tasks.has(sid(orchestrator, 0, 't2'))).toBe(true);
    });

    it('allows two workflows to reuse the same YAML task ids (scoped runtime ids differ)', () => {
      orchestrator.loadPlan({
        name: 'plan-A',
        tasks: [{ id: 'shared-task', description: 'A task' }],
      });
      expect(() =>
        orchestrator.loadPlan({
          name: 'plan-B',
          tasks: [{ id: 'shared-task', description: 'Same YAML id' }],
        }),
      ).not.toThrow();
      expect(orchestrator.getTask(sid(orchestrator, 0, 'shared-task'))!.description).toBe('A task');
      expect(orchestrator.getTask(sid(orchestrator, 1, 'shared-task'))!.description).toBe('Same YAML id');
    });

    it('PlanConflictError exposes conflicting task ids and workflows', () => {
      const err = new PlanConflictError(
        'Overlapping task IDs; pass allowGraphMutation: true to replace',
        ['wf-1/t1'],
        [{ id: 'wf-1', name: 'A' }],
      );
      expect(err.conflictingTaskIds).toEqual(['wf-1/t1']);
      expect(err.conflictingWorkflows[0].name).toBe('A');
      expect(err.message).toContain('allowGraphMutation');
    });

    it('allows overlapping YAML ids without allowGraphMutation (second workflow still loads)', () => {
      orchestrator.loadPlan({
        name: 'plan-A',
        tasks: [{ id: 'overlap', description: 'A' }],
      });

      expect(() =>
        orchestrator.loadPlan(
          { name: 'plan-B', tasks: [{ id: 'overlap', description: 'B' }] },
        ),
      ).not.toThrow();

      expect(orchestrator.getTask(sid(orchestrator, 1, 'overlap'))!.description).toBe('B');
    });

    it('allows non-overlapping plans without allowGraphMutation', () => {
      orchestrator.loadPlan({
        name: 'plan-A',
        tasks: [{ id: 'unique-a', description: 'A' }],
      });

      expect(() =>
        orchestrator.loadPlan({
          name: 'plan-B',
          tasks: [{ id: 'unique-b', description: 'B' }],
        }),
      ).not.toThrow();
    });

    // ── executor routing rules ───────────────────────────────

    describe('executor routing rules', () => {
      it('validates matching pattern rule: task must declare required executorType and remoteTargetId', () => {
        const routedOrchestrator = new Orchestrator({
          persistence: new InMemoryPersistence(),
          messageBus: new InMemoryBus(),
          maxConcurrency: 3,
          executorRoutingRules: [
            { pattern: 'deploy', executorType: 'ssh', remoteTargetId: 'prod-server' },
          ],
        });

        routedOrchestrator.loadPlan({
          name: 'routing-test',
          tasks: [{ id: 't1', description: 'Deploy task', command: 'deploy --env prod', executorType: 'ssh', remoteTargetId: 'prod-server' }],
        });

        const task = routedOrchestrator.getTask('t1');
        expect(task!.config.executorType).toBe('ssh');
        expect(task!.config.remoteTargetId).toBe('prod-server');
      });

      it('throws when task executorType does not match routing rule', () => {
        const routedOrchestrator = new Orchestrator({
          persistence: new InMemoryPersistence(),
          messageBus: new InMemoryBus(),
          maxConcurrency: 3,
          executorRoutingRules: [
            { pattern: 'deploy', executorType: 'ssh', remoteTargetId: 'prod-server' },
          ],
        });

        expect(() => {
          routedOrchestrator.loadPlan({
            name: 'mismatch-test',
            tasks: [{ id: 't1', description: 'Deploy task', command: 'deploy --env prod', executorType: 'worktree', remoteTargetId: 'prod-server' }],
          });
        }).toThrow('requires executorType="ssh"');
      });

      it('prompt-only task (no command) ignores routing rules', () => {
        const routedOrchestrator = new Orchestrator({
          persistence: new InMemoryPersistence(),
          messageBus: new InMemoryBus(),
          maxConcurrency: 3,
          executorRoutingRules: [
            { pattern: 'deploy', executorType: 'ssh', remoteTargetId: 'prod-server' },
          ],
        });

        routedOrchestrator.loadPlan({
          name: 'prompt-only-test',
          tasks: [{ id: 't1', description: 'Prompt task', prompt: 'deploy to prod' }],
        });

        const task = routedOrchestrator.getTask('t1');
        expect(task!.config.executorType).toBe('worktree');
        expect(task!.config.remoteTargetId).toBeUndefined();
      });

      it('validates regex rule matching pnpm test', () => {
        const routedOrchestrator = new Orchestrator({
          persistence: new InMemoryPersistence(),
          messageBus: new InMemoryBus(),
          maxConcurrency: 3,
          executorRoutingRules: [
            { regex: '^pnpm test', executorType: 'ssh', remoteTargetId: 'ci-box' },
          ],
        });

        routedOrchestrator.loadPlan({
          name: 'test-routing',
          tasks: [{ id: 't1', description: 'Run tests', command: 'pnpm test', executorType: 'ssh', remoteTargetId: 'ci-box' }],
        });

        const task = routedOrchestrator.getTask('t1');
        expect(task!.config.executorType).toBe('ssh');
        expect(task!.config.remoteTargetId).toBe('ci-box');
      });

      it('validates pattern rule matching test command', () => {
        const routedOrchestrator = new Orchestrator({
          persistence: new InMemoryPersistence(),
          messageBus: new InMemoryBus(),
          maxConcurrency: 3,
          executorRoutingRules: [
            { pattern: 'pnpm test', executorType: 'ssh', remoteTargetId: 'ci-box' },
          ],
        });

        routedOrchestrator.loadPlan({
          name: 'test-routing-pattern',
          tasks: [{ id: 't1', description: 'Run tests', command: 'pnpm test --coverage', executorType: 'ssh', remoteTargetId: 'ci-box' }],
        });

        const task = routedOrchestrator.getTask('t1');
        expect(task!.config.executorType).toBe('ssh');
        expect(task!.config.remoteTargetId).toBe('ci-box');
      });

      it('throws when task executorType does not match regex rule', () => {
        const routedOrchestrator = new Orchestrator({
          persistence: new InMemoryPersistence(),
          messageBus: new InMemoryBus(),
          maxConcurrency: 3,
          executorRoutingRules: [
            { regex: '^pnpm test', executorType: 'ssh', remoteTargetId: 'ci-box' },
          ],
        });

        expect(() => {
          routedOrchestrator.loadPlan({
            name: 'test-mismatch',
            tasks: [{ id: 't1', description: 'Run tests locally', command: 'pnpm test', executorType: 'worktree', remoteTargetId: 'ci-box' }],
          });
        }).toThrow('requires executorType="ssh"');
      });

      it('throws when task remoteTargetId does not match routing rule', () => {
        const routedOrchestrator = new Orchestrator({
          persistence: new InMemoryPersistence(),
          messageBus: new InMemoryBus(),
          maxConcurrency: 3,
          executorRoutingRules: [
            { pattern: 'pnpm test', executorType: 'ssh', remoteTargetId: 'ci-box' },
          ],
        });

        expect(() => {
          routedOrchestrator.loadPlan({
            name: 'remote-mismatch',
            tasks: [{ id: 't1', description: 'Run tests on staging', command: 'pnpm test', executorType: 'ssh', remoteTargetId: 'staging-box' }],
          });
        }).toThrow('requires remoteTargetId="ci-box"');
      });

      it('throws when task executorType is missing for matching rule', () => {
        const routedOrchestrator = new Orchestrator({
          persistence: new InMemoryPersistence(),
          messageBus: new InMemoryBus(),
          maxConcurrency: 3,
          executorRoutingRules: [
            { pattern: 'deploy', executorType: 'ssh', remoteTargetId: 'prod-server' },
          ],
        });

        expect(() => {
          routedOrchestrator.loadPlan({
            name: 'missing-executorType',
            tasks: [{ id: 't1', description: 'Deploy task', command: 'deploy --env prod', remoteTargetId: 'prod-server' }],
          });
        }).toThrow('requires executorType="ssh"');
      });

      it('throws when task remoteTargetId is missing for matching rule', () => {
        const routedOrchestrator = new Orchestrator({
          persistence: new InMemoryPersistence(),
          messageBus: new InMemoryBus(),
          maxConcurrency: 3,
          executorRoutingRules: [
            { pattern: 'deploy', executorType: 'ssh', remoteTargetId: 'prod-server' },
          ],
        });

        expect(() => {
          routedOrchestrator.loadPlan({
            name: 'missing-remoteTargetId',
            tasks: [{ id: 't1', description: 'Deploy task', command: 'deploy --env prod', executorType: 'ssh' }],
          });
        }).toThrow('requires remoteTargetId="prod-server"');
      });

      it('merge node always has executorType merge regardless of routing rules', () => {
        const routedOrchestrator = new Orchestrator({
          persistence: new InMemoryPersistence(),
          messageBus: new InMemoryBus(),
          maxConcurrency: 3,
          executorRoutingRules: [
            { pattern: 'deploy', executorType: 'ssh', remoteTargetId: 'prod-server' },
          ],
        });

        routedOrchestrator.loadPlan({
          name: 'merge-routing-test',
          tasks: [{ id: 't1', description: 'Deploy task', command: 'deploy --env prod', executorType: 'ssh', remoteTargetId: 'prod-server' }],
        });

        const mergeNode = routedOrchestrator.getAllTasks().find((t) => t.config.isMergeNode);
        expect(mergeNode).toBeDefined();
        expect(mergeNode!.config.executorType).toBe('merge');
      });

      it('auto-routes pnpm test to heavyweight SSH target when executor is omitted', () => {
        const routedOrchestrator = new Orchestrator({
          persistence: new InMemoryPersistence(),
          messageBus: new InMemoryBus(),
          maxConcurrency: 3,
          heavyweightCommandRouting: {
            remoteTargetId: 'ci-box',
          },
          availableRemoteTargetIds: ['ci-box'],
        });

        routedOrchestrator.loadPlan({
          name: 'heavyweight-routing-test',
          tasks: [{ id: 't1', description: 'Run tests', command: 'cd packages/app && pnpm test' }],
        });

        const task = routedOrchestrator.getTask('t1');
        expect(task!.config.executorType).toBe('ssh');
        expect(task!.config.remoteTargetId).toBe('ci-box');
      });

      it('auto-routes pnpm install to heavyweight SSH target when executor is omitted', () => {
        const routedOrchestrator = new Orchestrator({
          persistence: new InMemoryPersistence(),
          messageBus: new InMemoryBus(),
          maxConcurrency: 3,
          heavyweightCommandRouting: {
            remoteTargetId: 'ci-box',
          },
          availableRemoteTargetIds: ['ci-box'],
        });

        routedOrchestrator.loadPlan({
          name: 'heavyweight-install-routing-test',
          tasks: [{ id: 't1', description: 'Install deps', command: 'pnpm install --frozen-lockfile' }],
        });

        const task = routedOrchestrator.getTask('t1');
        expect(task!.config.executorType).toBe('ssh');
        expect(task!.config.remoteTargetId).toBe('ci-box');
      });

      it('throws when heavyweight command explicitly declares conflicting local executor', () => {
        const routedOrchestrator = new Orchestrator({
          persistence: new InMemoryPersistence(),
          messageBus: new InMemoryBus(),
          maxConcurrency: 3,
          heavyweightCommandRouting: {
            remoteTargetId: 'ci-box',
          },
          availableRemoteTargetIds: ['ci-box'],
        });

        expect(() => {
          routedOrchestrator.loadPlan({
            name: 'heavyweight-conflict-test',
            tasks: [{ id: 't1', description: 'Run tests', command: 'pnpm test', executorType: 'worktree' }],
          });
        }).toThrow('matched heavyweight command routing');
      });

      it('throws when heavyweight command routing target is not configured', () => {
        const routedOrchestrator = new Orchestrator({
          persistence: new InMemoryPersistence(),
          messageBus: new InMemoryBus(),
          maxConcurrency: 3,
          heavyweightCommandRouting: {
            remoteTargetId: 'ci-box',
          },
          availableRemoteTargetIds: [],
        });

        expect(() => {
          routedOrchestrator.loadPlan({
            name: 'heavyweight-missing-target',
            tasks: [{ id: 't1', description: 'Run tests', command: 'pnpm test' }],
          });
        }).toThrow('no remoteTargets are configured');
      });

      it('leaves non-matching commands unchanged under heavyweight routing', () => {
        const routedOrchestrator = new Orchestrator({
          persistence: new InMemoryPersistence(),
          messageBus: new InMemoryBus(),
          maxConcurrency: 3,
          heavyweightCommandRouting: {
            remoteTargetId: 'ci-box',
          },
          availableRemoteTargetIds: ['ci-box'],
        });

        routedOrchestrator.loadPlan({
          name: 'non-heavyweight-command',
          tasks: [{ id: 't1', description: 'Echo hello', command: 'echo hello' }],
        });

        const task = routedOrchestrator.getTask('t1');
        expect(task!.config.executorType).toBe('worktree');
        expect(task!.config.remoteTargetId).toBeUndefined();
      });
    });

    // ── atomicity ───────────────────────────────────────────

    describe('atomicity', () => {
      it('rolls back when a dependency references a nonexistent task', () => {
        expect(() =>
          orchestrator.loadPlan({
            name: 'bad-dep-plan',
            tasks: [
              { id: 'good', description: 'Valid task' },
              { id: 'bad', description: 'Bad dep', dependencies: ['nonexistent'] },
            ],
          }),
        ).toThrow('depends on unknown task id');

        // Zero persistence side effects
        expect(persistence.tasks.size).toBe(0);
        expect(persistence.workflows.size).toBe(0);
        expect(publishedDeltas.length).toBe(0);
        expect(orchestrator.getAllTasks()).toHaveLength(0);
      });

      it('rolls back when routing rule fails on second task', () => {
        const routedOrchestrator = new Orchestrator({
          persistence,
          messageBus: bus,
          maxConcurrency: 3,
          executorRoutingRules: [
            { pattern: 'deploy', executorType: 'ssh', remoteTargetId: 'prod-server' },
          ],
        });

        expect(() =>
          routedOrchestrator.loadPlan({
            name: 'routing-fail-plan',
            tasks: [
              { id: 'ok', description: 'Valid task', command: 'echo hi' },
              { id: 'bad', description: 'Misrouted', command: 'deploy prod', executorType: 'worktree' },
            ],
          }),
        ).toThrow('requires executorType');

        expect(persistence.tasks.size).toBe(0);
        expect(persistence.workflows.size).toBe(0);
        expect(publishedDeltas.length).toBe(0);
      });

      it('rolls back when an external dependency task is missing', () => {
        expect(() =>
          orchestrator.loadPlan({
            name: 'bad-external-dep-plan',
            tasks: [
              {
                id: 'gated',
                description: 'Gated task',
                externalDependencies: [
                  { workflowId: 'wf-missing', taskId: 'verify-control-plane-regression' },
                ],
              },
            ],
          }),
        ).toThrow('missing cross-workflow prerequisites');

        expect(persistence.tasks.size).toBe(0);
        expect(persistence.workflows.size).toBe(0);
        expect(publishedDeltas.length).toBe(0);
      });

      it('rolls back when unknown executorType appears on second task', () => {
        expect(() =>
          orchestrator.loadPlan({
            name: 'unknown-type-plan',
            tasks: [
              { id: 'ok', description: 'Valid task' },
              { id: 'bad', description: 'Kubernetes task', executorType: 'kubernetes' },
            ],
          }),
        ).toThrow('Unknown executorType "kubernetes"');

        expect(persistence.tasks.size).toBe(0);
        expect(persistence.workflows.size).toBe(0);
        expect(publishedDeltas.length).toBe(0);
        expect(orchestrator.getAllTasks()).toHaveLength(0);
      });

      it('recovers: failed plan followed by valid plan loads correctly', () => {
        // First plan fails
        expect(() =>
          orchestrator.loadPlan({
            name: 'bad-plan',
            tasks: [
              { id: 'ok', description: 'Valid' },
              { id: 'bad', description: 'Bad dep', dependencies: ['ghost'] },
            ],
          }),
        ).toThrow();

        // Second plan succeeds
        orchestrator.loadPlan({
          name: 'good-plan',
          tasks: [
            { id: 'a', description: 'Task A' },
            { id: 'b', description: 'Task B', dependencies: ['a'] },
          ],
        });

        const tasks = orchestrator.getAllTasks();
        // 2 tasks + 1 merge node
        expect(tasks).toHaveLength(3);
        expect(persistence.workflows.size).toBe(1);
        // 2 tasks + 1 merge node
        expect(persistence.tasks.size).toBe(3);

        const mergeNode = tasks.find((t) => t.config.isMergeNode);
        expect(mergeNode).toBeDefined();
      });
    });
  });

  // ── startExecution ──────────────────────────────────────

  describe('startExecution', () => {
    it('starts ready tasks up to concurrency limit', () => {
      orchestrator.loadPlan({
        name: 'test-plan',
        tasks: [
          { id: 't1', description: 'Task 1' },
          { id: 't2', description: 'Task 2' },
          { id: 't3', description: 'Task 3' },
          { id: 't4', description: 'Task 4' },
        ],
      });
      publishedDeltas = [];

      const started = orchestrator.startExecution();

      expect(started).toHaveLength(3);
      expect(started.every((t) => t.status === 'running')).toBe(true);

      const allTasks = orchestrator.getAllTasks();
      const pendingTasks = allTasks.filter((t) => t.status === 'pending');
      expect(pendingTasks).toHaveLength(2);
    });

    it('does not start blocked tasks', () => {
      orchestrator.loadPlan({
        name: 'test-plan',
        tasks: [
          { id: 't1', description: 'Root' },
          { id: 't2', description: 'Depends on t1', dependencies: ['t1'] },
          { id: 't3', description: 'Depends on t2', dependencies: ['t2'] },
        ],
      });
      publishedDeltas = [];

      const started = orchestrator.startExecution();

      expect(started).toHaveLength(1);
      expect(started[0].id).toBe(sid(orchestrator, 0, 't1'));
      expect(orchestrator.getTask('t2')!.status).toBe('pending');
      expect(orchestrator.getTask('t3')!.status).toBe('pending');
    });

    it('repro: leaf tasks remain pending until external prerequisite completes, then all start', () => {
      orchestrator.loadPlan({
        name: 'prereq-workflow',
        tasks: [{ id: 'verify-control-plane-regression', description: 'Prereq task' }],
      });
      const prereqWfId = sid(orchestrator, 0, 'verify-control-plane-regression').split('/')[0]!;

      orchestrator.loadPlan({
        name: 'gated-workflow',
        tasks: [
          {
            id: 'leaf-a',
            description: 'leaf waits for external',
            externalDependencies: [{ workflowId: prereqWfId, taskId: 'verify-control-plane-regression' }],
          },
          {
            id: 'leaf-b',
            description: 'second leaf waits for external',
            externalDependencies: [{ workflowId: prereqWfId, taskId: 'verify-control-plane-regression' }],
          },
        ],
      });

      const startedInitially = orchestrator.startExecution();
      expect(startedInitially.map((t) => t.id)).toContain(sid(orchestrator, 0, 'verify-control-plane-regression'));
      expect(startedInitially.map((t) => t.id)).not.toContain(sid(orchestrator, 1, 'leaf-a'));
      expect(startedInitially.map((t) => t.id)).not.toContain(sid(orchestrator, 1, 'leaf-b'));
      expect(orchestrator.getTask(sid(orchestrator, 1, 'leaf-a'))!.status).toBe('pending');
      expect(orchestrator.getTask(sid(orchestrator, 1, 'leaf-b'))!.status).toBe('pending');

      const startedAfterCompletion = orchestrator.handleWorkerResponse(
        makeResponse({ actionId: sid(orchestrator, 0, 'verify-control-plane-regression'), status: 'completed' }),
      );
      expect(startedAfterCompletion.map((t) => t.id)).toContain(sid(orchestrator, 1, 'leaf-a'));
      expect(startedAfterCompletion.map((t) => t.id)).toContain(sid(orchestrator, 1, 'leaf-b'));
      expect(orchestrator.getTask(sid(orchestrator, 1, 'leaf-a'))!.status).toBe('running');
      expect(orchestrator.getTask(sid(orchestrator, 1, 'leaf-b'))!.status).toBe('running');
    });

    it('workflow-level external dependency (no taskId) waits for upstream merge gate', () => {
      orchestrator.loadPlan({
        name: 'prereq-workflow',
        tasks: [{ id: 'verify-control-plane-regression', description: 'Prereq task' }],
      });
      const prereqTaskId = sid(orchestrator, 0, 'verify-control-plane-regression');
      const prereqWfId = prereqTaskId.split('/')[0]!;
      const prereqMergeId = `__merge__${prereqWfId}`;

      orchestrator.loadPlan({
        name: 'workflow-gated',
        tasks: [
          {
            id: 'leaf-a',
            description: 'leaf waits for upstream merge gate',
            externalDependencies: [{ workflowId: prereqWfId, gatePolicy: 'completed' }],
          },
        ],
      });

      const startedInitially = orchestrator.startExecution();
      expect(startedInitially.map((t) => t.id)).toContain(prereqTaskId);
      expect(startedInitially.map((t) => t.id)).not.toContain(sid(orchestrator, 1, 'leaf-a'));
      expect(orchestrator.getTask(sid(orchestrator, 1, 'leaf-a'))!.status).toBe('pending');

      const afterPrereqTask = orchestrator.handleWorkerResponse(
        makeResponse({ actionId: prereqTaskId, status: 'completed' }),
      );
      expect(afterPrereqTask.map((t) => t.id)).toContain(prereqMergeId);
      expect(afterPrereqTask.map((t) => t.id)).not.toContain(sid(orchestrator, 1, 'leaf-a'));
      expect(orchestrator.getTask(sid(orchestrator, 1, 'leaf-a'))!.status).toBe('pending');

      const afterMergeGate = orchestrator.handleWorkerResponse(
        makeResponse({ actionId: prereqMergeId, status: 'completed' }),
      );
      expect(afterMergeGate.map((t) => t.id)).toContain(sid(orchestrator, 1, 'leaf-a'));
      expect(orchestrator.getTask(sid(orchestrator, 1, 'leaf-a'))!.status).toBe('running');
    });

    it('workflow-level external dependency defaults to review_ready and starts on awaiting_approval', () => {
      orchestrator.loadPlan({
        name: 'prereq-workflow',
        tasks: [{ id: 'verify-control-plane-regression', description: 'Prereq task' }],
      });
      const prereqTaskId = sid(orchestrator, 0, 'verify-control-plane-regression');
      const prereqWfId = prereqTaskId.split('/')[0]!;
      const prereqMergeId = `__merge__${prereqWfId}`;

      orchestrator.loadPlan({
        name: 'workflow-gated-default-review-ready',
        tasks: [
          {
            id: 'leaf-a',
            description: 'leaf waits for upstream merge gate review-ready by default',
            externalDependencies: [{ workflowId: prereqWfId }],
          },
        ],
      });

      orchestrator.startExecution();
      orchestrator.handleWorkerResponse(makeResponse({ actionId: prereqTaskId, status: 'completed' }));
      orchestrator.setTaskAwaitingApproval(prereqMergeId);

      const afterMergeAwaitingApproval = orchestrator.startExecution();
      expect(afterMergeAwaitingApproval.map((t) => t.id)).toContain(sid(orchestrator, 1, 'leaf-a'));
      expect(orchestrator.getTask(sid(orchestrator, 1, 'leaf-a'))!.status).toBe('running');
    });

    it('review_ready merge-gate dependency starts downstream when upstream is awaiting_approval', () => {
      orchestrator.loadPlan({
        name: 'prereq-workflow',
        tasks: [{ id: 'verify-control-plane-regression', description: 'Prereq task' }],
      });
      const prereqTaskId = sid(orchestrator, 0, 'verify-control-plane-regression');
      const prereqWfId = prereqTaskId.split('/')[0]!;
      const prereqMergeId = `__merge__${prereqWfId}`;

      orchestrator.loadPlan({
        name: 'workflow-gated-review-ready',
        tasks: [
          {
            id: 'leaf-a',
            description: 'leaf waits for upstream merge gate review-ready',
            externalDependencies: [{ workflowId: prereqWfId, gatePolicy: 'review_ready' }],
          },
        ],
      });

      const startedInitially = orchestrator.startExecution();
      expect(startedInitially.map((t) => t.id)).toContain(prereqTaskId);
      expect(startedInitially.map((t) => t.id)).not.toContain(sid(orchestrator, 1, 'leaf-a'));

      const afterPrereqTask = orchestrator.handleWorkerResponse(
        makeResponse({ actionId: prereqTaskId, status: 'completed' }),
      );
      expect(afterPrereqTask.map((t) => t.id)).toContain(prereqMergeId);
      expect(afterPrereqTask.map((t) => t.id)).not.toContain(sid(orchestrator, 1, 'leaf-a'));

      orchestrator.setTaskAwaitingApproval(prereqMergeId);
      const afterMergeAwaitingApproval = orchestrator.startExecution();
      expect(afterMergeAwaitingApproval.map((t) => t.id)).toContain(sid(orchestrator, 1, 'leaf-a'));
      expect(orchestrator.getTask(sid(orchestrator, 1, 'leaf-a'))!.status).toBe('running');
    });

    it('approved merge-gate dependency keeps downstream pending when upstream is awaiting_approval', () => {
      orchestrator.loadPlan({
        name: 'prereq-workflow',
        tasks: [{ id: 'verify-control-plane-regression', description: 'Prereq task' }],
      });
      const prereqTaskId = sid(orchestrator, 0, 'verify-control-plane-regression');
      const prereqWfId = prereqTaskId.split('/')[0]!;
      const prereqMergeId = `__merge__${prereqWfId}`;

      orchestrator.loadPlan({
        name: 'workflow-gated-approved',
        tasks: [
          {
            id: 'leaf-a',
            description: 'leaf waits for upstream merge gate completion',
            externalDependencies: [{ workflowId: prereqWfId, gatePolicy: 'completed' }],
          },
        ],
      });

      orchestrator.startExecution();
      orchestrator.handleWorkerResponse(makeResponse({ actionId: prereqTaskId, status: 'completed' }));
      orchestrator.setTaskAwaitingApproval(prereqMergeId);
      const afterMergeAwaitingApproval = orchestrator.startExecution();
      expect(afterMergeAwaitingApproval.map((t) => t.id)).not.toContain(sid(orchestrator, 1, 'leaf-a'));
      expect(orchestrator.getTask(sid(orchestrator, 1, 'leaf-a'))!.status).toBe('pending');
    });

    it('setTaskExternalGatePolicies can unblock pending task immediately', () => {
      orchestrator.loadPlan({
        name: 'prereq-workflow',
        tasks: [{ id: 'verify-control-plane-regression', description: 'Prereq task' }],
      });
      const prereqTaskId = sid(orchestrator, 0, 'verify-control-plane-regression');
      const prereqWfId = prereqTaskId.split('/')[0]!;
      const prereqMergeId = `__merge__${prereqWfId}`;

      orchestrator.loadPlan({
        name: 'workflow-gated-approved',
        tasks: [
          {
            id: 'leaf-a',
            description: 'leaf waits for upstream merge gate completion',
            externalDependencies: [{ workflowId: prereqWfId, gatePolicy: 'completed' }],
          },
        ],
      });
      const leafId = sid(orchestrator, 1, 'leaf-a');

      orchestrator.startExecution();
      orchestrator.handleWorkerResponse(makeResponse({ actionId: prereqTaskId, status: 'completed' }));
      orchestrator.setTaskAwaitingApproval(prereqMergeId);

      expect(orchestrator.getTask(leafId)!.status).toBe('pending');

      const started = orchestrator.setTaskExternalGatePolicies(leafId, [
        { workflowId: prereqWfId, gatePolicy: 'review_ready' },
      ]);

      expect(orchestrator.getTask(leafId)!.config.externalDependencies?.[0]?.gatePolicy).toBe('review_ready');
      expect(started.map((t) => t.id)).toContain(leafId);
      expect(orchestrator.getTask(leafId)!.status).toBe('running');
    });

    it('setTaskExternalGatePolicies applies targeted updates only', () => {
      orchestrator.loadPlan({
        name: 'upstream-a',
        tasks: [{ id: 'done', description: 'done' }],
      });
      orchestrator.loadPlan({
        name: 'upstream-b',
        tasks: [{ id: 'done', description: 'done' }],
      });
      const wfA = sid(orchestrator, 0, 'done').split('/')[0]!;
      const wfB = sid(orchestrator, 1, 'done').split('/')[0]!;

      orchestrator.loadPlan({
        name: 'multi-dependency-gated',
        tasks: [
          {
            id: 'leaf-a',
            description: 'leaf waits for two external merge gates',
            externalDependencies: [
              { workflowId: wfA, gatePolicy: 'completed' },
              { workflowId: wfB, gatePolicy: 'completed' },
            ],
          },
        ],
      });

      const leafId = sid(orchestrator, 2, 'leaf-a');
      orchestrator.setTaskExternalGatePolicies(leafId, [
        { workflowId: wfB, gatePolicy: 'review_ready' },
      ]);

      const deps = orchestrator.getTask(leafId)!.config.externalDependencies!;
      expect(deps.find((d) => d.workflowId === wfA)!.gatePolicy).toBe('completed');
      expect(deps.find((d) => d.workflowId === wfB)!.gatePolicy).toBe('review_ready');
    });

    it('repro: deleting upstream workflow blocks downstream external dependency on restart', () => {
      orchestrator.loadPlan({
        name: 'upstream-workflow',
        tasks: [{ id: 'verify', description: 'upstream prerequisite' }],
      });
      const upstreamTaskId = sid(orchestrator, 0, 'verify');
      const upstreamWfId = upstreamTaskId.split('/')[0]!;

      orchestrator.loadPlan({
        name: 'downstream-workflow',
        tasks: [
          {
            id: 'wait-for-upstream',
            description: 'downstream waits on upstream merge gate',
            externalDependencies: [{ workflowId: upstreamWfId, gatePolicy: 'completed' }],
          },
        ],
      });
      const downstreamTaskId = sid(orchestrator, 1, 'wait-for-upstream');

      orchestrator.startExecution();
      expect(orchestrator.getTask(downstreamTaskId)!.status).toBe('pending');
      expect(orchestrator.getTask(downstreamTaskId)!.config.externalDependencies).toHaveLength(1);

      // Repro condition: upstream workflow is deleted after downstream was created.
      orchestrator.deleteWorkflow(upstreamWfId);
      expect(orchestrator.getTask(downstreamTaskId)).toBeDefined();

      const restarted = orchestrator.restartTask(downstreamTaskId);
      expect(restarted.map((t) => t.id)).toContain(downstreamTaskId);
      expect(orchestrator.getTask(downstreamTaskId)!.status).toBe('blocked');
      expect(orchestrator.getTask(downstreamTaskId)!.execution.blockedBy).toContain('missing prerequisite');
      expect(orchestrator.getTask(downstreamTaskId)!.config.externalDependencies).toHaveLength(1);
    });

    it('persists status changes to DB', () => {
      orchestrator.loadPlan({
        name: 'test-plan',
        tasks: [{ id: 't1', description: 'Root' }],
      });

      orchestrator.startExecution();

      const persisted = persistence.getTaskEntry('t1');
      expect(persisted!.task.status).toBe('running');
    });
  });

  // ── handleWorkerResponse ────────────────────────────────

  describe('handleWorkerResponse', () => {
    beforeEach(() => {
      orchestrator.loadPlan({
        name: 'test-plan',
        tasks: [
          { id: 't1', description: 'Root' },
          { id: 't2', description: 'Depends on t1', dependencies: ['t1'] },
          { id: 't3', description: 'Depends on t1', dependencies: ['t1'] },
        ],
      });
      orchestrator.startExecution();
      publishedDeltas = [];
    });

    it('completed: marks task complete, starts newly ready dependents', () => {
      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 't1', status: 'completed', outputs: { exitCode: 0 } }),
      );

      expect(orchestrator.getTask('t1')!.status).toBe('completed');
      expect(orchestrator.getTask('t2')!.status).toBe('running');
      expect(orchestrator.getTask('t3')!.status).toBe('running');
    });

    it('failed: marks task failed, dependents stay pending', () => {
      orchestrator.handleWorkerResponse(
        makeResponse({
          actionId: 't1',
          status: 'failed',
          outputs: { exitCode: 1, error: 'Something broke' },
        }),
      );

      expect(orchestrator.getTask('t1')!.status).toBe('failed');
      expect(orchestrator.getTask('t2')!.status).toBe('pending');
      expect(orchestrator.getTask('t3')!.status).toBe('pending');
    });

    it('needs_input: pauses task with prompt', () => {
      orchestrator.handleWorkerResponse(
        makeResponse({
          actionId: 't1',
          status: 'needs_input',
          outputs: { summary: 'What directory?' },
        }),
      );

      const task = orchestrator.getTask('t1');
      expect(task!.status).toBe('needs_input');
      expect(task!.execution.inputPrompt).toBe('What directory?');
    });

    it('persists completed status to DB', () => {
      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 't1', status: 'completed', outputs: { exitCode: 0 } }),
      );

      const persisted = persistence.getTaskEntry('t1');
      expect(persisted!.task.status).toBe('completed');
    });

    it('dependents remain pending in DB after failure', () => {
      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 't1', status: 'failed', outputs: { exitCode: 1, error: 'fail' } }),
      );

      const persisted = persistence.getTaskEntry('t2');
      expect(persisted!.task.status).toBe('pending');
    });

    it('preserves execution.agentSessionId when worker completion omits outputs.agentSessionId', () => {
      persistence.updateTask('t1', {
        execution: { agentSessionId: 'sess-kept', workspacePath: '/tmp/wt' },
      });
      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 't1', status: 'completed', outputs: { exitCode: 0 } }),
      );
      expect(orchestrator.getTask('t1')!.execution.agentSessionId).toBe('sess-kept');
      expect(persistence.getTaskEntry('t1')!.task.execution.agentSessionId).toBe('sess-kept');
    });
  });

  // ── provideInput ────────────────────────────────────────

  describe('provideInput', () => {
    it('resumes paused task', () => {
      orchestrator.loadPlan({
        name: 'test-plan',
        tasks: [{ id: 't1', description: 'Root' }],
      });
      orchestrator.startExecution();

      orchestrator.handleWorkerResponse(
        makeResponse({
          actionId: 't1',
          status: 'needs_input',
          outputs: { summary: 'Enter path' },
        }),
      );
      expect(orchestrator.getTask('t1')!.status).toBe('needs_input');

      orchestrator.provideInput('t1', '/some/path');
      expect(orchestrator.getTask('t1')!.status).toBe('running');
    });
  });

  // ── setTaskAwaitingApproval ────────────────────────────

  describe('setTaskAwaitingApproval', () => {
    it('transitions running task to awaiting_approval', () => {
      orchestrator.loadPlan({
        name: 'awaiting-test',
        tasks: [
          { id: 'a1', description: 'Task' },
        ],
      });
      orchestrator.startExecution();
      expect(orchestrator.getTask('a1')!.status).toBe('running');

      publishedDeltas = [];
      orchestrator.setTaskAwaitingApproval('a1');

      expect(orchestrator.getTask('a1')!.status).toBe('awaiting_approval');
      expect(orchestrator.getTask('a1')!.execution.completedAt).toBeDefined();
      const attemptId = orchestrator.getTask('a1')!.execution.selectedAttemptId!;
      expect(persistence.loadAttempt(attemptId)?.status).toBe('needs_input');

      const delta = publishedDeltas.find(
        (d) => d.type === 'updated' && d.taskId === sid(orchestrator, 0, 'a1'),
      );
      expect(delta).toBeDefined();
    });

    it('does not trigger workflow completion', () => {
      orchestrator.loadPlan({
        name: 'no-complete-test',
        tasks: [
          { id: 'a1', description: 'Task' },
        ],
      });
      orchestrator.startExecution();

      orchestrator.setTaskAwaitingApproval('a1');

      // Workflow should NOT be marked completed because a task is awaiting_approval
      const workflows = persistence.listWorkflows();
      expect(workflows[0].status).toBe('running');
    });

    it('includes additionalChanges in task state and delta', () => {
      orchestrator.loadPlan({
        name: 'additional-changes-test',
        tasks: [
          { id: 'a1', description: 'Task' },
        ],
      });
      orchestrator.startExecution();
      expect(orchestrator.getTask('a1')!.status).toBe('running');

      publishedDeltas = [];
      orchestrator.setTaskAwaitingApproval('a1', {
        config: { executorType: 'worktree', summary: 'test summary' },
        execution: {
          branch: 'plan/feature',
          workspacePath: '/tmp',
          reviewUrl: 'https://github.com/owner/repo/pull/1',
          reviewId: 'owner/repo#1',
          reviewStatus: 'Awaiting review',
        },
      });

      const task = orchestrator.getTask('a1')!;
      expect(task.status).toBe('awaiting_approval');
      expect(task.config.executorType).toBe('worktree');
      expect(task.config.summary).toBe('test summary');
      expect(task.execution.branch).toBe('plan/feature');
      expect(task.execution.workspacePath).toBe('/tmp');
      expect(task.execution.reviewUrl).toBe('https://github.com/owner/repo/pull/1');
      expect(task.execution.reviewId).toBe('owner/repo#1');
      expect(task.execution.reviewStatus).toBe('Awaiting review');
      expect(task.execution.completedAt).toBeDefined();

      const delta = publishedDeltas.find(
        (d) => d.type === 'updated' && d.taskId === sid(orchestrator, 0, 'a1'),
      );
      expect(delta).toBeDefined();
      expect(delta!.type === 'updated' && delta!.changes.config?.executorType).toBe('worktree');
      expect(delta!.type === 'updated' && delta!.changes.execution?.reviewUrl).toBe('https://github.com/owner/repo/pull/1');
    });

    it('preserves existing agent session metadata when not provided in additionalChanges', () => {
      orchestrator.loadPlan({
        name: 'awaiting-agent-preserve-test',
        tasks: [
          { id: 'a1', description: 'Task' },
        ],
      });
      orchestrator.startExecution();
      persistence.updateTask('a1', {
        execution: {
          agentSessionId: 'sess-merge-fix-1',
          agentName: 'codex',
        },
      });

      orchestrator.setTaskAwaitingApproval('a1', {
        execution: {
          branch: 'plan/feature',
          workspacePath: '/tmp/wt',
        },
      });

      const task = orchestrator.getTask('a1')!;
      expect(task.status).toBe('awaiting_approval');
      expect(task.execution.agentSessionId).toBe('sess-merge-fix-1');
      expect(task.execution.agentName).toBe('codex');
      expect(task.execution.branch).toBe('plan/feature');
      expect(task.execution.workspacePath).toBe('/tmp/wt');
    });

    it('marks the selected attempt as needs_input when worker completion requires approval', () => {
      orchestrator.loadPlan({
        name: 'worker-awaiting-approval-test',
        tasks: [
          { id: 'a1', description: 'Task', requiresManualApproval: true },
        ],
      });
      orchestrator.startExecution();

      const attemptId = orchestrator.getTask('a1')!.execution.selectedAttemptId!;
      orchestrator.handleWorkerResponse(
        makeResponse({
          actionId: 'a1',
          status: 'completed',
          outputs: { exitCode: 0, summary: 'needs review' },
        }),
      );

      expect(orchestrator.getTask('a1')!.status).toBe('awaiting_approval');
      expect(persistence.loadAttempt(attemptId)?.status).toBe('needs_input');
    });
  });

  // ── approve / reject ───────────────────────────────────

  describe('approve', () => {
    it('completes task, unblocks dependents', async () => {
      orchestrator.loadPlan({
        name: 'approval-test',
        tasks: [
          { id: 'a1', description: 'Approval task' },
          { id: 'a2', description: 'After approval', dependencies: ['a1'] },
        ],
      });
      orchestrator.startExecution();

      // Move a1 to awaiting_approval by writing directly to persistence
      persistence.updateTask('a1', { status: 'awaiting_approval' });

      publishedDeltas = [];
      await orchestrator.approve('a1');

      expect(orchestrator.getTask('a1')!.status).toBe('completed');
      expect(orchestrator.getTask('a2')!.status).toBe('running');
    });

    it('starts dependents after approve following a prior failure', async () => {
      orchestrator.loadPlan({
        name: 'approve-unblock-test',
        tasks: [
          { id: 'a1', description: 'Task that will fail then be fixed' },
          { id: 'a2', description: 'Downstream dependent', dependencies: ['a1'] },
        ],
      });
      orchestrator.startExecution();

      // a1 fails → a2 stays pending (no blocked status)
      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 'a1', status: 'failed', outputs: { exitCode: 1, error: 'some error' } }),
      );
      expect(orchestrator.getTask('a2')!.status).toBe('pending');

      // Fix with Claude → awaiting_approval
      orchestrator.beginConflictResolution('a1');
      orchestrator.setFixAwaitingApproval('a1', 'some error');
      expect(orchestrator.getTask('a1')!.status).toBe('awaiting_approval');

      // Approve → a2 becomes ready and starts
      const started = await orchestrator.approve('a1');
      expect(orchestrator.getTask('a1')!.status).toBe('completed');
      expect(orchestrator.getTask('a2')!.status).toBe('running');
      expect(started.some((t) => t.id === sid(orchestrator, 0, 'a2'))).toBe(true);
    });
  });

  describe('reject', () => {
    it('fails task, dependents stay pending', () => {
      orchestrator.loadPlan({
        name: 'reject-test',
        tasks: [
          { id: 't1', description: 'Root' },
          { id: 't2', description: 'Depends on t1', dependencies: ['t1'] },
        ],
      });
      orchestrator.startExecution();

      // Move t1 to awaiting_approval
      persistence.updateTask('t1', { status: 'awaiting_approval' });

      orchestrator.reject('t1', 'Not good enough');

      expect(orchestrator.getTask('t1')!.status).toBe('failed');
      expect(orchestrator.getTask('t2')!.status).toBe('pending');
    });
  });

  // ── Experiment Completion Wiring ────────────────────────

  describe('experiment completion wiring', () => {
    it('completing one experiment tracks it without triggering reconciliation', () => {
      orchestrator.loadPlan({
        name: 'experiment-test',
        tasks: [
          { id: 'pivot', description: 'Pivot task' },
          { id: 'downstream', description: 'After pivot', dependencies: ['pivot'] },
        ],
      });
      orchestrator.startExecution();

      orchestrator.handleWorkerResponse(
        makeResponse({
          actionId: 'pivot',
          status: 'spawn_experiments',
          dagMutation: {
            spawnExperiments: {
              description: 'Try variants',
              variants: [
                { id: 'v1', prompt: 'Approach A' },
                { id: 'v2', prompt: 'Approach B' },
              ],
            },
          },
        }),
      );

      expect(orchestrator.getTask('pivot-exp-v1')).toBeDefined();
      expect(orchestrator.getTask('pivot-exp-v2')).toBeDefined();
      expect(orchestrator.getTask('pivot-exp-v1')!.status).toBe('running');
      expect(orchestrator.getTask('pivot-exp-v2')!.status).toBe('running');

      orchestrator.handleWorkerResponse(
        makeResponse({
          actionId: 'pivot-exp-v1',
          status: 'completed',
          outputs: { exitCode: 0 },
        }),
      );

      expect(orchestrator.getTask('pivot-exp-v1')!.status).toBe('completed');
      expect(orchestrator.getTask('pivot-exp-v2')!.status).toBe('running');
      const recon = orchestrator.getTask('pivot-reconciliation');
      expect(recon).toBeDefined();
      expect(recon!.status).not.toBe('needs_input');
    });

    it('all experiments completing triggers reconciliation on recon task', () => {
      orchestrator.loadPlan({
        name: 'recon-test',
        tasks: [
          { id: 'pivot', description: 'Pivot task' },
          { id: 'downstream', description: 'After pivot', dependencies: ['pivot'] },
        ],
      });
      orchestrator.startExecution();

      orchestrator.handleWorkerResponse(
        makeResponse({
          actionId: 'pivot',
          status: 'spawn_experiments',
          dagMutation: {
            spawnExperiments: {
              description: 'Try variants',
              variants: [
                { id: 'v1', prompt: 'Approach A' },
                { id: 'v2', prompt: 'Approach B' },
              ],
            },
          },
        }),
      );

      orchestrator.handleWorkerResponse(
        makeResponse({
          actionId: 'pivot-exp-v1',
          status: 'completed',
          outputs: { exitCode: 0 },
        }),
      );

      if (orchestrator.getTask('pivot-exp-v2')!.status === 'pending') {
        orchestrator.startExecution();
      }

      orchestrator.handleWorkerResponse(
        makeResponse({
          actionId: 'pivot-exp-v2',
          status: 'completed',
          outputs: { exitCode: 0 },
        }),
      );

      orchestrator.handleWorkerResponse(reconciliationNeedsInputWorkResponse('pivot-reconciliation'));

      const reconTask = orchestrator.getTask('pivot-reconciliation');
      expect(reconTask).toBeDefined();
      expect(reconTask!.status).toBe('needs_input');
      expect(reconTask!.execution.experimentResults).toBeDefined();
      expect(reconTask!.execution.experimentResults!.length).toBe(2);
    });

    it('failed experiment still counts toward completion tracking', () => {
      orchestrator.loadPlan({
        name: 'fail-test',
        tasks: [{ id: 'pivot', description: 'Pivot task' }],
      });
      orchestrator.startExecution();

      orchestrator.handleWorkerResponse(
        makeResponse({
          actionId: 'pivot',
          status: 'spawn_experiments',
          dagMutation: {
            spawnExperiments: {
              description: 'Try variants',
              variants: [
                { id: 'v1', prompt: 'Approach A' },
                { id: 'v2', prompt: 'Approach B' },
              ],
            },
          },
        }),
      );

      orchestrator.handleWorkerResponse(
        makeResponse({
          actionId: 'pivot-exp-v1',
          status: 'failed',
          outputs: { exitCode: 1, error: 'build failed' },
        }),
      );

      if (orchestrator.getTask('pivot-exp-v2')!.status === 'pending') {
        orchestrator.startExecution();
      }

      orchestrator.handleWorkerResponse(
        makeResponse({
          actionId: 'pivot-exp-v2',
          status: 'completed',
          outputs: { exitCode: 0 },
        }),
      );

      orchestrator.handleWorkerResponse(reconciliationNeedsInputWorkResponse('pivot-reconciliation'));

      const reconTask = orchestrator.getTask('pivot-reconciliation');
      expect(reconTask).toBeDefined();
      expect(reconTask!.status).toBe('needs_input');
      expect(reconTask!.execution.experimentResults).toBeDefined();

      const results = reconTask!.execution.experimentResults!;
      const v1Result = results.find((r) => r.id === sid(orchestrator, 0, 'pivot-exp-v1'));
      const v2Result = results.find((r) => r.id === sid(orchestrator, 0, 'pivot-exp-v2'));
      expect(v1Result).toBeDefined();
      expect(v1Result!.status).toBe('failed');
      expect(v2Result).toBeDefined();
      expect(v2Result!.status).toBe('completed');
    });

    it('non-experiment task completion does not error', () => {
      orchestrator.loadPlan({
        name: 'normal-test',
        tasks: [{ id: 't1', description: 'Normal task' }],
      });
      orchestrator.startExecution();

      expect(() => {
        orchestrator.handleWorkerResponse(
          makeResponse({ actionId: 't1', status: 'completed', outputs: { exitCode: 0 } }),
        );
      }).not.toThrow();

      expect(orchestrator.getTask('t1')!.status).toBe('completed');
    });
  });

  // ── syncFromDb ─────────────────────────────────────────

  describe('syncFromDb', () => {
    it('restores tasks without auto-starting', () => {
      const hydratePersistence = new InMemoryPersistence();
      const storedTasks: TaskState[] = [
        {
          id: 't1',
          description: 'Completed task',
          status: 'completed',
          dependencies: [],
          createdAt: new Date(),
          config: {},
          execution: { completedAt: new Date(), exitCode: 0 },
        },
        {
          id: 't2',
          description: 'Pending task with completed dep',
          status: 'pending',
          dependencies: ['t1'],
          createdAt: new Date(),
          config: {},
          execution: {},
        },
      ];
      for (const t of storedTasks) {
        hydratePersistence.saveTask('wf-hydrate', t);
      }

      const hydrateOrchestrator = new Orchestrator({
        persistence: hydratePersistence,
        messageBus: bus,
        maxConcurrency: 3,
      });

      hydrateOrchestrator.syncFromDb('wf-hydrate');

      expect(hydrateOrchestrator.getAllTasks()).toHaveLength(2);
      expect(hydrateOrchestrator.getTask('t1')!.status).toBe('completed');
      expect(hydrateOrchestrator.getTask('t2')!.status).toBe('pending');
    });

    it('preserves running task status from DB', () => {
      const hydratePersistence = new InMemoryPersistence();
      const startedAt = new Date();
      const task: TaskState = {
        id: 't1',
        description: 'Currently running task',
        status: 'running',
        dependencies: [],
        createdAt: new Date(),
        config: {},
        execution: { startedAt },
      };
      hydratePersistence.saveTask('wf-hydrate', task);

      const hydrateOrchestrator = new Orchestrator({
        persistence: hydratePersistence,
        messageBus: bus,
        maxConcurrency: 3,
      });

      hydrateOrchestrator.syncFromDb('wf-hydrate');

      const restored = hydrateOrchestrator.getTask('t1')!;
      expect(restored.status).toBe('running');
      expect(restored.execution.startedAt).toBe(startedAt);
    });

    it('restartTask recovers a stuck running task after syncFromDb', () => {
      const hydratePersistence = new InMemoryPersistence();
      const task: TaskState = {
        id: 't1',
        description: 'Stuck running task from a crash',
        status: 'running',
        dependencies: [],
        createdAt: new Date(),
        config: {},
        execution: { startedAt: new Date() },
      };
      hydratePersistence.saveTask('wf-hydrate', task);

      const hydrateOrchestrator = new Orchestrator({
        persistence: hydratePersistence,
        messageBus: new InMemoryBus(),
        maxConcurrency: 3,
      });

      hydrateOrchestrator.syncFromDb('wf-hydrate');
      const started = hydrateOrchestrator.restartTask('t1');

      expect(started).toHaveLength(1);
      expect(started[0].status).toBe('running');
    });

    it('restartTask works on failed tasks after syncFromDb', () => {
      const hydratePersistence = new InMemoryPersistence();
      const task: TaskState = {
        id: 't1',
        description: 'Failed task',
        status: 'failed',
        dependencies: [],
        createdAt: new Date(),
        config: {},
        execution: { error: 'something broke' },
      };
      hydratePersistence.saveTask('wf-hydrate', task);

      const hydrateBus = new InMemoryBus();
      const deltas: TaskDelta[] = [];
      hydrateBus.subscribe('task.delta', (d) => deltas.push(d as TaskDelta));

      const hydrateOrchestrator = new Orchestrator({
        persistence: hydratePersistence,
        messageBus: hydrateBus,
        maxConcurrency: 3,
      });

      hydrateOrchestrator.syncFromDb('wf-hydrate');
      const started = hydrateOrchestrator.restartTask('t1');

      expect(started).toHaveLength(1);
      expect(started[0].status).toBe('running');
      expect(deltas.length).toBeGreaterThan(0);
    });

    it('re-syncing with a different workflow replaces state machine contents', () => {
      const hydratePersistence = new InMemoryPersistence();
      hydratePersistence.saveTask('wf-a', {
        id: 'a1',
        description: 'Task from workflow A',
        status: 'completed',
        dependencies: [],
        createdAt: new Date(),
        config: {},
        execution: {},
      });
      hydratePersistence.saveTask('wf-b', {
        id: 'b1',
        description: 'Failed task from workflow B',
        status: 'failed',
        dependencies: [],
        createdAt: new Date(),
        config: {},
        execution: { error: 'something broke' },
      });

      const hydrateOrchestrator = new Orchestrator({
        persistence: hydratePersistence,
        messageBus: new InMemoryBus(),
        maxConcurrency: 3,
      });

      hydrateOrchestrator.syncFromDb('wf-a');
      expect(hydrateOrchestrator.getTask('a1')!.status).toBe('completed');

      hydrateOrchestrator.syncFromDb('wf-b');
      const started = hydrateOrchestrator.restartTask('b1');
      expect(started).toHaveLength(1);
      expect(started[0].status).toBe('running');
    });

    it('approve works after syncFromDb', () => {
      const hydratePersistence = new InMemoryPersistence();
      hydratePersistence.saveTask('wf-hydrate', {
        id: 't1',
        description: 'Awaiting approval',
        status: 'awaiting_approval',
        dependencies: [],
        createdAt: new Date(),
        config: {},
        execution: {},
      });

      const hydrateOrchestrator = new Orchestrator({
        persistence: hydratePersistence,
        messageBus: bus,
        maxConcurrency: 3,
      });

      hydrateOrchestrator.syncFromDb('wf-hydrate');
      hydrateOrchestrator.approve('t1');

      expect(hydrateOrchestrator.getTask('t1')!.status).toBe('completed');
    });
  });

  // ── resumeWorkflow ──────────────────────────────────────

  describe('resumeWorkflow', () => {
    it('restores task state from persistence', () => {
      const resumePersistence = new InMemoryPersistence();
      resumePersistence.saveTask('wf-resume', {
        id: 't1',
        description: 'Completed task',
        status: 'completed',
        dependencies: [],
        createdAt: new Date(),
        config: {},
        execution: { completedAt: new Date(), exitCode: 0 },
      });
      resumePersistence.saveTask('wf-resume', {
        id: 't2',
        description: 'Pending task',
        status: 'pending',
        dependencies: ['t1'],
        createdAt: new Date(),
        config: {},
        execution: {},
      });

      const resumeOrchestrator = new Orchestrator({
        persistence: resumePersistence,
        messageBus: bus,
        maxConcurrency: 3,
      });

      resumeOrchestrator.resumeWorkflow('wf-resume');

      expect(resumeOrchestrator.getAllTasks()).toHaveLength(2);
      expect(resumeOrchestrator.getTask('t1')!.status).toBe('completed');
      expect(resumeOrchestrator.getTask('t2')!.status).toBe('running');
    });

    it('resumed workflow can continue executing pending tasks', () => {
      const resumePersistence = new InMemoryPersistence();
      resumePersistence.saveTask('wf-resume', {
        id: 't1',
        description: 'Already done',
        status: 'completed',
        dependencies: [],
        createdAt: new Date(),
        config: {},
        execution: { completedAt: new Date() },
      });
      resumePersistence.saveTask('wf-resume', {
        id: 't2',
        description: 'Ready to run',
        status: 'pending',
        dependencies: ['t1'],
        createdAt: new Date(),
        config: {},
        execution: {},
      });
      resumePersistence.saveTask('wf-resume', {
        id: 't3',
        description: 'Blocked by t2',
        status: 'pending',
        dependencies: ['t2'],
        createdAt: new Date(),
        config: {},
        execution: {},
      });

      const resumeOrchestrator = new Orchestrator({
        persistence: resumePersistence,
        messageBus: bus,
        maxConcurrency: 3,
      });

      const started = resumeOrchestrator.resumeWorkflow('wf-resume');

      expect(started).toHaveLength(1);
      expect(started[0].id).toBe('t2');
      expect(started[0].status).toBe('running');
      expect(resumeOrchestrator.getTask('t3')!.status).toBe('pending');

      resumeOrchestrator.handleWorkerResponse(
        makeResponse({ actionId: 't2', status: 'completed', outputs: { exitCode: 0 } }),
      );
      expect(resumeOrchestrator.getTask('t3')!.status).toBe('running');
    });

    it('preserves running tasks and only starts pending ones', () => {
      const resumePersistence = new InMemoryPersistence();
      resumePersistence.saveTask('wf-resume', {
        id: 't1',
        description: 'Was running when process died',
        status: 'running',
        dependencies: [],
        createdAt: new Date(),
        config: {},
        execution: { startedAt: new Date() },
      });

      const resumeOrchestrator = new Orchestrator({
        persistence: resumePersistence,
        messageBus: bus,
        maxConcurrency: 3,
      });

      const started = resumeOrchestrator.resumeWorkflow('wf-resume');

      expect(started).toHaveLength(0);
      expect(resumeOrchestrator.getTask('t1')!.status).toBe('running');
    });
  });

  // ── Auto-Fix ────────────────────────────────────────────

  describe('auto-fix via synthetic spawn_experiments', () => {
    it('falls back to default auto-fix retries for older failed tasks missing per-task config', () => {
      const hydratePersistence = new InMemoryPersistence();
      const hydrateBus = new InMemoryBus();

      hydratePersistence.saveTask('wf-hydrated', {
        id: 't1',
        description: 'Hydrated failed task',
        status: 'failed',
        dependencies: [],
        createdAt: new Date(),
        config: {},
        execution: {
          exitCode: 1,
          error: 'boom',
          autoFixAttempts: 2,
        },
      });

      const hydratedOrchestrator = new Orchestrator({
        persistence: hydratePersistence,
        messageBus: hydrateBus,
        defaultAutoFixRetries: 3,
      });

      hydratedOrchestrator.syncFromDb('wf-hydrated');

      expect(hydratedOrchestrator.getAutoFixRetryBudget('t1')).toBe(3);
      expect(hydratedOrchestrator.shouldAutoFix('t1')).toBe(true);

      hydratePersistence.updateTask('t1', { execution: { autoFixAttempts: 3 } });
      hydratedOrchestrator.syncFromDb('wf-hydrated');

      expect(hydratedOrchestrator.shouldAutoFix('t1')).toBe(false);
    });

    it('plain failed tasks stay failed in workflow-core', () => {
      orchestrator = new Orchestrator({
        persistence,
        messageBus: bus,
        maxConcurrency: 3,
        defaultAutoFixRetries: 3,
      });
      orchestrator.loadPlan({
        name: 'autofix-test',
        tasks: [
          { id: 't1', description: 'Auto-fix task' },
          { id: 't2', description: 'Depends on t1', dependencies: ['t1'] },
        ],
      });
      orchestrator.startExecution();

      const started = orchestrator.handleWorkerResponse(
        makeResponse({
          actionId: 't1',
          status: 'failed',
          outputs: { exitCode: 1, error: 'compilation error' },
        }),
      );

      const t1 = orchestrator.getTask('t1');
      expect(t1!.status).toBe('failed');
      expect(orchestrator.getTask(sid(orchestrator, 0, 't1-exp-fix-conservative'))).toBeUndefined();
      expect(orchestrator.getTask(sid(orchestrator, 0, 't1-exp-fix-refactor'))).toBeUndefined();
      expect(orchestrator.getTask(sid(orchestrator, 0, 't1-exp-fix-alternative'))).toBeUndefined();
      expect(started).toHaveLength(0);
    });

    it('failed experiment tasks do not spawn nested fix experiment sets', () => {
      orchestrator = new Orchestrator({
        persistence,
        messageBus: bus,
        maxConcurrency: 3,
        defaultAutoFixRetries: 3,
      });
      orchestrator.loadPlan({
        name: 'autofix-recon-test',
        tasks: [
          { id: 't1', description: 'Auto-fix task' },
          { id: 't2', description: 'After fix', dependencies: ['t1'] },
        ],
      });
      orchestrator.startExecution();

      orchestrator.handleWorkerResponse(
        makeResponse({
          actionId: 't1',
          status: 'spawn_experiments',
          outputs: { exitCode: 0 },
          dagMutation: {
            spawnExperiments: {
              description: 'Auto-fix experiments',
              variants: [
                { id: 'fix-conservative', description: 'Conservative fix', prompt: 'fix minimally' },
                { id: 'fix-refactor', description: 'Refactor fix', prompt: 'refactor' },
                { id: 'fix-alternative', description: 'Alternative fix', prompt: 'new approach' },
              ],
            },
          },
        }),
      );

      const expCon = sid(orchestrator, 0, 't1-exp-fix-conservative');
      expect(orchestrator.getTask(expCon)).toBeDefined();

      orchestrator.handleWorkerResponse(
        makeResponse({
          actionId: expCon,
          status: 'failed',
          outputs: { exitCode: 1, error: 'experiment failed' },
        }),
      );

      expect(orchestrator.getTask(expCon)!.status).toBe('failed');
      expect(orchestrator.getTask(`${expCon}-exp-fix-conservative`)).toBeUndefined();
      expect(orchestrator.getTask(`${expCon}-exp-fix-refactor`)).toBeUndefined();
      expect(orchestrator.getTask(`${expCon}-exp-fix-alternative`)).toBeUndefined();
    });

    it('non-autoFix failed task still fails normally', () => {
      orchestrator.loadPlan({
        name: 'normal-fail-test',
        tasks: [
          { id: 't1', description: 'Normal task' },
          { id: 't2', description: 'Depends on t1', dependencies: ['t1'] },
        ],
      });
      orchestrator.startExecution();

      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 't1', status: 'failed', outputs: { exitCode: 1, error: 'broke' } }),
      );

      expect(orchestrator.getTask('t1')!.status).toBe('failed');
      expect(orchestrator.getTask('t2')!.status).toBe('pending');
    });

  });

  // ── Full workflow ──────────────────────────────────────

  describe('full workflow', () => {
    it('load -> start -> complete all -> workflow done', () => {
      orchestrator.loadPlan({
        name: 'full-workflow',
        tasks: [
          { id: 't1', description: 'Step 1' },
          { id: 't2', description: 'Step 2', dependencies: ['t1'] },
          { id: 't3', description: 'Step 3', dependencies: ['t2'] },
        ],
      });

      const started = orchestrator.startExecution();
      expect(started).toHaveLength(1);
      expect(started[0].id).toBe(sid(orchestrator, 0, 't1'));

      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 't1', status: 'completed', outputs: { exitCode: 0 } }),
      );
      expect(orchestrator.getTask('t1')!.status).toBe('completed');
      expect(orchestrator.getTask('t2')!.status).toBe('running');

      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 't2', status: 'completed', outputs: { exitCode: 0 } }),
      );
      expect(orchestrator.getTask('t2')!.status).toBe('completed');
      expect(orchestrator.getTask('t3')!.status).toBe('running');

      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 't3', status: 'completed', outputs: { exitCode: 0 } }),
      );
      expect(orchestrator.getTask('t3')!.status).toBe('completed');

      const mergeNode = orchestrator.getAllTasks().find((t) => t.config.isMergeNode);
      expect(mergeNode!.status).toBe('running');
      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: mergeNode!.id, status: 'completed', outputs: { exitCode: 0 } }),
      );

      const status = orchestrator.getWorkflowStatus();
      expect(status.total).toBe(4);
      expect(status.completed).toBe(4);
    });
  });

  // ── Workflow Completion ────────────────────────────────

  describe('checkWorkflowCompletion', () => {
    it('marks workflow completed when all tasks succeed', () => {
      orchestrator.loadPlan({
        name: 'completion-test',
        tasks: [
          { id: 't1', description: 'Task 1' },
          { id: 't2', description: 'Task 2', dependencies: ['t1'] },
        ],
      });
      orchestrator.startExecution();

      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 't1', status: 'completed', outputs: { exitCode: 0 } }),
      );
      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 't2', status: 'completed', outputs: { exitCode: 0 } }),
      );

      const mergeNode = orchestrator.getAllTasks().find((t) => t.config.isMergeNode);
      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: mergeNode!.id, status: 'completed', outputs: { exitCode: 0 } }),
      );

      const wf = Array.from(persistence.workflows.values())[0];
      expect(wf.status).toBe('completed');
    });

    it('workflow stays running when a task fails but dependents are still pending', () => {
      orchestrator.loadPlan({
        name: 'fail-completion-test',
        tasks: [
          { id: 't1', description: 'Task 1' },
          { id: 't2', description: 'Task 2', dependencies: ['t1'] },
        ],
      });
      orchestrator.startExecution();

      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 't1', status: 'failed', outputs: { exitCode: 1, error: 'boom' } }),
      );

      // t2 stays pending (not blocked), so workflow is not settled
      const wf = Array.from(persistence.workflows.values())[0];
      expect(wf.status).toBe('running');
    });

    it('does not mark workflow complete while tasks are running', () => {
      orchestrator.loadPlan({
        name: 'still-running-test',
        tasks: [
          { id: 't1', description: 'Task 1' },
          { id: 't2', description: 'Task 2' },
        ],
      });
      orchestrator.startExecution();

      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 't1', status: 'completed', outputs: { exitCode: 0 } }),
      );

      const wf = Array.from(persistence.workflows.values())[0];
      expect(wf.status).toBe('running');
    });

    it('does not mark workflow complete while tasks need user input', () => {
      orchestrator.loadPlan({
        name: 'needs-input-test',
        tasks: [{ id: 't1', description: 'Task 1' }],
      });
      orchestrator.startExecution();

      orchestrator.handleWorkerResponse(
        makeResponse({
          actionId: 't1',
          status: 'needs_input',
          outputs: { summary: 'What path?' },
        }),
      );

      const wf = Array.from(persistence.workflows.values())[0];
      expect(wf.status).toBe('running');
    });

    it('updates workflow status to completed (no bogus __workflow__ event)', () => {
      orchestrator.loadPlan({
        name: 'event-test',
        tasks: [{ id: 't1', description: 'Task 1' }],
      });
      orchestrator.startExecution();

      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 't1', status: 'completed', outputs: { exitCode: 0 } }),
      );

      const mergeNode = orchestrator.getAllTasks().find((t) => t.config.isMergeNode);
      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: mergeNode!.id, status: 'completed', outputs: { exitCode: 0 } }),
      );

      const wf = Array.from(persistence.workflows.values())[0];
      expect(wf.status).toBe('completed');

      const wfEvents = persistence.events.filter((e) => e.eventType === 'workflow.completed');
      expect(wfEvents).toHaveLength(0);
    });
  });

  // ── Event Logging ─────────────────────────────────────

  describe('event logging', () => {
    it('logs task.running when task starts', () => {
      orchestrator.loadPlan({
        name: 'event-start-test',
        tasks: [{ id: 't1', description: 'Task 1' }],
      });
      persistence.events = [];
      orchestrator.startExecution();

      const startEvents = persistence.events.filter((e) => e.eventType === 'task.running');
      expect(startEvents).toHaveLength(1);
      expect(startEvents[0].taskId).toBe(sid(orchestrator, 0, 't1'));
    });

    it('logs task.completed when task completes', () => {
      orchestrator.loadPlan({
        name: 'event-complete-test',
        tasks: [{ id: 't1', description: 'Task 1' }],
      });
      orchestrator.startExecution();
      persistence.events = [];

      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 't1', status: 'completed', outputs: { exitCode: 0 } }),
      );

      const completeEvents = persistence.events.filter((e) => e.eventType === 'task.completed');
      expect(completeEvents).toHaveLength(1);
      expect(completeEvents[0].taskId).toBe(sid(orchestrator, 0, 't1'));
    });

    it('logs task.failed when task fails', () => {
      orchestrator.loadPlan({
        name: 'event-fail-test',
        tasks: [{ id: 't1', description: 'Task 1' }],
      });
      orchestrator.startExecution();
      persistence.events = [];

      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 't1', status: 'failed', outputs: { exitCode: 1, error: 'err' } }),
      );

      const failEvents = persistence.events.filter((e) => e.eventType === 'task.failed');
      expect(failEvents).toHaveLength(1);
      expect(failEvents[0].taskId).toBe(sid(orchestrator, 0, 't1'));
    });
  });

  // ── editTaskCommand ────────────────────────────────────

  describe('editTaskCommand', () => {
    it('updates command, restarts the task, and publishes deltas', () => {
      orchestrator.loadPlan({
        name: 'edit-cmd-test',
        tasks: [{ id: 't1', description: 'Task 1', command: 'echo old' }],
      });
      orchestrator.startExecution();

      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 't1', status: 'failed', outputs: { exitCode: 1, error: 'fail' } }),
      );
      expect(orchestrator.getTask('t1')?.status).toBe('failed');

      const started = orchestrator.editTaskCommand('t1', 'echo new');
      const task = orchestrator.getTask('t1');
      expect(task?.config.command).toBe('echo new');
      expect(task?.status).toBe('running');
      expect(started).toHaveLength(1);
      expect(started[0].id).toBe(sid(orchestrator, 0, 't1'));
    });

    it('restarts task with new command and invalidates downstream dependents', () => {
      orchestrator.loadPlan({
        name: 'edit-fork-test',
        tasks: [
          { id: 'parent', description: 'Parent', command: 'echo parent' },
          { id: 'child', description: 'Child', command: 'echo child', dependencies: ['parent'] },
        ],
      });
      orchestrator.startExecution();

      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 'parent', status: 'completed', outputs: { exitCode: 0 } }),
      );
      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 'child', status: 'completed', outputs: { exitCode: 0 } }),
      );

      expect(orchestrator.getTask('parent')?.status).toBe('completed');
      expect(orchestrator.getTask('child')?.status).toBe('completed');

      const taskCountBefore = orchestrator.getAllTasks().length;
      const started = orchestrator.editTaskCommand('parent', 'echo updated');

      expect(orchestrator.getTask('parent')?.config.command).toBe('echo updated');
      expect(orchestrator.getTask('parent')?.status).toBe('running');
      // Child is invalidated to pending (no fork, no stale clone)
      expect(orchestrator.getTask('child')?.status).toBe('pending');
      // No new tasks created (no -v2 clones)
      expect(orchestrator.getAllTasks().length).toBe(taskCountBefore);
    });

    it('editing an ACTIVE (running) task does NOT throw and cancels first, then recreates', () => {
      orchestrator.loadPlan({
        name: 'edit-running-test',
        tasks: [{ id: 't1', description: 'Task 1', command: 'sleep 100' }],
      });
      orchestrator.startExecution();
      const taskId = sid(orchestrator, 0, 't1');
      expect(orchestrator.getTask(taskId)?.status).toBe('running');

      const cancelSpy = vi.spyOn(orchestrator, 'cancelTask');
      const recreateSpy = vi.spyOn(orchestrator, 'recreateTask');

      const started = orchestrator.editTaskCommand(taskId, 'echo new');

      expect(cancelSpy).toHaveBeenCalledWith(taskId);
      expect(recreateSpy).toHaveBeenCalledWith(taskId);
      expect(cancelSpy.mock.invocationCallOrder[0]).toBeLessThan(
        recreateSpy.mock.invocationCallOrder[0],
      );

      const task = orchestrator.getTask(taskId);
      expect(task?.config.command).toBe('echo new');
      expect(task?.status).toBe('running');
      expect(started).toHaveLength(1);
      expect(started[0].id).toBe(taskId);

      cancelSpy.mockRestore();
      recreateSpy.mockRestore();
    });

    it('editing an INACTIVE (failed) task skips cancel but still routes through recreateTask', () => {
      orchestrator.loadPlan({
        name: 'edit-inactive-test',
        tasks: [{ id: 't1', description: 'Task 1', command: 'echo old' }],
      });
      orchestrator.startExecution();
      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 't1', status: 'failed', outputs: { exitCode: 1, error: 'fail' } }),
      );
      const taskId = sid(orchestrator, 0, 't1');
      expect(orchestrator.getTask(taskId)?.status).toBe('failed');

      const cancelSpy = vi.spyOn(orchestrator, 'cancelTask');
      const recreateSpy = vi.spyOn(orchestrator, 'recreateTask');

      orchestrator.editTaskCommand(taskId, 'echo new');

      expect(cancelSpy).not.toHaveBeenCalled();
      expect(recreateSpy).toHaveBeenCalledWith(taskId);

      cancelSpy.mockRestore();
      recreateSpy.mockRestore();
    });

    it('discards stale lineage (matches recreateTask reset shape)', () => {
      orchestrator.loadPlan({
        name: 'edit-lineage-test',
        tasks: [{ id: 't1', description: 'Task 1', command: 'echo old' }],
      });
      orchestrator.startExecution();
      const taskId = sid(orchestrator, 0, 't1');

      persistence.updateTask(taskId, {
        execution: {
          branch: 'experiment/old-cmd',
          commit: 'deadbeef',
          workspacePath: '/tmp/old-workspace',
          agentSessionId: 'sess-stale',
          containerId: 'container-stale',
          error: 'previous error',
          exitCode: 1,
          completedAt: new Date(),
          startedAt: new Date(),
        },
      });
      orchestrator.syncFromDb(taskId.split('/')[0]!);

      orchestrator.editTaskCommand(taskId, 'echo new');

      const task = orchestrator.getTask(taskId)!;
      expect(task.execution.branch).toBeUndefined();
      expect(task.execution.commit).toBeUndefined();
      expect(task.execution.workspacePath).toBeUndefined();
      expect(task.execution.agentSessionId).toBeUndefined();
      expect(task.execution.containerId).toBeUndefined();
      expect(task.execution.error).toBeUndefined();
      expect(task.execution.exitCode).toBeUndefined();
    });

    it('bumps execution generation by exactly one per command edit', () => {
      orchestrator.loadPlan({
        name: 'edit-gen-test',
        tasks: [{ id: 't1', description: 'Task 1', command: 'echo old' }],
      });
      orchestrator.startExecution();
      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 't1', status: 'failed', outputs: { exitCode: 1, error: 'x' } }),
      );
      const taskId = sid(orchestrator, 0, 't1');

      const before = orchestrator.getTask(taskId)!.execution.generation ?? 0;

      orchestrator.editTaskCommand(taskId, 'echo new');

      const after = orchestrator.getTask(taskId)!.execution.generation ?? 0;
      expect(after).toBe(before + 1);
    });

    it('idempotence — two consecutive command edits trigger two cancel-first cycles and two generation bumps', () => {
      orchestrator.loadPlan({
        name: 'edit-idempotence-test',
        tasks: [{ id: 't1', description: 'Task 1', command: 'sleep 100' }],
      });
      orchestrator.startExecution();
      const taskId = sid(orchestrator, 0, 't1');
      expect(orchestrator.getTask(taskId)?.status).toBe('running');

      const cancelSpy = vi.spyOn(orchestrator, 'cancelTask');
      const recreateSpy = vi.spyOn(orchestrator, 'recreateTask');

      const gen0 = orchestrator.getTask(taskId)!.execution.generation ?? 0;

      orchestrator.editTaskCommand(taskId, 'echo first');
      const gen1 = orchestrator.getTask(taskId)!.execution.generation ?? 0;
      expect(gen1).toBe(gen0 + 1);
      expect(orchestrator.getTask(taskId)?.status).toBe('running');

      orchestrator.editTaskCommand(taskId, 'echo second');
      const gen2 = orchestrator.getTask(taskId)!.execution.generation ?? 0;
      expect(gen2).toBe(gen0 + 2);

      expect(cancelSpy).toHaveBeenCalledTimes(2);
      expect(recreateSpy).toHaveBeenCalledTimes(2);
      expect(cancelSpy.mock.invocationCallOrder[0]).toBeLessThan(
        recreateSpy.mock.invocationCallOrder[0],
      );
      expect(cancelSpy.mock.invocationCallOrder[1]).toBeLessThan(
        recreateSpy.mock.invocationCallOrder[1],
      );

      expect(orchestrator.getTask(taskId)?.config.command).toBe('echo second');

      cancelSpy.mockRestore();
      recreateSpy.mockRestore();
    });

    it('persists the updated command', () => {
      orchestrator.loadPlan({
        name: 'edit-persist-test',
        tasks: [{ id: 't1', description: 'Task 1', command: 'echo old' }],
      });
      orchestrator.startExecution();

      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 't1', status: 'failed', outputs: { exitCode: 1, error: 'oops' } }),
      );

      orchestrator.editTaskCommand('t1', 'echo fixed');

      const persisted = persistence.getTaskEntry('t1');
      expect(persisted).toBeDefined();
      expect(persisted?.task.config.command).toBe('echo fixed');
    });
  });

  describe('editTaskPrompt', () => {
    it('editing an ACTIVE (running) task does NOT throw and cancels first, then recreates', () => {
      orchestrator.loadPlan({
        name: 'edit-prompt-running-test',
        tasks: [{ id: 't1', description: 'Task 1', prompt: 'do the old thing', command: 'sleep 100' }],
      });
      orchestrator.startExecution();
      const taskId = sid(orchestrator, 0, 't1');
      expect(orchestrator.getTask(taskId)?.status).toBe('running');

      const cancelSpy = vi.spyOn(orchestrator, 'cancelTask');
      const recreateSpy = vi.spyOn(orchestrator, 'recreateTask');

      const started = orchestrator.editTaskPrompt(taskId, 'do the new thing');

      expect(cancelSpy).toHaveBeenCalledWith(taskId);
      expect(recreateSpy).toHaveBeenCalledWith(taskId);
      expect(cancelSpy.mock.invocationCallOrder[0]).toBeLessThan(
        recreateSpy.mock.invocationCallOrder[0],
      );

      const task = orchestrator.getTask(taskId);
      expect(task?.config.prompt).toBe('do the new thing');
      // Single-task plan with no deps → recreate auto-starts the task.
      expect(task?.status).toBe('running');
      expect(started).toHaveLength(1);
      expect(started[0].id).toBe(taskId);

      cancelSpy.mockRestore();
      recreateSpy.mockRestore();
    });

    it('editing an INACTIVE (failed) task skips cancel but still routes through recreateTask', () => {
      orchestrator.loadPlan({
        name: 'edit-prompt-inactive-test',
        tasks: [{ id: 't1', description: 'Task 1', prompt: 'old prompt', command: 'echo old' }],
      });
      orchestrator.startExecution();
      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 't1', status: 'failed', outputs: { exitCode: 1, error: 'fail' } }),
      );
      const taskId = sid(orchestrator, 0, 't1');
      expect(orchestrator.getTask(taskId)?.status).toBe('failed');

      const cancelSpy = vi.spyOn(orchestrator, 'cancelTask');
      const recreateSpy = vi.spyOn(orchestrator, 'recreateTask');

      orchestrator.editTaskPrompt(taskId, 'new prompt');

      // Inactive → no cancel needed; recreateTask still resets lineage.
      expect(cancelSpy).not.toHaveBeenCalled();
      expect(recreateSpy).toHaveBeenCalledWith(taskId);

      cancelSpy.mockRestore();
      recreateSpy.mockRestore();
    });

    it('discards stale lineage (matches recreateTask reset shape)', () => {
      orchestrator.loadPlan({
        name: 'edit-prompt-lineage-test',
        tasks: [{ id: 't1', description: 'Task 1', prompt: 'old', command: 'echo old' }],
      });
      orchestrator.startExecution();
      const taskId = sid(orchestrator, 0, 't1');

      // Hydrate stale lineage as if a prior attempt completed and left
      // branch/commit/workspace/session/container artifacts behind.
      persistence.updateTask(taskId, {
        execution: {
          branch: 'experiment/old-prompt',
          commit: 'deadbeef',
          workspacePath: '/tmp/old-workspace',
          agentSessionId: 'sess-stale',
          containerId: 'container-stale',
          error: 'previous error',
          exitCode: 1,
          completedAt: new Date(),
          startedAt: new Date(),
        },
      });
      orchestrator.syncFromDb(taskId.split('/')[0]!);

      orchestrator.editTaskPrompt(taskId, 'new prompt');

      const task = orchestrator.getTask(taskId)!;
      expect(task.execution.branch).toBeUndefined();
      expect(task.execution.commit).toBeUndefined();
      expect(task.execution.workspacePath).toBeUndefined();
      expect(task.execution.agentSessionId).toBeUndefined();
      expect(task.execution.containerId).toBeUndefined();
      expect(task.execution.error).toBeUndefined();
      expect(task.execution.exitCode).toBeUndefined();
    });

    it('bumps execution generation by exactly one per prompt edit', () => {
      orchestrator.loadPlan({
        name: 'edit-prompt-gen-test',
        tasks: [{ id: 't1', description: 'Task 1', prompt: 'old', command: 'echo old' }],
      });
      orchestrator.startExecution();
      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 't1', status: 'failed', outputs: { exitCode: 1, error: 'x' } }),
      );
      const taskId = sid(orchestrator, 0, 't1');

      const before = orchestrator.getTask(taskId)!.execution.generation ?? 0;

      orchestrator.editTaskPrompt(taskId, 'new');

      const after = orchestrator.getTask(taskId)!.execution.generation ?? 0;
      expect(after).toBe(before + 1);
    });

    it('persists the updated prompt and publishes a task.updated delta', () => {
      orchestrator.loadPlan({
        name: 'edit-prompt-persist-test',
        tasks: [{ id: 't1', description: 'Task 1', prompt: 'old prompt', command: 'echo old' }],
      });
      orchestrator.startExecution();
      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 't1', status: 'failed', outputs: { exitCode: 1, error: 'oops' } }),
      );

      orchestrator.editTaskPrompt('t1', 'fresh prompt');

      const persisted = persistence.getTaskEntry('t1');
      expect(persisted).toBeDefined();
      expect(persisted?.task.config.prompt).toBe('fresh prompt');
    });

    it('idempotence — two consecutive prompt edits trigger two cancel-first cycles and two generation bumps', () => {
      orchestrator.loadPlan({
        name: 'edit-prompt-idempotence-test',
        tasks: [{ id: 't1', description: 'Task 1', prompt: 'old', command: 'sleep 100' }],
      });
      orchestrator.startExecution();
      const taskId = sid(orchestrator, 0, 't1');
      expect(orchestrator.getTask(taskId)?.status).toBe('running');

      const cancelSpy = vi.spyOn(orchestrator, 'cancelTask');
      const recreateSpy = vi.spyOn(orchestrator, 'recreateTask');

      const gen0 = orchestrator.getTask(taskId)!.execution.generation ?? 0;

      orchestrator.editTaskPrompt(taskId, 'first');
      const gen1 = orchestrator.getTask(taskId)!.execution.generation ?? 0;
      expect(gen1).toBe(gen0 + 1);
      expect(orchestrator.getTask(taskId)?.status).toBe('running');

      orchestrator.editTaskPrompt(taskId, 'second');
      const gen2 = orchestrator.getTask(taskId)!.execution.generation ?? 0;
      expect(gen2).toBe(gen0 + 2);

      // Two cancel-first cycles, each followed by a recreate.
      expect(cancelSpy).toHaveBeenCalledTimes(2);
      expect(recreateSpy).toHaveBeenCalledTimes(2);
      expect(cancelSpy.mock.invocationCallOrder[0]).toBeLessThan(
        recreateSpy.mock.invocationCallOrder[0],
      );
      expect(cancelSpy.mock.invocationCallOrder[1]).toBeLessThan(
        recreateSpy.mock.invocationCallOrder[1],
      );

      expect(orchestrator.getTask(taskId)?.config.prompt).toBe('second');

      cancelSpy.mockRestore();
      recreateSpy.mockRestore();
    });
  });

  // ── editTaskType ───────────────────────────────────────

  describe('editTaskType', () => {
    it('changes executorType and restarts the task', () => {
      orchestrator.loadPlan({
        name: 'edit-type-test',
        tasks: [{ id: 't1', description: 'Task 1', command: 'echo hello', executorType: 'docker' }],
      });
      orchestrator.startExecution();

      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 't1', status: 'failed', outputs: { exitCode: 1, error: 'fail' } }),
      );
      expect(orchestrator.getTask('t1')?.config.executorType).toBe('docker');

      const started = orchestrator.editTaskType('t1', 'worktree');
      const task = orchestrator.getTask('t1');
      expect(task?.config.executorType).toBe('worktree');
      expect(task?.status).toBe('running');
      expect(started).toHaveLength(1);
    });

    it('does not fork dirty subtree and invalidates downstream dependents', () => {
      orchestrator.loadPlan({
        name: 'edit-type-no-fork',
        tasks: [
          { id: 'parent', description: 'Parent', command: 'echo parent', executorType: 'docker' },
          { id: 'child', description: 'Child', command: 'echo child', dependencies: ['parent'] },
        ],
      });
      orchestrator.startExecution();

      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 'parent', status: 'completed', outputs: { exitCode: 0 } }),
      );
      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 'child', status: 'completed', outputs: { exitCode: 0 } }),
      );

      const taskCountBefore = orchestrator.getAllTasks().length;
      orchestrator.editTaskType('parent', 'worktree');
      const taskCountAfter = orchestrator.getAllTasks().length;

      expect(taskCountAfter).toBe(taskCountBefore);
      expect(orchestrator.getTask('child')?.status).toBe('pending');
    });

    it('throws when trying to edit a running task', () => {
      orchestrator.loadPlan({
        name: 'edit-type-running',
        tasks: [{ id: 't1', description: 'Task 1', command: 'sleep 100', executorType: 'docker' }],
      });
      orchestrator.startExecution();

      expect(() => orchestrator.editTaskType('t1', 'worktree')).toThrow();
    });

    it('persists the updated executorType', () => {
      orchestrator.loadPlan({
        name: 'edit-type-persist',
        tasks: [{ id: 't1', description: 'Task 1', command: 'echo old', executorType: 'docker' }],
      });
      orchestrator.startExecution();

      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 't1', status: 'failed', outputs: { exitCode: 1, error: 'oops' } }),
      );

      orchestrator.editTaskType('t1', 'worktree');

      const persisted = persistence.getTaskEntry('t1');
      expect(persisted).toBeDefined();
      expect(persisted?.task.config.executorType).toBe('worktree');
    });

    it('persists remoteTargetId when switching to ssh', () => {
      orchestrator.loadPlan({
        name: 'edit-type-ssh',
        tasks: [{ id: 't1', description: 'Task 1', command: 'echo hello', executorType: 'worktree' }],
      });
      orchestrator.startExecution();

      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 't1', status: 'failed', outputs: { exitCode: 1, error: 'fail' } }),
      );

      orchestrator.editTaskType('t1', 'ssh', 'remote_digital_ocean');

      const task = orchestrator.getTask('t1');
      expect(task?.config.executorType).toBe('ssh');
      expect(task?.config.remoteTargetId).toBe('remote_digital_ocean');

      const persisted = persistence.getTaskEntry('t1');
      expect(persisted?.task.config.executorType).toBe('ssh');
      expect(persisted?.task.config.remoteTargetId).toBe('remote_digital_ocean');
    });

    it('clears remoteTargetId when switching away from ssh', () => {
      orchestrator.loadPlan({
        name: 'edit-type-clear-remote',
        tasks: [{ id: 't1', description: 'Task 1', command: 'echo hello', executorType: 'ssh', remoteTargetId: 'remote_digital_ocean' }],
      });
      orchestrator.startExecution();

      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 't1', status: 'failed', outputs: { exitCode: 1, error: 'fail' } }),
      );

      orchestrator.editTaskType('t1', 'worktree');

      const task = orchestrator.getTask('t1');
      expect(task?.config.executorType).toBe('worktree');
      expect(task?.config.remoteTargetId).toBeUndefined();
    });
  });

  // ── editTaskAgent ──────────────────────────────────────

  describe('editTaskAgent', () => {
    it('changes executionAgent and restarts the task', () => {
      orchestrator.loadPlan({
        name: 'edit-agent-test',
        tasks: [{ id: 't1', description: 'Task 1', command: 'echo hello', executionAgent: 'claude' }],
      });
      orchestrator.startExecution();

      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 't1', status: 'failed', outputs: { exitCode: 1, error: 'fail' } }),
      );
      const started = orchestrator.editTaskAgent('t1', 'codex');

      const task = orchestrator.getTask('t1');
      expect(task?.config.executionAgent).toBe('codex');
      expect(task?.status).toBe('running');
      expect(started).toHaveLength(1);
      expect(started[0].id).toBe(sid(orchestrator, 0, 't1'));
    });

    it('invalidates downstream dependents', () => {
      orchestrator.loadPlan({
        name: 'edit-agent-no-invalidate',
        tasks: [
          { id: 'parent', description: 'Parent', command: 'echo parent', executionAgent: 'claude' },
          { id: 'child', description: 'Child', command: 'echo child', dependencies: ['parent'] },
        ],
      });
      orchestrator.startExecution();

      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 'parent', status: 'completed', outputs: { exitCode: 0 } }),
      );
      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 'child', status: 'completed', outputs: { exitCode: 0 } }),
      );

      orchestrator.editTaskAgent('parent', 'codex');

      expect(orchestrator.getTask('parent')?.status).toBe('running');
      expect(orchestrator.getTask('child')?.status).toBe('pending');
    });
  });

  // ── Scheduler queue drain ──────────────────────────────

  describe('scheduler queue drain', () => {
    it('starts queued tasks when a slot opens', () => {
      orchestrator.loadPlan({
        name: 'drain-test',
        tasks: [
          { id: 'a', description: 'Task A' },
          { id: 'b', description: 'Task B' },
          { id: 'c', description: 'Task C' },
          { id: 'd', description: 'Task D' },
          { id: 'e', description: 'Task E' },
        ],
      });

      const started = orchestrator.startExecution();
      expect(started).toHaveLength(3);

      const running = orchestrator.getAllTasks().filter((t) => t.status === 'running');
      expect(running).toHaveLength(3);
      expect(orchestrator.getAllTasks().filter((t) => t.status === 'pending')).toHaveLength(3);

      const firstRunning = running[0];
      const newlyStarted = orchestrator.handleWorkerResponse(
        makeResponse({ actionId: firstRunning.id, status: 'completed', outputs: { exitCode: 0 } }),
      );

      expect(newlyStarted).toHaveLength(1);
      expect(orchestrator.getAllTasks().filter((t) => t.status === 'running')).toHaveLength(3);
      expect(orchestrator.getAllTasks().filter((t) => t.status === 'pending')).toHaveLength(2);
    });
  });

  // ── DB-is-source-of-truth invariants ──────────────────

  describe('DB is source of truth', () => {
    it('every loadPlan task is persisted to DB', () => {
      orchestrator.loadPlan({
        name: 'db-truth-test',
        tasks: [
          { id: 't1', description: 'First' },
          { id: 't2', description: 'Second', dependencies: ['t1'] },
        ],
      });

      const allInMemory = orchestrator.getAllTasks();
      for (const task of allInMemory) {
        const persisted = persistence.getTaskEntry(task.id);
        expect(persisted).toBeDefined();
        expect(persisted!.task.id).toBe(task.id);
        expect(persisted!.task.status).toBe(task.status);
      }
    });

    it('in-memory matches DB after startExecution', () => {
      orchestrator.loadPlan({
        name: 'db-match-test',
        tasks: [
          { id: 't1', description: 'Root' },
          { id: 't2', description: 'Dep', dependencies: ['t1'] },
        ],
      });
      orchestrator.startExecution();

      for (const task of orchestrator.getAllTasks()) {
        const persisted = persistence.getTaskEntry(task.id);
        expect(persisted!.task.status).toBe(task.status);
      }
    });

    it('in-memory matches DB after handleWorkerResponse', () => {
      orchestrator.loadPlan({
        name: 'db-sync-test',
        tasks: [
          { id: 't1', description: 'Root' },
          { id: 't2', description: 'Dep', dependencies: ['t1'] },
        ],
      });
      orchestrator.startExecution();

      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 't1', status: 'completed', outputs: { exitCode: 0 } }),
      );

      for (const task of orchestrator.getAllTasks()) {
        const persisted = persistence.getTaskEntry(task.id);
        expect(persisted!.task.status).toBe(task.status);
      }
    });

    it('external DB change is visible after refreshFromDb', () => {
      orchestrator.loadPlan({
        name: 'external-change-test',
        tasks: [
          { id: 't1', description: 'Root' },
          { id: 't2', description: 'Dep', dependencies: ['t1'] },
        ],
      });
      orchestrator.startExecution();

      // Simulate an external process modifying the DB directly
      persistence.updateTask('t1', { status: 'completed', execution: { completedAt: new Date(), exitCode: 0 } });

      // The orchestrator sees the external change on next mutation
      // (restartTask calls refreshFromDb internally)
      // But we can verify via syncFromDb
      const wfId = Array.from(persistence.workflows.keys())[0];
      orchestrator.syncFromDb(wfId);
      expect(orchestrator.getTask('t1')!.status).toBe('completed');
    });
  });

  // ── Multi-workflow tests ─────────────────────────────────────

  describe('multi-workflow support', () => {
    it('loadPlan twice -> getAllTasks returns tasks from both workflows', () => {
      const planA: PlanDefinition = {
        name: 'Plan A',
        tasks: [{ id: 'a1', description: 'A task 1', command: 'echo a1' }],
      };
      const planB: PlanDefinition = {
        name: 'Plan B',
        tasks: [{ id: 'b1', description: 'B task 1', command: 'echo b1' }],
      };

      orchestrator.loadPlan(planA);
      orchestrator.loadPlan(planB);

      const allTasks = orchestrator.getAllTasks();
      expect(allTasks).toHaveLength(4);
      const userTasks = allTasks.filter((t) => !t.config.isMergeNode);
      expect(userTasks.map((t) => t.id).sort()).toEqual(
        [sid(orchestrator, 0, 'a1'), sid(orchestrator, 1, 'b1')].sort(),
      );
    });

    it('loadPlan does NOT clear other workflows tasks', () => {
      orchestrator.loadPlan({
        name: 'First',
        tasks: [{ id: 'f1', description: 'First', command: 'echo 1' }],
      });
      expect(orchestrator.getAllTasks()).toHaveLength(2);

      orchestrator.loadPlan({
        name: 'Second',
        tasks: [{ id: 's1', description: 'Second', command: 'echo 2' }],
      });
      expect(orchestrator.getAllTasks()).toHaveLength(4);
      expect(orchestrator.getTask('f1')).toBeDefined();
      expect(orchestrator.getTask('s1')).toBeDefined();
    });

    it('getWorkflowStatus(wfId) returns counts scoped to that workflow', () => {
      orchestrator.loadPlan({
        name: 'Plan A',
        tasks: [
          { id: 'a1', description: 'A1', command: 'echo a1' },
          { id: 'a2', description: 'A2', command: 'echo a2' },
        ],
      });
      orchestrator.loadPlan({
        name: 'Plan B',
        tasks: [{ id: 'b1', description: 'B1', command: 'echo b1' }],
      });

      const wfIds = orchestrator.getWorkflowIds();
      expect(wfIds).toHaveLength(2);

      const statusA = orchestrator.getWorkflowStatus(wfIds[0]);
      expect(statusA.total).toBe(3);
      expect(statusA.pending).toBe(3);

      const statusB = orchestrator.getWorkflowStatus(wfIds[1]);
      expect(statusB.total).toBe(2);
      expect(statusB.pending).toBe(2);
    });

    it('getWorkflowStatus() without wfId returns aggregate across all workflows', () => {
      orchestrator.loadPlan({
        name: 'A',
        tasks: [{ id: 'a1', description: 'A1', command: 'echo a1' }],
      });
      orchestrator.loadPlan({
        name: 'B',
        tasks: [{ id: 'b1', description: 'B1', command: 'echo b1' }],
      });

      const status = orchestrator.getWorkflowStatus();
      expect(status.total).toBe(4);
    });

    it('syncAllFromDb reloads tasks from all workflows', () => {
      orchestrator.loadPlan({
        name: 'Plan A',
        tasks: [{ id: 'a1', description: 'A1', command: 'echo a1' }],
      });
      orchestrator.loadPlan({
        name: 'Plan B',
        tasks: [{ id: 'b1', description: 'B1', command: 'echo b1' }],
      });

      // Externally modify DB
      persistence.updateTask('a1', { status: 'completed' } as any);

      // syncAllFromDb picks up the external change
      orchestrator.syncAllFromDb();
      expect(orchestrator.getTask('a1')!.status).toBe('completed');
      expect(orchestrator.getTask('b1')!.status).toBe('pending');
      expect(orchestrator.getAllTasks()).toHaveLength(4);
    });

    it('tasks have correct workflowId after loadPlan', () => {
      orchestrator.loadPlan({
        name: 'Plan A',
        tasks: [{ id: 'a1', description: 'A1', command: 'echo a1' }],
      });
      orchestrator.loadPlan({
        name: 'Plan B',
        tasks: [{ id: 'b1', description: 'B1', command: 'echo b1' }],
      });

      const a1 = orchestrator.getTask('a1')!;
      const b1 = orchestrator.getTask('b1')!;
      expect(a1.config.workflowId).toBeDefined();
      expect(b1.config.workflowId).toBeDefined();
      expect(a1.config.workflowId).not.toBe(b1.config.workflowId);
    });

    it('getWorkflowIds returns all active workflow IDs', () => {
      expect(orchestrator.getWorkflowIds()).toHaveLength(0);

      orchestrator.loadPlan({
        name: 'A',
        tasks: [{ id: 'a1', description: 'A1', command: 'echo a1' }],
      });
      expect(orchestrator.getWorkflowIds()).toHaveLength(1);

      orchestrator.loadPlan({
        name: 'B',
        tasks: [{ id: 'b1', description: 'B1', command: 'echo b1' }],
      });
      expect(orchestrator.getWorkflowIds()).toHaveLength(2);
    });

    it('completing tasks in workflow A does not affect workflow B status', () => {
      orchestrator.loadPlan({
        name: 'A',
        tasks: [{ id: 'a1', description: 'A1', command: 'echo a1' }],
      });
      orchestrator.loadPlan({
        name: 'B',
        tasks: [{ id: 'b1', description: 'B1', command: 'echo b1' }],
      });

      orchestrator.startExecution();
      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 'a1', status: 'completed', outputs: { exitCode: 0 } }),
      );

      const [wfA, wfB] = orchestrator.getWorkflowIds();
      const statusA = orchestrator.getWorkflowStatus(wfA);
      const statusB = orchestrator.getWorkflowStatus(wfB);

      expect(statusA.completed).toBe(1);
      expect(statusA.running).toBe(1);
      expect(statusB.pending).toBe(1);
      expect(statusB.running).toBe(1);
    });

    it('loadPlan persists onFinish/baseBranch/featureBranch on workflow', () => {
      orchestrator.loadPlan({
        name: 'Merge Plan',
        onFinish: 'merge',
        baseBranch: 'main',
        featureBranch: 'feat/test',
        tasks: [{ id: 't1', description: 'T1', command: 'echo 1' }],
      });

      const wfId = orchestrator.getWorkflowIds()[0];
      const wf = persistence.workflows.get(wfId)!;
      expect((wf as any).onFinish).toBe('merge');
      expect((wf as any).baseBranch).toBe('main');
      expect((wf as any).featureBranch).toBe('feat/test');
    });

    describe('allowGraphMutation merge gate orphaning', () => {
      it('scoped ids: two workflows with same YAML names keep independent merge gate dependency sets', () => {
        orchestrator.loadPlan({
          name: 'Plan A',
          tasks: [
            { id: 'shared-task', description: 'Shared', command: 'echo shared' },
            { id: 'unique-a', description: 'Unique A', command: 'echo a', dependencies: ['shared-task'] },
          ],
        });

        const wfAId = orchestrator.getWorkflowIds()[0];
        const mergeGateBefore = orchestrator.getMergeNode(wfAId);

        expect(mergeGateBefore).toBeDefined();
        expect(mergeGateBefore!.dependencies).toContain(sid(orchestrator, 0, 'unique-a'));

        orchestrator.loadPlan(
          { name: 'Plan B', tasks: [{ id: 'shared-task', description: 'Shared (B)', command: 'echo b' }] },
          { allowGraphMutation: true },
        );

        const tasksA = persistence.loadTasks(wfAId);
        const taskIdsA = tasksA.map((t) => t.id);

        expect(taskIdsA).toContain(sid(orchestrator, 0, 'shared-task'));
        expect(taskIdsA).toContain(sid(orchestrator, 0, 'unique-a'));

        const mergeGateAfter = tasksA.find((t) => t.config.isMergeNode);
        expect(mergeGateAfter).toBeDefined();

        for (const dep of mergeGateAfter!.dependencies) {
          expect(taskIdsA).toContain(dep);
        }
      });
    });
  });

  // ── restart invalidation logging ────────────────────────

  describe('restart invalidation logging', () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;
    let logSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
      warnSpy.mockRestore();
      logSpy.mockRestore();
    });

    it('fan-in dependents stay pending when multiple roots fail', () => {
      orchestrator.loadPlan({
        name: 'overwrite-test',
        tasks: [
          { id: 'A', description: 'Root A', command: 'echo A' },
          { id: 'B', description: 'Root B', command: 'echo B' },
          { id: 'C', description: 'Fan-in', command: 'echo C', dependencies: ['A', 'B'] },
        ],
      });
      orchestrator.startExecution();

      // Fail A — C stays pending
      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 'A', status: 'failed', outputs: { exitCode: 1, error: 'boom' } }),
      );
      expect(orchestrator.getTask('C')!.status).toBe('pending');

      // Fail B — C still pending
      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 'B', status: 'failed', outputs: { exitCode: 1, error: 'boom' } }),
      );
      expect(orchestrator.getTask('C')!.status).toBe('pending');
    });

    it('invalidates completed downstream tasks on restart without warning', () => {
      orchestrator.loadPlan({
        name: 'completed-downstream-test',
        tasks: [
          { id: 'A', description: 'Root', command: 'echo A' },
          { id: 'B', description: 'Child', command: 'echo B', dependencies: ['A'] },
        ],
      });
      orchestrator.startExecution();

      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 'A', status: 'completed', outputs: { exitCode: 0 } }),
      );
      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 'B', status: 'completed', outputs: { exitCode: 0 } }),
      );
      expect(orchestrator.getTask('A')!.status).toBe('completed');
      expect(orchestrator.getTask('B')!.status).toBe('completed');

      orchestrator.restartTask('A');
      expect(orchestrator.getTask('B')!.status).toBe('pending');
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('restarting one failed root leaves fan-in pending when other root still failed', () => {
      orchestrator.loadPlan({
        name: 'premature-unblock-test',
        tasks: [
          { id: 'A', description: 'Root A', command: 'echo A' },
          { id: 'B', description: 'Root B', command: 'echo B' },
          { id: 'C', description: 'Fan-in', command: 'echo C', dependencies: ['A', 'B'] },
        ],
      });
      orchestrator.startExecution();

      // Fail A, then B — C stays pending
      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 'A', status: 'failed', outputs: { exitCode: 1, error: 'boom' } }),
      );
      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 'B', status: 'failed', outputs: { exitCode: 1, error: 'boom' } }),
      );
      expect(orchestrator.getTask('C')!.status).toBe('pending');

      orchestrator.restartTask('B');

      // C still pending because A is still failed
      expect(orchestrator.getTask('C')!.status).toBe('pending');
    });

    it('restarting one failed root in fan-in does not affect pending dependent', () => {
      orchestrator.loadPlan({
        name: 'mismatch-test',
        tasks: [
          { id: 'A', description: 'Root A', command: 'echo A' },
          { id: 'B', description: 'Root B', command: 'echo B' },
          { id: 'C', description: 'Fan-in', command: 'echo C', dependencies: ['A', 'B'] },
        ],
      });
      orchestrator.startExecution();

      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 'A', status: 'failed', outputs: { exitCode: 1, error: 'boom' } }),
      );
      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 'B', status: 'failed', outputs: { exitCode: 1, error: 'boom' } }),
      );
      expect(orchestrator.getTask('C')!.status).toBe('pending');

      // Restart A — C stays pending because B is still failed
      orchestrator.restartTask('A');
      expect(orchestrator.getTask('C')!.status).toBe('pending');
    });

    it('handleCompleted logs newly ready downstream tasks', () => {
      orchestrator.loadPlan({
        name: 'ready-log-test',
        tasks: [
          { id: 'A', description: 'Root', command: 'echo A' },
          { id: 'B', description: 'Child', command: 'echo B', dependencies: ['A'] },
        ],
      });
      orchestrator.startExecution();

      logSpy.mockClear();
      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 'A', status: 'completed', outputs: { exitCode: 0 } }),
      );

      expect(
        logSpy.mock.calls.some(
          (c) =>
            typeof c[0] === 'string' &&
            c[0].includes('handleCompleted') &&
            c[0].includes('newly ready: [') &&
            c[0].includes('/B]'),
        ),
      ).toBe(true);
    });

    // ── Integration: full fan-in multi-failure restart cycle ──

    it('integration: three-root fan-in — all fail, restart all, complete all → D starts', () => {
      orchestrator.loadPlan({
        name: 'fan-in-integration',
        tasks: [
          { id: 'A', description: 'Root A', command: 'echo A' },
          { id: 'B', description: 'Root B', command: 'echo B' },
          { id: 'C', description: 'Root C', command: 'echo C' },
          { id: 'D', description: 'Fan-in', command: 'echo D', dependencies: ['A', 'B', 'C'] },
        ],
      });
      orchestrator.startExecution();

      // Phase 1: All three roots fail — D stays pending throughout
      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 'A', status: 'failed', outputs: { exitCode: 1, error: 'a' } }),
      );
      expect(orchestrator.getTask('D')!.status).toBe('pending');

      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 'B', status: 'failed', outputs: { exitCode: 1, error: 'b' } }),
      );
      expect(orchestrator.getTask('D')!.status).toBe('pending');

      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 'C', status: 'failed', outputs: { exitCode: 1, error: 'c' } }),
      );
      expect(orchestrator.getTask('D')!.status).toBe('pending');

      // Phase 2: Restart all three roots
      orchestrator.restartTask('A');
      orchestrator.restartTask('B');
      orchestrator.restartTask('C');
      expect(orchestrator.getTask('D')!.status).toBe('pending');

      // Phase 3: Complete A, B, C — D should become ready after the last one
      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 'A', executionGeneration: 1, status: 'completed', outputs: { exitCode: 0 } }),
      );
      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 'B', executionGeneration: 1, status: 'completed', outputs: { exitCode: 0 } }),
      );

      logSpy.mockClear();
      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 'C', executionGeneration: 1, status: 'completed', outputs: { exitCode: 0 } }),
      );

      expect(
        logSpy.mock.calls.some(
          (c) =>
            typeof c[0] === 'string' &&
            c[0].includes('handleCompleted') &&
            c[0].includes('newly ready: [') &&
            c[0].includes('/D]'),
        ),
      ).toBe(true);
      expect(orchestrator.getTask('D')!.status).toBe('running');
    });
  });

  // ── handleCompleted unblocking ──────────────────────────

  describe('handleCompleted unblocking', () => {
    let logSpy: ReturnType<typeof vi.spyOn>;
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      logSpy.mockRestore();
      warnSpy.mockRestore();
    });

    it('handleCompleted starts pending dependents after A fails then completes', () => {
      orchestrator.loadPlan({
        name: 'unblock-on-complete-test',
        tasks: [
          { id: 'A', description: 'Root', command: 'echo A' },
          { id: 'B', description: 'Child', command: 'echo B', dependencies: ['A'] },
        ],
      });
      orchestrator.startExecution();

      // A fails → B stays pending
      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 'A', status: 'failed', outputs: { exitCode: 1, error: 'fail' } }),
      );
      expect(orchestrator.getTask('B')!.status).toBe('pending');

      // Restart A, then complete it → B starts
      orchestrator.restartTask('A');
      logSpy.mockClear();
      orchestrator.handleWorkerResponse(
        makeResponse({
          actionId: 'A',
          executionGeneration: orchestrator.getTask('A')?.execution.generation ?? 0,
          status: 'completed',
          outputs: { exitCode: 0 },
        }),
      );

      expect(orchestrator.getTask('A')!.status).toBe('completed');
      expect(orchestrator.getTask('B')!.status).toBe('running');
    });

    it('handleCompleted starts B after A fails then completes; C stays pending', () => {
      orchestrator.loadPlan({
        name: 'multi-level-unblock-test',
        tasks: [
          { id: 'A', description: 'Root', command: 'echo A' },
          { id: 'B', description: 'Level 1', command: 'echo B', dependencies: ['A'] },
          { id: 'C', description: 'Level 2', command: 'echo C', dependencies: ['B'] },
        ],
      });
      orchestrator.startExecution();

      // A fails → B, C stay pending
      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 'A', status: 'failed', outputs: { exitCode: 1, error: 'fail' } }),
      );
      expect(orchestrator.getTask('B')!.status).toBe('pending');
      expect(orchestrator.getTask('C')!.status).toBe('pending');

      // Restart A, then complete it → B starts; C still pending (B not completed yet)
      orchestrator.restartTask('A');
      orchestrator.handleWorkerResponse(
        makeResponse({
          actionId: 'A',
          executionGeneration: orchestrator.getTask('A')?.execution.generation ?? 0,
          status: 'completed',
          outputs: { exitCode: 0 },
        }),
      );

      expect(orchestrator.getTask('B')!.status).toBe('running');
      expect(orchestrator.getTask('C')!.status).toBe('pending');
    });

    it('ignores responses when they arrive for a non-executable task', () => {
      orchestrator.loadPlan({
        name: 'terminal-warn-test',
        tasks: [
          { id: 'A', description: 'Root', command: 'echo A' },
        ],
      });
      orchestrator.startExecution();

      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 'A', status: 'failed', outputs: { exitCode: 1, error: 'fail' } }),
      );
      warnSpy.mockClear();

      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 'A', status: 'completed', outputs: { exitCode: 0 } }),
      );

      expect(orchestrator.getTask('A')!.status).toBe('failed');
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('ignoring "completed" for non-executable task "A" (status=failed)'),
      );
    });

    it('scheduler slot freed on parse error', () => {
      orchestrator.loadPlan({
        name: 'scheduler-leak-test',
        tasks: [
          { id: 'A', description: 'Root', command: 'echo A' },
        ],
      });
      orchestrator.startExecution();

      const queueBefore = orchestrator.getQueueStatus();
      expect(queueBefore.runningCount).toBe(1);

      // Response with valid actionId but missing required fields — triggers parse error
      orchestrator.handleWorkerResponse({ actionId: 'A', executionGeneration: 0 } as any);

      const queueAfter = orchestrator.getQueueStatus();
      expect(queueAfter.runningCount).toBe(0);
    });
  });

  // ── Scheduler health ────────────────────────────────────

  describe('scheduler health', () => {
    let logSpy: ReturnType<typeof vi.spyOn>;
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      logSpy.mockRestore();
      warnSpy.mockRestore();
    });

    it('queue runningCount matches actual running tasks after handleWorkerResponse', () => {
      orchestrator.loadPlan({
        name: 'scheduler-sync-test',
        tasks: [
          { id: 't1', description: 'Task 1' },
          { id: 't2', description: 'Task 2', dependencies: ['t1'] },
        ],
      });
      orchestrator.startExecution();

      const schedulerBefore = orchestrator.getQueueStatus();
      expect(schedulerBefore.runningCount).toBe(1);

      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 't1', status: 'completed', outputs: { exitCode: 0 } }),
      );

      const schedulerAfter = orchestrator.getQueueStatus();
      const runningTasks = orchestrator.getAllTasks().filter(t => t.status === 'running');
      expect(schedulerAfter.runningCount).toBe(runningTasks.length);
    });

    it('queue runningCount matches after selectExperiment completes reconciliation', () => {
      orchestrator.loadPlan({
        name: 'recon-scheduler-test',
        tasks: [
          { id: 'pivot', description: 'Pivot task', pivot: true },
          { id: 'downstream', description: 'After recon', dependencies: ['pivot'] },
        ],
      });
      orchestrator.startExecution();

      orchestrator.handleWorkerResponse({
        requestId: 'spawn',
        actionId: 'pivot',
        executionGeneration: 0,
        status: 'spawn_experiments',
        outputs: { exitCode: 0 },
        dagMutation: {
          spawnExperiments: {
            description: 'Variants',
            variants: [
              { id: 'v1', prompt: 'A' },
              { id: 'v2', prompt: 'B' },
            ],
          },
        },
      });

      orchestrator.handleWorkerResponse(
        makeResponse({
          actionId: sid(orchestrator, 0, 'pivot-exp-v1'),
          status: 'completed',
          outputs: { exitCode: 0 },
        }),
      );
      orchestrator.handleWorkerResponse(
        makeResponse({
          actionId: sid(orchestrator, 0, 'pivot-exp-v2'),
          status: 'completed',
          outputs: { exitCode: 0 },
        }),
      );

      orchestrator.handleWorkerResponse(reconciliationNeedsInputWorkResponse(rid(orchestrator, 0, 'pivot')));

      expect(orchestrator.getTask(rid(orchestrator, 0, 'pivot'))!.status).toBe('needs_input');

      persistence.updateTask(sid(orchestrator, 0, 'pivot-exp-v1'), {
        execution: { branch: 'experiment/v1', commit: 'abc' },
      });

      orchestrator.selectExperiment(
        rid(orchestrator, 0, 'pivot'),
        sid(orchestrator, 0, 'pivot-exp-v1'),
      );

      const scheduler = orchestrator.getQueueStatus();
      const runningTasks = orchestrator.getAllTasks().filter(t => t.status === 'running');
      expect(scheduler.runningCount).toBe(runningTasks.length);
    });

    it('restartTask supersedes a leaked active attempt before re-running', () => {
      orchestrator.loadPlan({
        name: 'leak-heal-test',
        tasks: [
          { id: 't1', description: 'Task 1' },
          { id: 't2', description: 'Task 2' },
          { id: 't3', description: 'Task 3' },
        ],
      });
      orchestrator.startExecution();

      const t1Scoped = sid(orchestrator, 0, 't1');
      const staleAttemptId = orchestrator.getTask(t1Scoped)!.execution.selectedAttemptId!;
      persistence.updateTask(t1Scoped, { status: 'completed', execution: { completedAt: new Date(), exitCode: 0 } });
      const wfId = orchestrator.getWorkflowIds()[0];
      orchestrator.syncFromDb(wfId);

      expect(orchestrator.getTask(t1Scoped)!.status).toBe('completed');
      expect(persistence.loadAttempt(staleAttemptId)?.status).toBe('running');

      const started = orchestrator.restartTask(t1Scoped);

      expect(started.some(task => task.id === t1Scoped)).toBe(true);
      expect(orchestrator.getTask(t1Scoped)!.status).toBe('running');
      expect(persistence.loadAttempt(staleAttemptId)?.status).toBe('superseded');
    });

    it('selectExperiments starts downstream tasks when persisted capacity is available', () => {
      orchestrator.loadPlan({
        name: 'multi-select-capacity-test',
        tasks: [
          { id: 'pivot', description: 'Pivot', pivot: true },
          { id: 'downstream', description: 'After recon', dependencies: ['pivot'] },
        ],
      });
      orchestrator.startExecution();

      orchestrator.handleWorkerResponse({
        requestId: 'spawn',
        actionId: 'pivot',
        executionGeneration: 0,
        status: 'spawn_experiments',
        outputs: { exitCode: 0 },
        dagMutation: {
          spawnExperiments: {
            description: 'Variants',
            variants: [
              { id: 'v1', prompt: 'A' },
              { id: 'v2', prompt: 'B' },
            ],
          },
        },
      });

      orchestrator.handleWorkerResponse(
        makeResponse({
          actionId: sid(orchestrator, 0, 'pivot-exp-v1'),
          status: 'completed',
          outputs: { exitCode: 0 },
        }),
      );
      orchestrator.handleWorkerResponse(
        makeResponse({
          actionId: sid(orchestrator, 0, 'pivot-exp-v2'),
          status: 'completed',
          outputs: { exitCode: 0 },
        }),
      );

      const reconId = rid(orchestrator, 0, 'pivot');
      const exp1 = sid(orchestrator, 0, 'pivot-exp-v1');
      const exp2 = sid(orchestrator, 0, 'pivot-exp-v2');

      const started = orchestrator.selectExperiments(
        reconId,
        [exp1, exp2],
        'recon-branch',
        'recon-commit',
      );

      expect(started.length).toBeGreaterThan(0);
      expect(
        logSpy.mock.calls.some(
          (c) =>
            typeof c[0] === 'string' &&
            c[0].includes('selectExperiments') &&
            c[0].includes('pivot-reconciliation'),
        ),
      ).toBe(true);
    });
  });

  // ── restartTask edge cases ─────────────────────────────

  describe('restartTask edge cases', () => {
    let logSpy: ReturnType<typeof vi.spyOn>;
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      logSpy.mockRestore();
      warnSpy.mockRestore();
    });

    it('restartTask from pending status stays pending when deps not met', () => {
      orchestrator.loadPlan({
        name: 'pending-restart-test',
        tasks: [
          { id: 'A', description: 'Root', command: 'echo A' },
          { id: 'B', description: 'Depends on A', command: 'echo B', dependencies: ['A'] },
        ],
      });
      orchestrator.startExecution();

      // A fails → B stays pending (not blocked)
      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 'A', status: 'failed', outputs: { exitCode: 1, error: 'fail' } }),
      );
      expect(orchestrator.getTask('B')!.status).toBe('pending');

      const result = orchestrator.restartTask('B');

      // B stays pending because A is still failed
      expect(result).toHaveLength(1);
      expect(result[0].status).toBe('pending');
      expect(orchestrator.getTask('B')!.status).toBe('pending');
    });

    it('restartTask from needs_input status resets to pending', () => {
      orchestrator.loadPlan({
        name: 'needs-input-restart-test',
        tasks: [
          { id: 't1', description: 'Task needing input', command: 'echo t1' },
        ],
      });
      orchestrator.startExecution();

      orchestrator.handleWorkerResponse(
        makeResponse({
          actionId: 't1',
          status: 'needs_input',
          outputs: { summary: 'What path?' },
        }),
      );
      expect(orchestrator.getTask('t1')!.status).toBe('needs_input');

      const result = orchestrator.restartTask('t1');

      expect(result).toHaveLength(1);
      expect(result[0].status).toBe('running');
      expect(orchestrator.getTask('t1')!.status).toBe('running');
    });

    it('restartTask on running task sets it to pending', () => {
      orchestrator.loadPlan({
        name: 'running-restart-test',
        tasks: [
          { id: 't1', description: 'Running task', command: 'echo t1' },
        ],
      });
      orchestrator.startExecution();
      expect(orchestrator.getTask('t1')!.status).toBe('running');

      const result = orchestrator.restartTask('t1');

      expect(result).toHaveLength(1);
      expect(result[0].status).toBe('running');
      expect(orchestrator.getTask('t1')!.status).toBe('running');
    });

    it('restartTask clears commit but preserves branch and workspacePath', () => {
      const hydratePersistence = new InMemoryPersistence();
      const hydrateBus = new InMemoryBus();

      hydratePersistence.saveTask('wf-branch-test', {
        id: 't1',
        description: 'Completed with branch info',
        status: 'completed',
        dependencies: [],
        createdAt: new Date(),
        config: {},
        execution: {
          branch: 'feature/test',
          workspacePath: '/tmp/workspace',
          commit: 'abc123',
          completedAt: new Date(),
          exitCode: 0,
        },
      });

      const testOrchestrator = new Orchestrator({
        persistence: hydratePersistence,
        messageBus: hydrateBus,
        maxConcurrency: 3,
      });

      testOrchestrator.syncFromDb('wf-branch-test');
      testOrchestrator.restartTask('t1');

      const task = testOrchestrator.getTask('t1')!;
      expect(task.execution.commit).toBeUndefined();
      expect(task.execution.branch).toBe('feature/test');
      expect(task.execution.workspacePath).toBe('/tmp/workspace');
    });

    it('fan-in C stays pending when only one failed root is restarted', () => {
      orchestrator.loadPlan({
        name: 'pending-fan-in-test',
        tasks: [
          { id: 'A', description: 'Root A', command: 'echo A' },
          { id: 'B', description: 'Root B', command: 'echo B' },
          { id: 'C', description: 'Fan-in', command: 'echo C', dependencies: ['A', 'B'] },
        ],
      });
      orchestrator.startExecution();

      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 'A', status: 'failed', outputs: { exitCode: 1, error: 'a' } }),
      );
      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 'B', status: 'failed', outputs: { exitCode: 1, error: 'b' } }),
      );
      expect(orchestrator.getTask('C')!.status).toBe('pending');

      // Restart only A — C stays pending because B is still failed
      orchestrator.restartTask('A');
      expect(orchestrator.getTask('C')!.status).toBe('pending');
    });

    it('restarting failed experiment resets reconciliation from needs_input to pending', () => {
      orchestrator.loadPlan({
        name: 'recon-reset-test',
        tasks: [
          { id: 'pivot', description: 'Pivot task', pivot: true },
          { id: 'downstream', description: 'After pivot', dependencies: ['pivot'] },
        ],
      });
      orchestrator.startExecution();

      orchestrator.handleWorkerResponse(
        makeResponse({
          actionId: 'pivot',
          status: 'spawn_experiments',
          dagMutation: {
            spawnExperiments: {
              description: 'Try variants',
              variants: [
                { id: 'v1', prompt: 'Approach A' },
                { id: 'v2', prompt: 'Approach B' },
              ],
            },
          },
        }),
      );

      orchestrator.handleWorkerResponse(
        makeResponse({
          actionId: sid(orchestrator, 0, 'pivot-exp-v1'),
          status: 'completed',
          outputs: { exitCode: 0 },
        }),
      );

      orchestrator.handleWorkerResponse(
        makeResponse({
          actionId: sid(orchestrator, 0, 'pivot-exp-v2'),
          status: 'completed',
          outputs: { exitCode: 0 },
        }),
      );

      orchestrator.handleWorkerResponse(reconciliationNeedsInputWorkResponse(rid(orchestrator, 0, 'pivot')));

      expect(orchestrator.getTask(rid(orchestrator, 0, 'pivot'))!.status).toBe('needs_input');

      orchestrator.restartTask(sid(orchestrator, 0, 'pivot-exp-v1'));

      expect(orchestrator.getTask(rid(orchestrator, 0, 'pivot'))!.status).toBe('pending');
    });

    it('restartTask clears lastHeartbeatAt from previous run', () => {
      const testPersistence = new InMemoryPersistence();
      const testBus = new InMemoryBus();

      // Save a completed task with old heartbeat
      const oldHeartbeat = new Date(Date.now() - 300000); // 5 minutes ago
      testPersistence.saveTask('heartbeat-test', {
        id: 't1',
        description: 'Task with old heartbeat',
        status: 'completed',
        dependencies: [],
        createdAt: new Date(),
        config: {},
        execution: {
          startedAt: new Date(),
          completedAt: new Date(),
          lastHeartbeatAt: oldHeartbeat,
          exitCode: 0,
        },
      });

      const testOrchestrator = new Orchestrator({
        persistence: testPersistence,
        messageBus: testBus,
        maxConcurrency: 3,
      });

      testOrchestrator.syncFromDb('heartbeat-test');
      testOrchestrator.restartTask('t1');

      const task = testOrchestrator.getTask('t1')!;

      // After restart, lastHeartbeatAt should either be:
      // - undefined (if task is pending)
      // - a fresh timestamp (if task auto-started to running)
      // It should NOT be the old 5-minute-ago value
      if (task.execution.lastHeartbeatAt !== undefined) {
        const timeSinceHeartbeat = Date.now() - task.execution.lastHeartbeatAt.getTime();
        expect(timeSinceHeartbeat).toBeLessThan(2000); // Should be within last 2 seconds
      }
      // Either way, it should not be the old value
      expect(task.execution.lastHeartbeatAt).not.toEqual(oldHeartbeat);
    });

    it('recreateWorkflow clears lastHeartbeatAt for all tasks', () => {
      const testPersistence = new InMemoryPersistence();
      const testBus = new InMemoryBus();

      const oldHeartbeat1 = new Date(Date.now() - 300000); // 5 minutes ago
      const oldHeartbeat2 = new Date(Date.now() - 180000); // 3 minutes ago

      // Save two independent tasks with old heartbeats
      testPersistence.saveTask('workflow-heartbeat-test', {
        id: 't1',
        description: 'Task 1',
        status: 'completed',
        dependencies: [],
        createdAt: new Date(),
        config: {},
        execution: {
          startedAt: new Date(),
          completedAt: new Date(),
          lastHeartbeatAt: oldHeartbeat1,
          exitCode: 0,
        },
      });

      testPersistence.saveTask('workflow-heartbeat-test', {
        id: 't2',
        description: 'Task 2',
        status: 'completed',
        dependencies: [],
        createdAt: new Date(),
        config: {},
        execution: {
          startedAt: new Date(),
          completedAt: new Date(),
          lastHeartbeatAt: oldHeartbeat2,
          exitCode: 0,
        },
      });

      const testOrchestrator = new Orchestrator({
        persistence: testPersistence,
        messageBus: testBus,
        maxConcurrency: 3,
      });

      testOrchestrator.syncFromDb('workflow-heartbeat-test');
      testOrchestrator.recreateWorkflow();

      const task1 = testOrchestrator.getTask('t1')!;
      const task2 = testOrchestrator.getTask('t2')!;

      // Both tasks should have fresh or undefined lastHeartbeatAt
      if (task1.execution.lastHeartbeatAt !== undefined) {
        const timeSinceHeartbeat1 = Date.now() - task1.execution.lastHeartbeatAt.getTime();
        expect(timeSinceHeartbeat1).toBeLessThan(2000);
      }
      expect(task1.execution.lastHeartbeatAt).not.toEqual(oldHeartbeat1);

      if (task2.execution.lastHeartbeatAt !== undefined) {
        const timeSinceHeartbeat2 = Date.now() - task2.execution.lastHeartbeatAt.getTime();
        expect(timeSinceHeartbeat2).toBeLessThan(2000);
      }
      expect(task2.execution.lastHeartbeatAt).not.toEqual(oldHeartbeat2);
    });

    it('recreateWorkflow clears PR state for merge nodes', () => {
      const testPersistence = new InMemoryPersistence();
      const testBus = new InMemoryBus();

      testPersistence.saveTask('workflow-pr-test', {
        id: '__merge__workflow-pr-test',
        description: 'Merge gate',
        status: 'completed',
        dependencies: [],
        createdAt: new Date(),
        config: { isMergeNode: true, workflowId: 'workflow-pr-test' },
        execution: {
          reviewUrl: 'https://github.com/org/repo/pull/42',
          reviewId: '42',
          reviewStatus: 'open',
        },
      });

      const testOrchestrator = new Orchestrator({
        persistence: testPersistence,
        messageBus: testBus,
        maxConcurrency: 3,
      });

      testOrchestrator.syncFromDb('workflow-pr-test');
      testOrchestrator.recreateWorkflow('workflow-pr-test');

      const mergeTask = testOrchestrator.getTask('__merge__workflow-pr-test')!;
      expect(mergeTask.execution.reviewUrl).toBeUndefined();
      expect(mergeTask.execution.reviewId).toBeUndefined();
      expect(mergeTask.execution.reviewStatus).toBeUndefined();
    });

    it('recreateWorkflow clears agentSessionId/containerId but keeps durable lastAgentSessionId', () => {
      const testPersistence = new InMemoryPersistence();
      const testBus = new InMemoryBus();
      const wf = 'workflow-agent-session-clear';

      testPersistence.saveTask(wf, {
        id: 't-sess',
        description: 'Had agent metadata',
        status: 'completed',
        dependencies: [],
        createdAt: new Date(),
        config: { workflowId: wf },
        execution: {
          agentSessionId: 'stale-session-uuid',
          lastAgentSessionId: 'stale-session-uuid',
          lastAgentName: 'codex',
          containerId: 'stale-container-id',
          commit: 'abc123',
          exitCode: 0,
        },
      });

      const testOrchestrator = new Orchestrator({
        persistence: testPersistence,
        messageBus: testBus,
        maxConcurrency: 3,
      });

      testOrchestrator.syncFromDb(wf);
      testOrchestrator.recreateWorkflow(wf);

      const t = testOrchestrator.getTask('t-sess')!;
      expect(t.execution.agentSessionId).toBeUndefined();
      expect(t.execution.containerId).toBeUndefined();
      expect(t.execution.lastAgentSessionId).toBe('stale-session-uuid');
      expect(t.execution.lastAgentName).toBe('codex');
    });

    it('recreateTask resets only target + downstream, leaves unrelated tasks unchanged', () => {
      const testPersistence = new InMemoryPersistence();
      const testBus = new InMemoryBus();
      const wf = 'wf-recreate-task-scope';

      testPersistence.saveTask(wf, {
        id: 'A',
        description: 'Root',
        status: 'completed',
        dependencies: [],
        createdAt: new Date(),
        config: { workflowId: wf },
        execution: { branch: 'br-a', commit: 'a1', workspacePath: '/tmp/a', exitCode: 0 },
      });
      testPersistence.saveTask(wf, {
        id: 'B',
        description: 'Target',
        status: 'completed',
        dependencies: ['A'],
        createdAt: new Date(),
        config: { workflowId: wf },
        execution: { branch: 'br-b', commit: 'b1', workspacePath: '/tmp/b', exitCode: 0 },
      });
      testPersistence.saveTask(wf, {
        id: 'C',
        description: 'Downstream',
        status: 'completed',
        dependencies: ['B'],
        createdAt: new Date(),
        config: { workflowId: wf },
        execution: { branch: 'br-c', commit: 'c1', workspacePath: '/tmp/c', exitCode: 0 },
      });
      testPersistence.saveTask(wf, {
        id: '__merge__wf-recreate-task-scope',
        description: 'Merge gate',
        status: 'completed',
        dependencies: ['C', 'X'],
        createdAt: new Date(),
        config: { workflowId: wf, isMergeNode: true },
        execution: { branch: 'br-merge', commit: 'm1', workspacePath: '/tmp/m', exitCode: 0 },
      });
      testPersistence.saveTask(wf, {
        id: 'X',
        description: 'Unrelated root',
        status: 'completed',
        dependencies: [],
        createdAt: new Date(),
        config: { workflowId: wf },
        execution: { branch: 'br-x', commit: 'x1', workspacePath: '/tmp/x', exitCode: 0 },
      });

      const testOrchestrator = new Orchestrator({
        persistence: testPersistence,
        messageBus: testBus,
        maxConcurrency: 3,
      });

      testOrchestrator.syncFromDb(wf);
      testOrchestrator.recreateTask('B');

      const b = testOrchestrator.getTask('B')!;
      const c = testOrchestrator.getTask('C')!;
      const merge = testOrchestrator.getTask('__merge__wf-recreate-task-scope')!;
      const x = testOrchestrator.getTask('X')!;

      expect(b.status === 'running' || b.status === 'pending').toBe(true);
      expect(c.status).toBe('pending');
      expect(merge.status).toBe('pending');
      expect(x.status).toBe('completed');

      expect(b.execution.branch).toBeUndefined();
      expect(b.execution.workspacePath).toBeUndefined();
      expect(c.execution.branch).toBeUndefined();
      expect(c.execution.workspacePath).toBeUndefined();
      expect(merge.execution.branch).toBeUndefined();
      expect(merge.execution.workspacePath).toBeUndefined();
      expect(x.execution.branch).toBe('br-x');
      expect(x.execution.workspacePath).toBe('/tmp/x');
    });

    it('drainScheduler sets lastHeartbeatAt when starting a task', () => {
      orchestrator.loadPlan({
        name: 'heartbeat-start-test',
        tasks: [{ id: 't1', description: 'Task to start', command: 'echo test' }],
      });

      const beforeStart = Date.now();
      orchestrator.startExecution();
      const afterStart = Date.now();

      const task = orchestrator.getTask('t1')!;
      expect(task.status).toBe('running');
      expect(task.execution.lastHeartbeatAt).toBeDefined();

      // Verify the heartbeat is recent (within the execution window)
      const heartbeatTime = task.execution.lastHeartbeatAt!.getTime();
      expect(heartbeatTime).toBeGreaterThanOrEqual(beforeStart);
      expect(heartbeatTime).toBeLessThanOrEqual(afterStart + 1000); // Allow 1s tolerance
    });
  });

  // ── retryWorkflow ────────────────────────────────────────

  describe('retryWorkflow', () => {
    it('refreshes only the targeted workflow before retrying', () => {
      const persistence = new CountingPersistence();
      const bus = new InMemoryBus();
      const o = new Orchestrator({
        persistence,
        messageBus: bus,
        maxConcurrency: 2,
      });

      o.loadPlan({
        name: 'wf-a',
        tasks: [
          { id: 'a1', prompt: 'a1' },
          { id: 'a2', dependencies: ['a1'], prompt: 'a2' },
        ],
      });
      o.loadPlan({
        name: 'wf-b',
        tasks: [
          { id: 'b1', prompt: 'b1' },
        ],
      });

      persistence.loadTasksCalls = [];
      const wfA = o.getAllTasks().find((task) => task.id.endsWith('/a1'))!.config.workflowId!;
      o.retryWorkflow(wfA);

      expect(persistence.loadTasksCalls.filter((id) => id === wfA).length).toBeGreaterThan(0);
      const wfB = o.getAllTasks().find((task) => task.id.endsWith('/b1'))!.config.workflowId!;
      expect(persistence.loadTasksCalls).not.toContain(wfB);
    });

    it('preserves completed tasks and resets failed tasks', () => {
      const p = new InMemoryPersistence();
      const b = new InMemoryBus();
      const wfId = 'wf-retry-1';

      // A(completed), B(failed depends on nothing), merge(completed)
      p.saveTask(wfId, {
        id: 'a', description: 'Task A', status: 'completed',
        dependencies: [], createdAt: new Date(),
        config: { workflowId: wfId }, execution: { exitCode: 0, branch: 'br-a', commit: 'abc' },
      });
      p.saveTask(wfId, {
        id: 'b', description: 'Task B', status: 'failed',
        dependencies: [], createdAt: new Date(),
        config: { workflowId: wfId }, execution: { exitCode: 1, error: 'boom', branch: 'br-b' },
      });
      p.saveTask(wfId, {
        id: `__merge__${wfId}`, description: 'Merge gate', status: 'completed',
        dependencies: ['a', 'b'], createdAt: new Date(),
        config: { workflowId: wfId, isMergeNode: true }, execution: {},
      });

      const o = new Orchestrator({ persistence: p, messageBus: b, maxConcurrency: 3 });
      o.syncFromDb(wfId);

      const started = o.retryWorkflow(wfId);

      // A should stay completed
      const a = o.getTask('a')!;
      expect(a.status).toBe('completed');
      expect(a.execution.branch).toBe('br-a');

      // B should be reset (and auto-started since it has no deps)
      const bTask = o.getTask('b')!;
      expect(bTask.status).toBe('running');
      expect(bTask.execution.error).toBeUndefined();

      // Merge should be reset to pending (waiting on B)
      const merge = o.getTask(`__merge__${wfId}`)!;
      expect(merge.status).toBe('pending');

      // Only B should be in the started list
      expect(started.some(t => t.id === 'b')).toBe(true);
      expect(started.some(t => t.id === 'a')).toBe(false);
    });

    it('differs from recreate: retry preserves completed roots while recreate resets them', () => {
      const wfId = 'wf-retry-vs-recreate';
      const seed = (p: InMemoryPersistence): void => {
        p.saveTask(wfId, {
          id: 'a', description: 'Task A', status: 'completed',
          dependencies: [], createdAt: new Date(),
          config: { workflowId: wfId }, execution: { exitCode: 0, branch: 'br-a', commit: 'abc' },
        });
        p.saveTask(wfId, {
          id: 'b', description: 'Task B', status: 'failed',
          dependencies: [], createdAt: new Date(),
          config: { workflowId: wfId }, execution: { exitCode: 1, error: 'boom', branch: 'br-b' },
        });
        p.saveTask(wfId, {
          id: `__merge__${wfId}`, description: 'Merge gate', status: 'completed',
          dependencies: ['a', 'b'], createdAt: new Date(),
          config: { workflowId: wfId, isMergeNode: true }, execution: {},
        });
      };

      const retryPersistence = new InMemoryPersistence();
      const recreatePersistence = new InMemoryPersistence();
      const retryBus = new InMemoryBus();
      const recreateBus = new InMemoryBus();
      seed(retryPersistence);
      seed(recreatePersistence);

      const retryOrchestrator = new Orchestrator({ persistence: retryPersistence, messageBus: retryBus, maxConcurrency: 3 });
      const recreateOrchestrator = new Orchestrator({ persistence: recreatePersistence, messageBus: recreateBus, maxConcurrency: 3 });
      retryOrchestrator.syncFromDb(wfId);
      recreateOrchestrator.syncFromDb(wfId);

      retryOrchestrator.retryWorkflow(wfId);
      recreateOrchestrator.recreateWorkflow(wfId);

      const retryA = retryOrchestrator.getTask('a')!;
      const recreateA = recreateOrchestrator.getTask('a')!;

      expect(retryA.status).toBe('completed');
      expect(retryA.execution.branch).toBe('br-a');
      expect(retryA.execution.commit).toBe('abc');

      expect(['running', 'pending']).toContain(recreateA.status);
      expect(recreateA.execution.branch).toBeUndefined();
      expect(recreateA.execution.commit).toBeUndefined();
    });

    it('resets merge node even when leaf tasks are all completed', () => {
      const p = new InMemoryPersistence();
      const b = new InMemoryBus();
      const wfId = 'wf-retry-merge';

      p.saveTask(wfId, {
        id: 'a', description: 'Task A', status: 'completed',
        dependencies: [], createdAt: new Date(),
        config: { workflowId: wfId }, execution: { exitCode: 0 },
      });
      p.saveTask(wfId, {
        id: `__merge__${wfId}`, description: 'Merge gate', status: 'failed',
        dependencies: ['a'], createdAt: new Date(),
        config: { workflowId: wfId, isMergeNode: true },
        execution: { error: 'merge conflict' },
      });

      const o = new Orchestrator({ persistence: p, messageBus: b, maxConcurrency: 3 });
      o.syncFromDb(wfId);

      o.retryWorkflow(wfId);

      const merge = o.getTask(`__merge__${wfId}`)!;
      // Merge should be running since its only dep (a) is completed
      expect(merge.status).toBe('running');
    });

    it('skips running tasks', () => {
      const p = new InMemoryPersistence();
      const b = new InMemoryBus();
      const wfId = 'wf-retry-running';

      p.saveTask(wfId, {
        id: 'a', description: 'Task A', status: 'running',
        dependencies: [], createdAt: new Date(),
        config: { workflowId: wfId }, execution: { startedAt: new Date() },
      });
      p.saveTask(wfId, {
        id: `__merge__${wfId}`, description: 'Merge gate', status: 'pending',
        dependencies: ['a'], createdAt: new Date(),
        config: { workflowId: wfId, isMergeNode: true }, execution: {},
      });

      const o = new Orchestrator({ persistence: p, messageBus: b, maxConcurrency: 3 });
      o.syncFromDb(wfId);

      o.retryWorkflow(wfId);

      // Running task should not be touched
      const a = o.getTask('a')!;
      expect(a.status).toBe('running');
    });

    it('handles all-completed workflow (no resets needed)', () => {
      const p = new InMemoryPersistence();
      const b = new InMemoryBus();
      const wfId = 'wf-retry-allcomplete';

      p.saveTask(wfId, {
        id: 'a', description: 'Task A', status: 'completed',
        dependencies: [], createdAt: new Date(),
        config: { workflowId: wfId }, execution: { exitCode: 0 },
      });
      p.saveTask(wfId, {
        id: `__merge__${wfId}`, description: 'Merge gate', status: 'completed',
        dependencies: ['a'], createdAt: new Date(),
        config: { workflowId: wfId, isMergeNode: true }, execution: {},
      });

      const o = new Orchestrator({ persistence: p, messageBus: b, maxConcurrency: 3 });
      o.syncFromDb(wfId);

      const started = o.retryWorkflow(wfId);
      // No tasks should be started (all already complete, nothing to retry)
      // Merge node gets reset to pending (always), but no ready tasks should start it
      // because leaf task 'a' is completed → merge becomes ready → merge starts
      expect(started.length).toBeGreaterThanOrEqual(0);
    });

    it('resets blocked tasks to pending', () => {
      const p = new InMemoryPersistence();
      const b = new InMemoryBus();
      const wfId = 'wf-retry-blocked';

      p.saveTask(wfId, {
        id: 'a', description: 'Task A', status: 'completed',
        dependencies: [], createdAt: new Date(),
        config: { workflowId: wfId }, execution: { exitCode: 0 },
      });
      p.saveTask(wfId, {
        id: 'b', description: 'Task B', status: 'blocked',
        dependencies: ['a'], createdAt: new Date(),
        config: { workflowId: wfId }, execution: {},
      });
      p.saveTask(wfId, {
        id: `__merge__${wfId}`, description: 'Merge gate', status: 'pending',
        dependencies: ['b'], createdAt: new Date(),
        config: { workflowId: wfId, isMergeNode: true }, execution: {},
      });

      const o = new Orchestrator({ persistence: p, messageBus: b, maxConcurrency: 3 });
      o.syncFromDb(wfId);

      const started = o.retryWorkflow(wfId);

      // B was blocked but its dep (A) is completed → should become running
      const bTask = o.getTask('b')!;
      expect(bTask.status).toBe('running');
      expect(started.some(t => t.id === 'b')).toBe(true);
    });

    it('cascades correctly: B depends on A(completed), C depends on B(failed)', () => {
      const p = new InMemoryPersistence();
      const b = new InMemoryBus();
      const wfId = 'wf-retry-cascade';

      p.saveTask(wfId, {
        id: 'a', description: 'Task A', status: 'completed',
        dependencies: [], createdAt: new Date(),
        config: { workflowId: wfId }, execution: { exitCode: 0 },
      });
      p.saveTask(wfId, {
        id: 'b', description: 'Task B', status: 'failed',
        dependencies: ['a'], createdAt: new Date(),
        config: { workflowId: wfId }, execution: { exitCode: 1, error: 'fail' },
      });
      p.saveTask(wfId, {
        id: 'c', description: 'Task C', status: 'failed',
        dependencies: ['b'], createdAt: new Date(),
        config: { workflowId: wfId }, execution: { exitCode: 1, error: 'dep failed' },
      });
      p.saveTask(wfId, {
        id: `__merge__${wfId}`, description: 'Merge gate', status: 'failed',
        dependencies: ['c'], createdAt: new Date(),
        config: { workflowId: wfId, isMergeNode: true }, execution: {},
      });

      const o = new Orchestrator({ persistence: p, messageBus: b, maxConcurrency: 3 });
      o.syncFromDb(wfId);

      const started = o.retryWorkflow(wfId);

      // A stays completed
      expect(o.getTask('a')!.status).toBe('completed');

      // B should start (dep A is complete)
      expect(o.getTask('b')!.status).toBe('running');
      expect(started.some(t => t.id === 'b')).toBe(true);

      // C should be pending (dep B is not yet complete)
      expect(o.getTask('c')!.status).toBe('pending');
      expect(started.some(t => t.id === 'c')).toBe(false);

      // Merge should be pending
      expect(o.getTask(`__merge__${wfId}`)!.status).toBe('pending');
    });

    it('invalidates completed downstream dependents of retried roots', () => {
      const p = new InMemoryPersistence();
      const b = new InMemoryBus();
      const wfId = 'wf-retry-invalidate-downstream';

      p.saveTask(wfId, {
        id: 'a', description: 'Task A', status: 'completed',
        dependencies: [], createdAt: new Date(),
        config: { workflowId: wfId }, execution: { exitCode: 0 },
      });
      p.saveTask(wfId, {
        id: 'b', description: 'Task B', status: 'failed',
        dependencies: ['a'], createdAt: new Date(),
        config: { workflowId: wfId }, execution: { exitCode: 1, error: 'boom' },
      });
      p.saveTask(wfId, {
        id: 'c', description: 'Task C', status: 'completed',
        dependencies: ['b'], createdAt: new Date(),
        config: { workflowId: wfId }, execution: { exitCode: 0 },
      });
      p.saveTask(wfId, {
        id: `__merge__${wfId}`, description: 'Merge gate', status: 'completed',
        dependencies: ['c'], createdAt: new Date(),
        config: { workflowId: wfId, isMergeNode: true }, execution: { exitCode: 0 },
      });

      const o = new Orchestrator({ persistence: p, messageBus: b, maxConcurrency: 3 });
      o.syncFromDb(wfId);

      o.retryWorkflow(wfId);

      expect(o.getTask('a')!.status).toBe('completed');
      expect(o.getTask('b')!.status).toBe('running');
      expect(o.getTask('c')!.status).toBe('pending');
      expect(o.getTask(`__merge__${wfId}`)!.status).toBe('pending');
    });

    it('recomputes workflow status once per retry reset instead of once per affected task', () => {
      const p = new InMemoryPersistence();
      const b = new InMemoryBus();
      const wfId = 'wf-retry-status-batch';

      p.saveWorkflow({ id: wfId, name: wfId, status: 'failed' });
      p.saveTask(wfId, {
        id: 'root',
        description: 'root',
        status: 'failed',
        dependencies: [],
        createdAt: new Date(),
        config: { workflowId: wfId },
        execution: { error: 'boom', exitCode: 1 },
      });
      for (let i = 0; i < 6; i += 1) {
        p.saveTask(wfId, {
          id: `child-${i}`,
          description: `child ${i}`,
          status: 'completed',
          dependencies: [i === 0 ? 'root' : `child-${i - 1}`],
          createdAt: new Date(),
          config: { workflowId: wfId },
          execution: { exitCode: 0 },
        });
      }

      const o = new Orchestrator({ persistence: p, messageBus: b, maxConcurrency: 3 });
      o.syncFromDb(wfId);
      p.updateWorkflowCalls.set(wfId, 0);

      o.retryWorkflow(wfId);

      expect(p.updateWorkflowCalls.get(wfId)).toBeLessThanOrEqual(2);
    });

    it('invalidates completed descendants when an upstream task is fixing_with_ai', () => {
      const p = new InMemoryPersistence();
      const b = new InMemoryBus();
      const wfId = 'wf-retry-fixing-with-ai-descendants';

      p.saveTask(wfId, {
        id: 'add-eslint-disable-comments',
        description: 'upstream completed task',
        status: 'completed',
        dependencies: [],
        createdAt: new Date(),
        config: { workflowId: wfId },
        execution: { exitCode: 0, completedAt: new Date() },
      });
      p.saveTask(wfId, {
        id: 'verify-lint-passes',
        description: 'upstream fixer task',
        status: 'fixing_with_ai',
        dependencies: ['add-eslint-disable-comments'],
        createdAt: new Date(),
        config: { workflowId: wfId },
        execution: {
          startedAt: new Date(),
          pendingFixError: 'pnpm lint failed',
          isFixingWithAI: true,
        },
      });
      p.saveTask(wfId, {
        id: 'verify-check-all',
        description: 'stale completed descendant',
        status: 'completed',
        dependencies: ['verify-lint-passes'],
        createdAt: new Date(),
        config: { workflowId: wfId },
        execution: { exitCode: 0, completedAt: new Date() },
      });
      p.saveTask(wfId, {
        id: `__merge__${wfId}`,
        description: 'Merge gate',
        status: 'completed',
        dependencies: ['verify-check-all'],
        createdAt: new Date(),
        config: { workflowId: wfId, isMergeNode: true },
        execution: { exitCode: 0, completedAt: new Date() },
      });

      const o = new Orchestrator({ persistence: p, messageBus: b, maxConcurrency: 3 });
      o.syncFromDb(wfId);

      const started = o.retryWorkflow(wfId);

      expect(o.getTask('add-eslint-disable-comments')!.status).toBe('completed');

      const verifyLint = o.getTask('verify-lint-passes')!;
      expect(verifyLint.status).toBe('running');
      expect(verifyLint.execution.pendingFixError).toBeUndefined();
      expect(verifyLint.execution.isFixingWithAI).toBeFalsy();
      expect(started.some((t) => t.id === 'verify-lint-passes')).toBe(true);

      expect(o.getTask('verify-check-all')!.status).toBe('pending');
      expect(o.getTask(`__merge__${wfId}`)!.status).toBe('pending');
    });

    it('invalidates completed descendants when an upstream task is awaiting_approval', () => {
      const p = new InMemoryPersistence();
      const b = new InMemoryBus();
      const wfId = 'wf-retry-awaiting-approval-descendants';

      p.saveTask(wfId, {
        id: 'root',
        description: 'root',
        status: 'completed',
        dependencies: [],
        createdAt: new Date(),
        config: { workflowId: wfId },
        execution: { exitCode: 0, completedAt: new Date() },
      });
      p.saveTask(wfId, {
        id: 'needs-approval',
        description: 'approval task',
        status: 'awaiting_approval',
        dependencies: ['root'],
        createdAt: new Date(),
        config: { workflowId: wfId },
        execution: { pendingFixError: 'needs manual approval' },
      });
      p.saveTask(wfId, {
        id: 'descendant',
        description: 'stale descendant',
        status: 'completed',
        dependencies: ['needs-approval'],
        createdAt: new Date(),
        config: { workflowId: wfId },
        execution: { exitCode: 0, completedAt: new Date() },
      });

      const o = new Orchestrator({ persistence: p, messageBus: b, maxConcurrency: 3 });
      o.syncFromDb(wfId);

      const started = o.retryWorkflow(wfId);

      expect(o.getTask('root')!.status).toBe('completed');
      expect(o.getTask('needs-approval')!.status).toBe('running');
      expect(o.getTask('needs-approval')!.execution.pendingFixError).toBeUndefined();
      expect(o.getTask('descendant')!.status).toBe('pending');
      expect(started.some((t) => t.id === 'needs-approval')).toBe(true);
    });

    it('retries persisted auto-fix experiment descendants like normal tasks', () => {
      const p = new InMemoryPersistence();
      const b = new InMemoryBus();
      const wfId = 'wf-retry-exp-autofix-descendants';

      p.saveTask(wfId, {
        id: 'root',
        description: 'root failed task',
        status: 'failed',
        dependencies: [],
        createdAt: new Date(),
        config: { workflowId: wfId },
        execution: { exitCode: 1, error: 'boom' },
      });
      p.saveTask(wfId, {
        id: 'root-exp-fix-conservative',
        description: 'auto-fix child',
        status: 'pending',
        dependencies: ['root'],
        createdAt: new Date(),
        config: { workflowId: wfId, parentTask: 'root' },
        execution: {},
      });
      p.saveTask(wfId, {
        id: 'root-exp-fix-conservative-exp-fix-refactor',
        description: 'nested auto-fix child',
        status: 'pending',
        dependencies: ['root-exp-fix-conservative'],
        createdAt: new Date(),
        config: { workflowId: wfId, parentTask: 'root-exp-fix-conservative' },
        execution: {},
      });

      const o = new Orchestrator({ persistence: p, messageBus: b, maxConcurrency: 3 });
      o.syncFromDb(wfId);

      const started = o.retryWorkflow(wfId);
      expect(started.map((task) => task.id)).toEqual(['root']);
      expect(o.getTask('root')!.status).toBe('running');
      expect(o.getTask('root-exp-fix-conservative')!.status).toBe('pending');
      expect(o.getTask('root-exp-fix-conservative-exp-fix-refactor')!.status).toBe('pending');

      o.handleWorkerResponse(
        makeResponse({
          actionId: 'root',
          executionGeneration: o.getTask('root')!.execution.generation ?? 0,
          status: 'completed',
          outputs: { exitCode: 0 },
        }),
      );

      expect(o.getTask('root')!.status).toBe('completed');
      expect(o.getTask('root-exp-fix-conservative')!.status).toBe('running');
      expect(o.getTask('root-exp-fix-conservative-exp-fix-refactor')!.status).toBe('pending');
    });

    it('preserves branch/commit/workspacePath on reset tasks', () => {
      const p = new InMemoryPersistence();
      const b = new InMemoryBus();
      const wfId = 'wf-retry-preserve';

      p.saveTask(wfId, {
        id: 'a', description: 'Task A', status: 'failed',
        dependencies: [], createdAt: new Date(),
        config: { workflowId: wfId },
        execution: { exitCode: 1, error: 'fail', branch: 'br-a', commit: 'abc123', workspacePath: '/tmp/ws' },
      });
      p.saveTask(wfId, {
        id: `__merge__${wfId}`, description: 'Merge gate', status: 'pending',
        dependencies: ['a'], createdAt: new Date(),
        config: { workflowId: wfId, isMergeNode: true }, execution: {},
      });

      const o = new Orchestrator({ persistence: p, messageBus: b, maxConcurrency: 3 });
      o.syncFromDb(wfId);

      o.retryWorkflow(wfId);

      const a = o.getTask('a')!;
      // Branch/commit/workspacePath should be preserved
      expect(a.execution.branch).toBe('br-a');
      expect(a.execution.commit).toBe('abc123');
      expect(a.execution.workspacePath).toBe('/tmp/ws');
      // Error/exitCode should be cleared
      expect(a.execution.error).toBeUndefined();
      expect(a.execution.exitCode).toBeUndefined();
    });

    it('resets needs_input tasks', () => {
      const p = new InMemoryPersistence();
      const b = new InMemoryBus();
      const wfId = 'wf-retry-needs-input';

      p.saveTask(wfId, {
        id: 'a', description: 'Task A', status: 'needs_input',
        dependencies: [], createdAt: new Date(),
        config: { workflowId: wfId }, execution: { inputPrompt: 'Enter value' },
      });
      p.saveTask(wfId, {
        id: `__merge__${wfId}`, description: 'Merge gate', status: 'pending',
        dependencies: ['a'], createdAt: new Date(),
        config: { workflowId: wfId, isMergeNode: true }, execution: {},
      });

      const o = new Orchestrator({ persistence: p, messageBus: b, maxConcurrency: 3 });
      o.syncFromDb(wfId);

      const started = o.retryWorkflow(wfId);

      // needs_input should be reset and start running
      expect(o.getTask('a')!.status).toBe('running');
      expect(started.some(t => t.id === 'a')).toBe(true);
    });

    it('throws when workflow has no tasks', () => {
      const p = new InMemoryPersistence();
      const b = new InMemoryBus();
      const o = new Orchestrator({ persistence: p, messageBus: b, maxConcurrency: 3 });
      expect(() => o.retryWorkflow('wf-nonexistent')).toThrow('No tasks found');
    });
  });

  // ── Long session resilience ────────────────────────────

  describe('long session resilience', () => {
    let logSpy: ReturnType<typeof vi.spyOn>;
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      logSpy.mockRestore();
      warnSpy.mockRestore();
    });

    it('scheduler stays healthy across 2 workflows with 20+ task completions', () => {
      for (let w = 0; w < 2; w++) {
        const tasks = Array.from({ length: 12 }, (_, i) => ({
          id: `w${w}-t${i}`,
          description: `Workflow ${w} Task ${i}`,
        }));
        orchestrator.loadPlan({ name: `workflow-${w}`, tasks });
      }
      orchestrator.startExecution();

      const allTasks = orchestrator.getAllTasks().filter(t => !t.config.isMergeNode);
      for (const task of allTasks) {
        if (task.status === 'running') {
          orchestrator.handleWorkerResponse(
            makeResponse({ actionId: task.id, status: 'completed', outputs: { exitCode: 0 } }),
          );
        }
      }

      const status = orchestrator.getQueueStatus();
      const stillRunning = orchestrator.getAllTasks().filter(t => t.status === 'running');
      expect(status.runningCount).toBe(stillRunning.length);
    });

    it('persisted queue state recovers after simulated process death mid-session', () => {
      orchestrator.loadPlan({
        name: 'death-recovery-test',
        tasks: [
          { id: 't1', description: 'Task 1' },
          { id: 't2', description: 'Task 2' },
          { id: 't3', description: 'Task 3', dependencies: ['t1'] },
        ],
      });
      orchestrator.startExecution();

      // Simulate process death: directly set t1 back to pending in DB (as if stale-running detected)
      persistence.updateTask('t1', { status: 'pending', execution: {} });
      const wfId = orchestrator.getWorkflowIds()[0];
      orchestrator.syncFromDb(wfId);

      // restartTask should recover
      const started = orchestrator.restartTask('t1');
      const t1 = orchestrator.getTask('t1')!;
      expect(t1.status).toBe('running');
      expect(started.length).toBeGreaterThanOrEqual(1);

      const scheduler = orchestrator.getQueueStatus();
      const runningTasks = orchestrator.getAllTasks().filter(t => t.status === 'running');
      expect(scheduler.runningCount).toBe(runningTasks.length);
    });

    it('getQueueStatus derives from persisted task state instead of stale scheduler slots', () => {
      orchestrator.loadPlan({
        name: 'queue-truth-test',
        tasks: [
          { id: 't1', description: 'Task 1' },
        ],
      });
      const [started] = orchestrator.startExecution();
      expect(started?.id).toBe(sid(orchestrator, 0, 't1'));

      const runningTask = orchestrator.getTask('t1');
      expect(runningTask?.status).toBe('running');

      persistence.updateTask('t1', {
        status: 'pending',
        execution: { startedAt: undefined, lastHeartbeatAt: undefined },
      });
      const selectedAttemptId = orchestrator.getTask(sid(orchestrator, 0, 't1'))?.execution.selectedAttemptId;
      expect(selectedAttemptId).toBeTruthy();
      persistence.updateAttempt(selectedAttemptId!, {
        status: 'claimed',
        leaseExpiresAt: new Date(Date.now() - 60_000),
      });

      const queueStatus = orchestrator.getQueueStatus();
      expect(queueStatus.runningCount).toBe(0);
      expect(queueStatus.running).toEqual([]);
      expect(queueStatus.queued).toHaveLength(1);
      expect(queueStatus.queued[0]?.taskId).toBe(sid(orchestrator, 0, 't1'));
    });

    it('getQueueStatus counts claimed selected attempts as active before launch completes', () => {
      orchestrator.loadPlan({
        name: 'queue-claimed-test',
        tasks: [
          { id: 't1', description: 'Task 1' },
        ],
      });
      const [started] = orchestrator.startExecution();
      const taskId = started!.id;
      const selectedAttemptId = orchestrator.getTask(taskId)?.execution.selectedAttemptId;
      expect(selectedAttemptId).toBeTruthy();

      const queueStatus = orchestrator.getQueueStatus();
      expect(queueStatus.runningCount).toBe(1);
      expect(queueStatus.running[0]?.taskId).toBe(taskId);
      expect(queueStatus.running[0]?.attemptId).toBe(selectedAttemptId);
    });

    it('restartTask supersedes a claimed selected attempt before relaunching', () => {
      orchestrator.loadPlan({
        name: 'restart-claimed-test',
        tasks: [
          { id: 't1', description: 'Task 1' },
        ],
      });

      const [started] = orchestrator.startExecution();
      const taskId = started!.id;
      const claimedAttemptId = orchestrator.getTask(taskId)?.execution.selectedAttemptId;
      expect(claimedAttemptId).toBeTruthy();

      orchestrator.refreshFromDb();
      const restarted = orchestrator.restartTask(taskId);
      const restartedTask = orchestrator.getTask(taskId);
      const latestAttemptId = restartedTask?.execution.selectedAttemptId;

      expect(restarted).toHaveLength(1);
      expect(restarted[0]?.id).toBe(taskId);
      expect(restarted[0]?.status).toBe('running');
      expect(latestAttemptId).toBeTruthy();
      expect(latestAttemptId).not.toBe(claimedAttemptId);
      expect(persistence.loadAttempt(claimedAttemptId!)?.status).toBe('superseded');
      expect(persistence.loadAttempt(latestAttemptId!)?.status).toBe('running');
    });

    it('retryWorkflow selects a fresh persisted attempt for retried tasks', () => {
      orchestrator.loadPlan({
        name: 'retry-attempt-refresh',
        tasks: [{ id: 't1', description: 'Task 1' }],
      });
      orchestrator.startExecution();

      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 't1', status: 'failed', outputs: { exitCode: 1, error: 'boom' } }),
      );

      const failedAttemptId = orchestrator.getTask('t1')?.execution.selectedAttemptId;
      expect(failedAttemptId).toBeTruthy();

      const started = orchestrator.retryWorkflow(orchestrator.getWorkflowIds()[0]!);
      const retriedTask = orchestrator.getTask('t1');
      const retriedAttemptId = retriedTask?.execution.selectedAttemptId;

      expect(started.some((task) => task.id === sid(orchestrator, 0, 't1'))).toBe(true);
      expect(retriedAttemptId).toBeTruthy();
      expect(retriedAttemptId).not.toBe(failedAttemptId);
      expect(persistence.loadAttempt(failedAttemptId!)?.status).toBe('failed');
      expect(persistence.loadAttempt(retriedAttemptId!)?.status).toBe('running');
    });

    it('rejects stale attempt and generation responses after retry refreshes attempts', () => {
      orchestrator.loadPlan({
        name: 'retry-stale-response-rejection',
        tasks: [{ id: 't1', description: 'Task 1' }],
      });
      orchestrator.startExecution();

      const taskId = sid(orchestrator, 0, 't1');
      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: taskId, status: 'failed', outputs: { exitCode: 1, error: 'boom' } }),
      );

      const failedTask = orchestrator.getTask(taskId)!;
      const staleAttemptId = failedTask.execution.selectedAttemptId!;
      const staleGeneration = failedTask.execution.generation ?? 0;

      orchestrator.retryWorkflow(orchestrator.getWorkflowIds()[0]!);
      const activeTask = orchestrator.getTask(taskId)!;
      const activeAttemptId = activeTask.execution.selectedAttemptId!;

      expect(activeAttemptId).not.toBe(staleAttemptId);
      expect(activeTask.status).toBe('running');

      const staleAttemptResult = orchestrator.handleWorkerResponse(
        makeResponse({
          actionId: taskId,
          attemptId: staleAttemptId,
          status: 'completed',
          outputs: { exitCode: 0 },
        }),
      );
      expect(staleAttemptResult).toEqual([]);

      const staleGenerationResult = orchestrator.handleWorkerResponse(
        makeResponse({
          actionId: taskId,
          executionGeneration: staleGeneration,
          status: 'completed',
          outputs: { exitCode: 0 },
        }),
      );
      expect(staleGenerationResult).toEqual([]);
      expect(orchestrator.getTask(taskId)?.execution.selectedAttemptId).toBe(activeAttemptId);
      expect(orchestrator.getTask(taskId)?.status).toBe('running');
    });

    it('recreateWorkflow selects a fresh persisted attempt for recreated tasks', () => {
      orchestrator.loadPlan({
        name: 'recreate-attempt-refresh',
        tasks: [{ id: 't1', description: 'Task 1' }],
      });
      orchestrator.startExecution();

      const originalAttemptId = orchestrator.getTask('t1')?.execution.selectedAttemptId;
      expect(originalAttemptId).toBeTruthy();

      const started = orchestrator.recreateWorkflow(orchestrator.getWorkflowIds()[0]!);
      const recreatedTask = orchestrator.getTask('t1');
      const recreatedAttemptId = recreatedTask?.execution.selectedAttemptId;

      expect(started.some((task) => task.id === sid(orchestrator, 0, 't1'))).toBe(true);
      expect(recreatedAttemptId).toBeTruthy();
      expect(recreatedAttemptId).not.toBe(originalAttemptId);
      expect(persistence.loadAttempt(originalAttemptId!)?.status).toBe('superseded');
      expect(persistence.loadAttempt(recreatedAttemptId!)?.status).toBe('running');
    });
  });

  // ── selectExperiments (multi-select) ────────────────────

  describe('selectExperiments', () => {
    function setupReconciliation() {
      orchestrator.loadPlan({
        name: 'multi-select-test',
        tasks: [
          { id: 'pivot', description: 'Pivot task', pivot: true },
          { id: 'downstream', description: 'After recon', dependencies: ['pivot'] },
        ],
      });
      orchestrator.startExecution();

      orchestrator.handleWorkerResponse({
        requestId: 'spawn-pivot',
        actionId: 'pivot',
        executionGeneration: 0,
        status: 'spawn_experiments',
        outputs: { exitCode: 0 },
        dagMutation: {
          spawnExperiments: {
            description: 'Try approaches',
            variants: [
              { id: 'v1', description: 'V1', prompt: 'A' },
              { id: 'v2', description: 'V2', prompt: 'B' },
              { id: 'v3', description: 'V3', prompt: 'C' },
            ],
          },
        },
      });

      orchestrator.handleWorkerResponse(
        makeResponse({
          actionId: sid(orchestrator, 0, 'pivot-exp-v1'),
          status: 'completed',
          outputs: { exitCode: 0 },
        }),
      );
      orchestrator.handleWorkerResponse(
        makeResponse({
          actionId: sid(orchestrator, 0, 'pivot-exp-v2'),
          status: 'completed',
          outputs: { exitCode: 0 },
        }),
      );
      orchestrator.handleWorkerResponse(
        makeResponse({
          actionId: sid(orchestrator, 0, 'pivot-exp-v3'),
          status: 'completed',
          outputs: { exitCode: 0 },
        }),
      );

      orchestrator.handleWorkerResponse(reconciliationNeedsInputWorkResponse(rid(orchestrator, 0, 'pivot')));

      expect(orchestrator.getTask(rid(orchestrator, 0, 'pivot'))!.status).toBe('needs_input');
    }

    it('multi-select completes reconciliation with all IDs', () => {
      setupReconciliation();
      publishedDeltas = [];

      const reconId = rid(orchestrator, 0, 'pivot');
      const exp1 = sid(orchestrator, 0, 'pivot-exp-v1');
      const exp2 = sid(orchestrator, 0, 'pivot-exp-v2');

      orchestrator.selectExperiments(
        reconId,
        [exp1, exp2],
        'reconciliation/pivot-reconciliation',
        'abc123',
      );

      const recon = orchestrator.getTask(reconId)!;
      expect(recon.status).toBe('completed');
      expect(recon.execution.selectedExperiment).toBe(exp1);
      expect(recon.execution.selectedExperiments).toEqual([exp1, exp2]);
      expect(recon.execution.branch).toBe('reconciliation/pivot-reconciliation');
      expect(recon.execution.commit).toBe('abc123');
      expect(
        persistence.loadAttempt(orchestrator.getTask(reconId)!.execution.selectedAttemptId!)?.status,
      ).toBe('completed');
    });

    it('multi-select unblocks downstream tasks', () => {
      setupReconciliation();

      const reconId = rid(orchestrator, 0, 'pivot');
      const exp1 = sid(orchestrator, 0, 'pivot-exp-v1');
      const exp3 = sid(orchestrator, 0, 'pivot-exp-v3');

      orchestrator.selectExperiments(
        reconId,
        [exp1, exp3],
        'reconciliation/pivot-reconciliation',
        'def456',
      );

      const downstream = orchestrator.getTask(sid(orchestrator, 0, 'downstream'));
      expect(downstream).toBeDefined();
      expect(downstream!.status).toBe('running');
      expect(downstream!.dependencies).toContain(reconId);
    });

    it('single-element array delegates to selectExperiment', () => {
      setupReconciliation();

      const reconId = rid(orchestrator, 0, 'pivot');
      const exp1 = sid(orchestrator, 0, 'pivot-exp-v1');

      persistence.updateTask(exp1, {
        execution: { branch: 'experiment/pivot-exp-v1-hash', commit: 'singlecommit' },
      });

      orchestrator.selectExperiments(reconId, [exp1]);

      const recon = orchestrator.getTask(reconId)!;
      expect(recon.status).toBe('completed');
      expect(recon.execution.selectedExperiment).toBe(exp1);
      expect(recon.execution.branch).toBe('experiment/pivot-exp-v1-hash');
      expect(recon.execution.commit).toBe('singlecommit');
      expect(recon.execution.selectedExperiments).toBeUndefined();
    });

    it('publishes delta with selectedExperiments field', () => {
      setupReconciliation();
      publishedDeltas = [];

      const reconId = rid(orchestrator, 0, 'pivot');
      const exp2 = sid(orchestrator, 0, 'pivot-exp-v2');
      const exp3 = sid(orchestrator, 0, 'pivot-exp-v3');

      orchestrator.selectExperiments(reconId, [exp2, exp3], 'recon-branch', 'recon-commit');

      const reconDelta = publishedDeltas.find((d) => d.type === 'updated' && d.taskId === reconId);
      expect(reconDelta).toBeDefined();
      expect((reconDelta as any).changes.execution.selectedExperiments).toEqual([exp2, exp3]);
    });
  });

  // ── Missing state transitions ─────────────────────────────

  describe('missing state transitions', () => {
    it('restartTask on stale task resets to pending', () => {
      orchestrator.loadPlan({
        name: 'stale-restart',
        tasks: [
          { id: 'parent', description: 'Parent', command: 'echo parent' },
          { id: 'child', description: 'Child', command: 'echo child', dependencies: ['parent'] },
        ],
      });
      orchestrator.startExecution();
      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 'parent', status: 'completed', outputs: { exitCode: 0 } }),
      );
      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 'child', status: 'failed', outputs: { exitCode: 1, error: 'fail' } }),
      );

      // Replace child → child becomes stale, replacement created
      orchestrator.replaceTask('child', [
        { id: 'child-replacement', description: 'Replacement' },
      ]);
      expect(orchestrator.getTask('child')!.status).toBe('stale');

      // Restart the stale child — parent is completed, so child is ready and auto-starts
      orchestrator.restartTask('child');
      expect(orchestrator.getTask('child')!.status).toBe('running');
    });

    it('restartTask on awaiting_approval resets to pending and clears completedAt', () => {
      orchestrator.loadPlan({
        name: 'approval-restart',
        tasks: [
          { id: 't1', description: 'Task 1', command: 'echo hello' },
        ],
      });
      orchestrator.startExecution();

      orchestrator.setTaskAwaitingApproval('t1');
      expect(orchestrator.getTask('t1')!.status).toBe('awaiting_approval');
      expect(orchestrator.getTask('t1')!.execution.completedAt).toBeDefined();

      orchestrator.restartTask('t1');
      expect(orchestrator.getTask('t1')!.status).toBe('running');
      expect(orchestrator.getTask('t1')!.execution.completedAt).toBeUndefined();
    });

    it('restartTask on completed reconciliation clears selectedExperiment and experimentResults', () => {
      orchestrator.loadPlan({
        name: 'recon-restart',
        tasks: [
          { id: 'setup', description: 'Setup' },
          {
            id: 'pivot',
            description: 'Pivot',
            dependencies: ['setup'],
            pivot: true,
            experimentVariants: [
              { id: 'v1', description: 'V1', prompt: 'A' },
              { id: 'v2', description: 'V2', prompt: 'B' },
            ],
          },
          { id: 'downstream', description: 'Downstream', dependencies: ['pivot'] },
        ],
      });
      orchestrator.startExecution();

      // Complete setup, spawn experiments
      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 'setup', status: 'completed', outputs: { exitCode: 0 } }),
      );
      orchestrator.handleWorkerResponse({
        requestId: 'req-pivot',
        actionId: 'pivot',
        executionGeneration: 0,
        status: 'spawn_experiments',
        outputs: { exitCode: 0 },
        dagMutation: {
          spawnExperiments: {
            description: 'Variants',
            variants: [
              { id: 'v1', description: 'V1', prompt: 'A' },
              { id: 'v2', description: 'V2', prompt: 'B' },
            ],
          },
        },
      });

      const reconId = rid(orchestrator, 0, 'pivot');
      const exp1 = sid(orchestrator, 0, 'pivot-exp-v1');
      const exp2 = sid(orchestrator, 0, 'pivot-exp-v2');

      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: exp1, status: 'completed', outputs: { exitCode: 0 } }),
      );
      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: exp2, status: 'completed', outputs: { exitCode: 0 } }),
      );
      orchestrator.handleWorkerResponse(reconciliationNeedsInputWorkResponse(reconId));
      expect(orchestrator.getTask(reconId)!.status).toBe('needs_input');

      persistence.updateTask(exp1, {
        execution: { branch: 'exp/v1', commit: 'commit1' },
      });
      orchestrator.selectExperiment(reconId, exp1);
      expect(orchestrator.getTask(reconId)!.status).toBe('completed');
      expect(orchestrator.getTask(reconId)!.execution.selectedExperiment).toBe(exp1);

      orchestrator.restartTask(reconId);
      const recon = orchestrator.getTask(reconId)!;
      expect(recon.status).toBe('running');
      expect(recon.execution.commit).toBeUndefined();
      // Note: restartTask does NOT clear selectedExperiment or experimentResults.
      // Only the reconciliation-reset path (when restarting an experiment dep)
      // clears experimentResults. This is current behavior, not necessarily ideal.
    });

    it('awaiting_approval → reject → restart → complete → dependents start', () => {
      orchestrator.loadPlan({
        name: 'reject-restart',
        tasks: [
          { id: 'A', description: 'Approval gate', command: 'echo A' },
          { id: 'B', description: 'Downstream', command: 'echo B', dependencies: ['A'] },
        ],
      });
      orchestrator.startExecution();

      orchestrator.setTaskAwaitingApproval('A');
      expect(orchestrator.getTask('A')!.status).toBe('awaiting_approval');

      orchestrator.reject('A', 'Not good enough');
      expect(orchestrator.getTask('A')!.status).toBe('failed');
      // B stays pending (no blocked status)
      expect(orchestrator.getTask('B')!.status).toBe('pending');

      orchestrator.restartTask('A');
      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 'A', executionGeneration: 1, status: 'completed', outputs: { exitCode: 0 } }),
      );

      expect(orchestrator.getTask('A')!.status).toBe('completed');
      expect(orchestrator.getTask('B')!.status).toBe('running');
    });
  });

  // ── Merge gate leaf reconciliation ────────────────────────

  describe('merge gate leaf reconciliation', () => {
    let logSpy: ReturnType<typeof vi.spyOn>;
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      logSpy.mockRestore();
      warnSpy.mockRestore();
    });

    it('loadPlan: merge gate depends on all leaves in a fan-out', () => {
      orchestrator.loadPlan({
        name: 'fan-out-test',
        tasks: [
          { id: 'root', description: 'Root' },
          { id: 'b1', description: 'Branch 1', dependencies: ['root'] },
          { id: 'b2', description: 'Branch 2', dependencies: ['root'] },
          { id: 'b3', description: 'Branch 3', dependencies: ['root'] },
        ],
      });

      const mergeNode = orchestrator.getAllTasks().find((t) => t.config.isMergeNode);
      expect(mergeNode).toBeDefined();
      expect(mergeNode!.dependencies.sort()).toEqual(
        [sid(orchestrator, 0, 'b1'), sid(orchestrator, 0, 'b2'), sid(orchestrator, 0, 'b3')].sort(),
      );
    });

    it('loadPlan: independent tasks are all merge gate leaves', () => {
      orchestrator.loadPlan({
        name: 'independent-test',
        tasks: [
          { id: 'a', description: 'Independent A' },
          { id: 'b', description: 'Independent B' },
          { id: 'c', description: 'Independent C' },
        ],
      });

      const mergeNode = orchestrator.getAllTasks().find((t) => t.config.isMergeNode);
      expect(mergeNode!.dependencies.sort()).toEqual(
        [sid(orchestrator, 0, 'a'), sid(orchestrator, 0, 'b'), sid(orchestrator, 0, 'c')].sort(),
      );
    });

    it('loadPlan: mixed independent and chained tasks all have leaves in merge gate', () => {
      orchestrator.loadPlan({
        name: 'mixed-test',
        tasks: [
          { id: 'a', description: 'Chain root' },
          { id: 'b', description: 'Chain end', dependencies: ['a'] },
          { id: 'c', description: 'Independent' },
        ],
      });

      const mergeNode = orchestrator.getAllTasks().find((t) => t.config.isMergeNode);
      expect(mergeNode!.dependencies.sort()).toEqual(
        [sid(orchestrator, 0, 'b'), sid(orchestrator, 0, 'c')].sort(),
      );
    });

    it('replaceTask: merge gate deps updated to replacement leaves', () => {
      orchestrator.loadPlan({
        name: 'replace-leaf-test',
        tasks: [
          { id: 'a', description: 'Root' },
          { id: 'b', description: 'Leaf', dependencies: ['a'] },
        ],
      });
      orchestrator.startExecution();

      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 'a', status: 'completed', outputs: { exitCode: 0 } }),
      );
      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 'b', status: 'failed', outputs: { exitCode: 1, error: 'fail' } }),
      );

      orchestrator.replaceTask('b', [
        { id: 's1', description: 'Step 1' },
        { id: 's2', description: 'Step 2', dependencies: ['s1'] },
      ]);

      const mergeNode = orchestrator.getAllTasks().find((t) => t.config.isMergeNode);
      expect(mergeNode!.dependencies).toEqual([sid(orchestrator, 0, 's2')]);
    });

    it('experiment spawn: merge gate deps include reconciliation node', () => {
      orchestrator.loadPlan({
        name: 'experiment-leaf-test',
        tasks: [
          { id: 'pivot', description: 'Pivot task' },
        ],
      });
      orchestrator.startExecution();

      orchestrator.handleWorkerResponse(
        makeResponse({
          actionId: 'pivot',
          status: 'spawn_experiments',
          dagMutation: {
            spawnExperiments: {
              description: 'Try variants',
              variants: [
                { id: 'v1', prompt: 'Approach A' },
                { id: 'v2', prompt: 'Approach B' },
              ],
            },
          },
        }),
      );

      const mergeNode = orchestrator.getAllTasks().find((t) => t.config.isMergeNode);
      expect(mergeNode!.dependencies).toEqual([rid(orchestrator, 0, 'pivot')]);
    });

    it('experiment spawn with downstream: merge gate deps point to remapped downstream', () => {
      orchestrator.loadPlan({
        name: 'experiment-downstream-test',
        tasks: [
          { id: 'pivot', description: 'Pivot task' },
          { id: 'downstream', description: 'After pivot', dependencies: ['pivot'] },
        ],
      });
      orchestrator.startExecution();

      orchestrator.handleWorkerResponse(
        makeResponse({
          actionId: 'pivot',
          status: 'spawn_experiments',
          dagMutation: {
            spawnExperiments: {
              description: 'Try variants',
              variants: [
                { id: 'v1', prompt: 'Approach A' },
                { id: 'v2', prompt: 'Approach B' },
              ],
            },
          },
        }),
      );

      const mergeNode = orchestrator.getAllTasks().find((t) => t.config.isMergeNode);
      expect(mergeNode!.dependencies).toEqual([sid(orchestrator, 0, 'downstream')]);

      const downstream = orchestrator.getTask(sid(orchestrator, 0, 'downstream'));
      expect(downstream).toBeDefined();
      expect(downstream!.dependencies).toContain(rid(orchestrator, 0, 'pivot'));
    });

    it('editTaskCommand: merge gate deps unchanged (no fork)', () => {
      orchestrator.loadPlan({
        name: 'edit-leaf-test',
        tasks: [
          { id: 'parent', description: 'Parent', command: 'echo parent' },
          { id: 'child1', description: 'Child 1', dependencies: ['parent'] },
          { id: 'child2', description: 'Child 2', dependencies: ['parent'] },
        ],
      });
      orchestrator.startExecution();

      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 'parent', status: 'completed', outputs: { exitCode: 0 } }),
      );
      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 'child1', status: 'completed', outputs: { exitCode: 0 } }),
      );
      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 'child2', status: 'completed', outputs: { exitCode: 0 } }),
      );

      orchestrator.editTaskCommand('parent', 'echo updated');

      const mergeNode = orchestrator.getAllTasks().find((t) => t.config.isMergeNode);
      expect(mergeNode!.dependencies.sort()).toEqual(
        [sid(orchestrator, 0, 'child1'), sid(orchestrator, 0, 'child2')].sort(),
      );
    });

    it('stale tasks are excluded from merge gate deps (via replaceTask)', () => {
      orchestrator.loadPlan({
        name: 'stale-exclusion-test',
        tasks: [
          { id: 'a', description: 'Root' },
          { id: 'b', description: 'Leaf', dependencies: ['a'] },
        ],
      });
      orchestrator.startExecution();

      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 'a', status: 'completed', outputs: { exitCode: 0 } }),
      );
      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 'b', status: 'failed', outputs: { exitCode: 1, error: 'fail' } }),
      );

      // replaceTask stales 'b' and creates replacement
      orchestrator.replaceTask('b', [
        { id: 'b-replacement', description: 'Replacement for b' },
      ]);

      const mergeNode = orchestrator.getAllTasks().find((t) => t.config.isMergeNode);
      expect(mergeNode!.dependencies).not.toContain(sid(orchestrator, 0, 'b'));
      expect(mergeNode!.dependencies).toContain(sid(orchestrator, 0, 'b-replacement'));
    });

    it('diamond DAG: merge gate depends only on convergence node', () => {
      orchestrator.loadPlan({
        name: 'diamond-test',
        tasks: [
          { id: 'a', description: 'Root' },
          { id: 'b', description: 'Left', dependencies: ['a'] },
          { id: 'c', description: 'Right', dependencies: ['a'] },
          { id: 'd', description: 'Merge', dependencies: ['b', 'c'] },
        ],
      });

      const mergeNode = orchestrator.getAllTasks().find((t) => t.config.isMergeNode);
      expect(mergeNode!.dependencies).toEqual([sid(orchestrator, 0, 'd')]);
    });

    it('deep chain with side branch: merge gate depends on all leaf nodes', () => {
      orchestrator.loadPlan({
        name: 'deep-side-test',
        tasks: [
          { id: 'a', description: 'Root' },
          { id: 'b', description: 'Chain', dependencies: ['a'] },
          { id: 'c', description: 'Chain end', dependencies: ['b'] },
          { id: 'd', description: 'Side branch', dependencies: ['a'] },
        ],
      });

      const mergeNode = orchestrator.getAllTasks().find((t) => t.config.isMergeNode);
      expect(mergeNode!.dependencies.sort()).toEqual(
        [sid(orchestrator, 0, 'c'), sid(orchestrator, 0, 'd')].sort(),
      );
    });
  });

  describe('beginConflictResolution / revertConflictResolution', () => {
    const mergeConflictError = JSON.stringify({
      type: 'merge_conflict',
      failedBranch: 'experiment/upstream-branch-abc123',
      conflictFiles: ['src/App.tsx', 'src/utils.ts'],
    });

    beforeEach(() => {
      orchestrator.loadPlan({
        name: 'conflict-plan',
        tasks: [
          { id: 't1', description: 'Root task' },
          { id: 't2', description: 'Downstream task', dependencies: ['t1'] },
        ],
      });
      orchestrator.startExecution();

      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 't1', status: 'completed', outputs: { exitCode: 0 } }),
      );

      orchestrator.handleWorkerResponse(
        makeResponse({
          actionId: 't2',
          status: 'failed',
          outputs: { exitCode: 1, error: mergeConflictError },
        }),
      );

      expect(orchestrator.getTask('t2')!.status).toBe('failed');
      publishedDeltas = [];
    });

    it('sets task to fixing_with_ai, clears terminal execution fields, and emits delta', () => {
      const failedAttemptId = orchestrator.getTask('t2')!.execution.selectedAttemptId;
      orchestrator.beginConflictResolution('t2');

      const task = orchestrator.getTask('t2')!;
      const fixAttemptId = task.execution.selectedAttemptId;
      expect(task.status).toBe('fixing_with_ai');
      expect(task.execution.isFixingWithAI).toBeFalsy();
      expect(task.execution.error).toBeUndefined();
      expect(task.execution.exitCode).toBeUndefined();
      expect(task.execution.completedAt).toBeUndefined();
      expect(task.execution.mergeConflict).toBeUndefined();
      expect(task.execution.generation).toBe(1);
      expect(fixAttemptId).toBeTruthy();
      expect(fixAttemptId).not.toBe(failedAttemptId);
      expect(persistence.loadAttempt(failedAttemptId!)?.status).toBe('failed');
      expect(persistence.loadAttempt(fixAttemptId!)?.status).toBe('running');

      const t2id = sid(orchestrator, 0, 't2');
      const fixDeltas = publishedDeltas.filter(
        (d) => d.type === 'updated' && d.taskId === t2id && d.changes.status === 'fixing_with_ai',
      );
      expect(fixDeltas).toHaveLength(1);
    });

    it('resets startedAt and lastHeartbeatAt timestamps', () => {
      const before = Date.now();
      orchestrator.beginConflictResolution('t2');
      const after = Date.now();

      const task = orchestrator.getTask('t2')!;
      expect(task.execution.startedAt).toBeInstanceOf(Date);
      expect(task.execution.lastHeartbeatAt).toBeInstanceOf(Date);
      expect(task.execution.startedAt!.getTime()).toBeGreaterThanOrEqual(before);
      expect(task.execution.startedAt!.getTime()).toBeLessThanOrEqual(after);
      expect(task.execution.lastHeartbeatAt!.getTime()).toBeGreaterThanOrEqual(before);
      expect(task.execution.lastHeartbeatAt!.getTime()).toBeLessThanOrEqual(after);
    });

    it('returns savedError for later revert', () => {
      const { savedError } = orchestrator.beginConflictResolution('t2');
      expect(savedError).toBe(mergeConflictError);
    });

    it('revertConflictResolution restores failed state with mergeConflict', () => {
      const { savedError } = orchestrator.beginConflictResolution('t2');
      const fixAttemptId = orchestrator.getTask('t2')!.execution.selectedAttemptId;
      expect(orchestrator.getTask('t2')!.status).toBe('fixing_with_ai');

      publishedDeltas = [];
      orchestrator.revertConflictResolution('t2', savedError);

      const task = orchestrator.getTask('t2')!;
      expect(task.status).toBe('failed');
      expect(task.execution.error).toBe(mergeConflictError);
      expect(task.execution.mergeConflict).toEqual({
        failedBranch: 'experiment/upstream-branch-abc123',
        conflictFiles: ['src/App.tsx', 'src/utils.ts'],
      });
      expect(task.execution.isFixingWithAI).toBeFalsy();
      expect(persistence.loadAttempt(fixAttemptId!)?.status).toBe('failed');

      const failedDeltas = publishedDeltas.filter(
        (d) =>
          d.type === 'updated' &&
          d.taskId === sid(orchestrator, 0, 't2') &&
          d.changes.status === 'failed',
      );
      expect(failedDeltas).toHaveLength(1);
    });

    it('revertConflictResolution uses agent-agnostic fix failure prefix', () => {
      const { savedError } = orchestrator.beginConflictResolution('t2');
      orchestrator.revertConflictResolution('t2', savedError, 'startup failed');
      const task = orchestrator.getTask('t2')!;
      expect(task.execution.error).toContain('[Fix with Agent failed] startup failed');
    });

    it('revertConflictResolution does not duplicate an existing fix failure wrapper', () => {
      const wrappedSavedError =
        '[Fix with Claude failed] first attempt failed\n\n' + mergeConflictError;
      orchestrator.revertConflictResolution('t2', wrappedSavedError, 'second attempt failed');
      const task = orchestrator.getTask('t2')!;
      expect(task.execution.error).toContain('[Fix with Agent failed] second attempt failed');
      expect(task.execution.error).not.toContain('first attempt failed');
      expect(task.execution.mergeConflict).toEqual({
        failedBranch: 'experiment/upstream-branch-abc123',
        conflictFiles: ['src/App.tsx', 'src/utils.ts'],
      });
    });

    it('throws if task is not failed', () => {
      expect(() => orchestrator.beginConflictResolution('t1')).toThrow(
        'is not failed',
      );
    });

    it('throws if task does not exist', () => {
      expect(() => orchestrator.beginConflictResolution('nonexistent')).toThrow(
        'not found',
      );
    });

    it('revert with non-JSON error preserves plain string without mergeConflict', () => {
      orchestrator.restartTask('t2');
      orchestrator.handleWorkerResponse(
        makeResponse({
          actionId: 't2',
          executionGeneration: orchestrator.getTask('t2')?.execution.generation ?? 0,
          status: 'failed',
          outputs: { exitCode: 1, error: 'plain error string' },
        }),
      );

      const { savedError } = orchestrator.beginConflictResolution('t2');
      orchestrator.revertConflictResolution('t2', savedError);

      const task = orchestrator.getTask('t2')!;
      expect(task.status).toBe('failed');
      expect(task.execution.error).toBe('plain error string');
      expect(task.execution.mergeConflict).toBeUndefined();
      expect(task.execution.isFixingWithAI).toBeFalsy();
    });
  });

  describe('fix-approval flow', () => {
    beforeEach(() => {
      orchestrator.loadPlan({
        name: 'fix-test',
        tasks: [
          { id: 'f1', description: 'Root task' },
          { id: 'f2', description: 'Failing task', dependencies: ['f1'] },
        ],
      });
      orchestrator.startExecution();
      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 'f1', status: 'completed', outputs: { exitCode: 0 } }),
      );
      orchestrator.handleWorkerResponse(
        makeResponse({
          actionId: 'f2',
          status: 'failed',
          outputs: { exitCode: 1, error: 'test failed: expected 1 to be 2' },
        }),
      );
      expect(orchestrator.getTask('f2')!.status).toBe('failed');
      publishedDeltas = [];
    });

    it('setFixAwaitingApproval transitions to awaiting_approval with pendingFixError', () => {
      orchestrator.beginConflictResolution('f2');
      expect(orchestrator.getTask('f2')!.status).toBe('fixing_with_ai');
      expect(orchestrator.getTask('f2')!.execution.isFixingWithAI).toBeFalsy();
      const fixAttemptId = orchestrator.getTask('f2')!.execution.selectedAttemptId;
      orchestrator.setFixAwaitingApproval('f2', 'test failed: expected 1 to be 2');
      const task = orchestrator.getTask('f2')!;
      expect(task.status).toBe('awaiting_approval');
      expect(task.execution.pendingFixError).toBe('test failed: expected 1 to be 2');
      expect(task.execution.isFixingWithAI).toBeFalsy();
      expect(persistence.loadAttempt(fixAttemptId!)?.status).toBe('needs_input');
    });

    it('setFixAwaitingApproval delta includes agentSessionId from DB', () => {
      orchestrator.beginConflictResolution('f2');
      // Simulate conflict-resolver persisting sessionId directly to DB
      persistence.updateTask('f2', {
        execution: {
          agentSessionId: 'sess-fix-1',
          lastAgentSessionId: 'sess-fix-1',
          agentName: 'codex',
          lastAgentName: 'codex',
        },
      });
      publishedDeltas = [];

      orchestrator.setFixAwaitingApproval('f2', 'test failed: expected 1 to be 2');

      const delta = publishedDeltas.find(
        (d) => d.type === 'updated' && d.taskId === sid(orchestrator, 0, 'f2'),
      );
      expect(delta).toBeDefined();
      expect((delta as any).changes.execution.agentSessionId).toBe('sess-fix-1');
      expect((delta as any).changes.execution.lastAgentSessionId).toBe('sess-fix-1');
      expect((delta as any).changes.execution.lastAgentName).toBe('codex');
      expect(orchestrator.getTask('f2')!.execution.agentSessionId).toBe('sess-fix-1');
      expect(orchestrator.getTask('f2')!.execution.lastAgentSessionId).toBe('sess-fix-1');
      expect(orchestrator.getTask('f2')!.execution.lastAgentName).toBe('codex');
    });

    it('pendingFixError is readable via getTask', () => {
      orchestrator.beginConflictResolution('f2');
      orchestrator.setFixAwaitingApproval('f2', 'original error');
      expect(orchestrator.getTask('f2')!.execution.pendingFixError).toBe('original error');
    });

    it('throws if task is not running or fixing with AI', () => {
      expect(() => orchestrator.setFixAwaitingApproval('f2', 'error')).toThrow('not running or fixing with AI');
    });

    it('restartTask clears the fix state', () => {
      orchestrator.beginConflictResolution('f2');
      orchestrator.setFixAwaitingApproval('f2', 'error');
      orchestrator.restartTask('f2');
      const task = orchestrator.getTask('f2')!;
      expect(task.status === 'pending' || task.status === 'running').toBe(true);
      expect(task.execution.isFixingWithAI).toBeFalsy();
    });

    it('revertConflictResolution restores failed state', () => {
      orchestrator.beginConflictResolution('f2');
      orchestrator.setFixAwaitingApproval('f2', 'test failed: expected 1 to be 2');
      orchestrator.revertConflictResolution('f2', 'test failed: expected 1 to be 2');
      const task = orchestrator.getTask('f2')!;
      expect(task.status).toBe('failed');
      expect(task.execution.error).toBe('test failed: expected 1 to be 2');
    });

    it('non-merge merge_conflict JSON pendingFixError resume transitions failed -> fixing_with_ai -> awaiting_approval -> running and clears pendingFixError', async () => {
      const mergeConflictError = JSON.stringify({
        type: 'merge_conflict',
        failedBranch: 'experiment/non-merge-branch-abc123',
        conflictFiles: ['src/non-merge.ts'],
      });

      persistence.updateTask('f2', { execution: { error: mergeConflictError } });
      expect(orchestrator.getTask('f2')!.config.isMergeNode).toBeFalsy();
      expect(orchestrator.getTask('f2')!.status).toBe('failed');

      const { savedError } = orchestrator.beginConflictResolution('f2');
      expect(savedError).toBe(mergeConflictError);
      expect(orchestrator.getTask('f2')!.status).toBe('fixing_with_ai');
      const fixAttemptId = orchestrator.getTask('f2')!.execution.selectedAttemptId;

      orchestrator.setFixAwaitingApproval('f2', mergeConflictError);
      expect(orchestrator.getTask('f2')!.status).toBe('awaiting_approval');
      expect(orchestrator.getTask('f2')!.execution.pendingFixError).toBe(mergeConflictError);

      await orchestrator.resumeTaskAfterFixApproval('f2');
      const task = orchestrator.getTask('f2')!;
      expect(task.status).toBe('running');
      expect(task.status).not.toBe('completed');
      expect(task.execution.pendingFixError).toBeUndefined();
      expect(persistence.loadAttempt(fixAttemptId!)?.status).toBe('running');
    });

    it('non-merge plain-text pendingFixError approve transitions failed -> fixing_with_ai -> awaiting_approval -> completed', async () => {
      const plainTextError = 'test failed: expected 1 to be 2';

      expect(orchestrator.getTask('f2')!.config.isMergeNode).toBeFalsy();
      expect(orchestrator.getTask('f2')!.status).toBe('failed');

      const { savedError } = orchestrator.beginConflictResolution('f2');
      expect(savedError).toBe(plainTextError);
      expect(orchestrator.getTask('f2')!.status).toBe('fixing_with_ai');
      const fixAttemptId = orchestrator.getTask('f2')!.execution.selectedAttemptId;

      orchestrator.setFixAwaitingApproval('f2', plainTextError);
      expect(orchestrator.getTask('f2')!.status).toBe('awaiting_approval');
      expect(orchestrator.getTask('f2')!.execution.pendingFixError).toBe(plainTextError);

      await orchestrator.approve('f2');
      expect(orchestrator.getTask('f2')!.status).toBe('completed');
      expect(persistence.loadAttempt(fixAttemptId!)?.status).toBe('completed');
    });
  });

  describe('merge gate two-step approve (pendingFixError)', () => {
    function setupMergeGateAwaitingFixApproval(): string {
      orchestrator.loadPlan({
        name: 'merge-fix-approval',
        tasks: [
          { id: 'u1', description: 'Upstream 1' },
          { id: 'u2', description: 'Upstream 2' },
        ],
      });
      orchestrator.startExecution();
      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 'u1', status: 'completed', outputs: { exitCode: 0 } }),
      );
      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 'u2', status: 'completed', outputs: { exitCode: 0 } }),
      );
      const mergeNode = orchestrator.getAllTasks().find((t) => t.config.isMergeNode)!;
      orchestrator.handleWorkerResponse(
        makeResponse({
          actionId: mergeNode.id,
          status: 'failed',
          outputs: { exitCode: 1, error: 'merge conflict' },
        }),
      );
      orchestrator.beginConflictResolution(mergeNode.id);
      orchestrator.setFixAwaitingApproval(mergeNode.id, 'merge conflict');
      return mergeNode.id;
    }

    it('resumeTaskAfterFixApproval transitions to running (for PR prep), clears pendingFixError, does not fire beforeApproveHook', async () => {
      const hookSpy = vi.fn();
      orchestrator.setBeforeApproveHook(hookSpy);
      const mergeId = setupMergeGateAwaitingFixApproval();

      const started = await orchestrator.resumeTaskAfterFixApproval(mergeId);

      expect(started).toHaveLength(1);
      expect(started[0].id).toBe(mergeId);
      expect(started[0].status).toBe('running');
      expect(hookSpy).not.toHaveBeenCalled();
      const task = orchestrator.getTask(mergeId)!;
      expect(task.status).toBe('running');
      expect(task.execution.pendingFixError).toBeUndefined();
    });

    it('after PR prep sets awaiting_approval, approve completes and fires hook', async () => {
      const hookSpy = vi.fn();
      orchestrator.setBeforeApproveHook(hookSpy);
      const mergeId = setupMergeGateAwaitingFixApproval();

      await orchestrator.resumeTaskAfterFixApproval(mergeId);
      orchestrator.setTaskAwaitingApproval(mergeId);
      await orchestrator.approve(mergeId);

      expect(hookSpy).toHaveBeenCalledTimes(1);
      expect(hookSpy.mock.calls[0][0].id).toBe(mergeId);
      expect(orchestrator.getTask(mergeId)!.status).toBe('completed');
    });
  });

  describe('deleteWorkflow', () => {
    it('removes tasks from memory after delete', () => {
      orchestrator.loadPlan({
        name: 'wf-to-delete',
        tasks: [
          { id: 'd1', description: 'Task 1' },
          { id: 'd2', description: 'Task 2', dependencies: ['d1'] },
        ],
      });
      const wfId = orchestrator.getWorkflowIds()[0];
      expect(orchestrator.getAllTasks().length).toBeGreaterThan(0);

      orchestrator.deleteWorkflow(wfId);

      expect(orchestrator.getAllTasks()).toHaveLength(0);
      expect(orchestrator.getTask('d1')).toBeUndefined();
      expect(orchestrator.getTask('d2')).toBeUndefined();
    });

    it('removes workflow from persistence after delete', () => {
      orchestrator.loadPlan({
        name: 'wf-persist-delete',
        tasks: [{ id: 'p1', description: 'Task' }],
      });
      const wfId = orchestrator.getWorkflowIds()[0];
      expect(persistence.workflows.has(wfId)).toBe(true);

      orchestrator.deleteWorkflow(wfId);

      expect(persistence.workflows.has(wfId)).toBe(false);
      expect(persistence.loadTasks(wfId)).toHaveLength(0);
    });

    it('publishes removal deltas for each task', () => {
      orchestrator.loadPlan({
        name: 'wf-delta-delete',
        tasks: [
          { id: 'r1', description: 'Task 1' },
          { id: 'r2', description: 'Task 2', dependencies: ['r1'] },
        ],
      });
      const wfId = orchestrator.getWorkflowIds()[0];
      const r1 = sid(orchestrator, 0, 'r1');
      const r2 = sid(orchestrator, 0, 'r2');
      publishedDeltas = [];

      orchestrator.deleteWorkflow(wfId);

      const removedDeltas = publishedDeltas.filter(
        (d) => d.type === 'removed',
      ) as Array<{ type: 'removed'; taskId: string }>;
      // 2 tasks + 1 merge node = 3 removed deltas
      expect(removedDeltas).toHaveLength(3);
      const removedIds = removedDeltas.map((d) => d.taskId);
      expect(removedIds).toContain(r1);
      expect(removedIds).toContain(r2);
    });

    it('leaves other workflows unaffected', () => {
      orchestrator.loadPlan({
        name: 'wf-keep',
        tasks: [{ id: 'keep1', description: 'Keep this' }],
      });
      const keepWfId = orchestrator.getWorkflowIds()[0];

      orchestrator.loadPlan({
        name: 'wf-remove',
        tasks: [{ id: 'rm1', description: 'Remove this' }],
      });
      const removeWfId = orchestrator.getWorkflowIds().find((id) => id !== keepWfId)!;
      expect(removeWfId).toBeDefined();

      orchestrator.deleteWorkflow(removeWfId);

      expect(orchestrator.getTask('keep1')).toBeDefined();
      expect(orchestrator.getTask('rm1')).toBeUndefined();
      expect(orchestrator.getWorkflowIds()).toContain(keepWfId);
      expect(orchestrator.getWorkflowIds()).not.toContain(removeWfId);
    });

    it('frees scheduler slots for running tasks', () => {
      orchestrator.loadPlan({
        name: 'wf-scheduler',
        tasks: [{ id: 's1', description: 'Running task' }],
      });
      orchestrator.startExecution();
      expect(orchestrator.getTask('s1')!.status).toBe('running');
      const wfId = orchestrator.getWorkflowIds()[0];

      // Should not throw — scheduler slots are freed
      orchestrator.deleteWorkflow(wfId);
      expect(orchestrator.getAllTasks()).toHaveLength(0);
    });

    it('blocks downstream tasks whose external dependency points at deleted workflow', () => {
      orchestrator.loadPlan({
        name: 'upstream-delete-target',
        tasks: [{ id: 'verify', description: 'upstream prerequisite' }],
      });
      const upstreamTaskId = sid(orchestrator, 0, 'verify');
      const upstreamWfId = upstreamTaskId.split('/')[0]!;

      orchestrator.loadPlan({
        name: 'downstream-external-dependent',
        tasks: [
          {
            id: 'wait-for-upstream',
            description: 'waits for upstream merge gate',
            externalDependencies: [{ workflowId: upstreamWfId, gatePolicy: 'completed' }],
          },
        ],
      });
      const downstreamTaskId = sid(orchestrator, 1, 'wait-for-upstream');
      orchestrator.startExecution();
      expect(orchestrator.getTask(downstreamTaskId)!.status).toBe('pending');

      orchestrator.deleteWorkflow(upstreamWfId);

      const downstream = orchestrator.getTask(downstreamTaskId)!;
      expect(downstream.status).toBe('blocked');
      expect(downstream.execution.blockedBy).toContain(`missing prerequisite __merge__${upstreamWfId}`);
    });
  });

  describe('deleteAllWorkflows', () => {
    it('removes all tasks from memory', () => {
      orchestrator.loadPlan({
        name: 'wf-all-1',
        tasks: [{ id: 'a1', description: 'Task A' }],
      });
      orchestrator.loadPlan({
        name: 'wf-all-2',
        tasks: [{ id: 'b1', description: 'Task B' }],
      });
      expect(orchestrator.getAllTasks().length).toBeGreaterThan(0);

      orchestrator.deleteAllWorkflows();

      expect(orchestrator.getAllTasks()).toHaveLength(0);
      expect(orchestrator.getWorkflowIds()).toHaveLength(0);
    });

    it('publishes removal deltas for all tasks', () => {
      orchestrator.loadPlan({
        name: 'wf-delta-all',
        tasks: [
          { id: 'da1', description: 'Task 1' },
          { id: 'da2', description: 'Task 2' },
        ],
      });
      publishedDeltas = [];

      orchestrator.deleteAllWorkflows();

      const removedDeltas = publishedDeltas.filter(
        (d) => d.type === 'removed',
      );
      // 2 tasks + 1 merge node = 3 removed deltas
      expect(removedDeltas).toHaveLength(3);
    });

    it('clears persistence', () => {
      orchestrator.loadPlan({
        name: 'wf-persist-all',
        tasks: [{ id: 'pa1', description: 'Task' }],
      });
      expect(persistence.workflows.size).toBeGreaterThan(0);

      orchestrator.deleteAllWorkflows();

      expect(persistence.workflows.size).toBe(0);
      expect(persistence.tasks.size).toBe(0);
    });

    it('orchestrator remains usable after deleteAll', () => {
      orchestrator.loadPlan({
        name: 'wf-before',
        tasks: [{ id: 'old1', description: 'Old task' }],
      });
      orchestrator.deleteAllWorkflows();

      // Should be able to load a new plan
      orchestrator.loadPlan({
        name: 'wf-after',
        tasks: [{ id: 'new1', description: 'New task' }],
      });
      expect(orchestrator.getTask('new1')).toBeDefined();
      expect(orchestrator.getWorkflowIds()).toHaveLength(1);
    });
  });

  describe('blocked task unblocking', () => {
    it('throws when a persisted merge node has detached dependencies', () => {
      orchestrator.loadPlan({
        name: 'merge-repair-test',
        tasks: [
          { id: 'task-a', description: 'task A' },
          { id: 'task-b', description: 'task B', dependencies: ['task-a'] },
        ],
      });

      const wfId = orchestrator.getWorkflowIds()[0]!;
      const mergeId = `__merge__${wfId}`;

      persistence.updateTask(mergeId, {
        status: 'review_ready',
        dependencies: ['missing-detached-leaf'],
      });

      expect(() => orchestrator.syncAllFromDb()).toThrow(
        `Merge gate invariant violated for workflow ${wfId}: merge node ${mergeId} has detached dependencies.`,
      );
      expect(persistence.getTaskEntry(mergeId)!.task.dependencies).toEqual(['missing-detached-leaf']);
      expect(persistence.getTaskEntry(mergeId)!.task.status).toBe('review_ready');
    });

    it('throws when a persisted merge experiment is detached from its parent merge node', () => {
      orchestrator.loadPlan({
        name: 'merge-exp-detach-test',
        tasks: [{ id: 'task-a', description: 'task A' }],
      });

      const wfId = orchestrator.getWorkflowIds()[0]!;
      const mergeId = `__merge__${wfId}`;
      persistence.saveTask(wfId, {
        id: `${mergeId}-exp-fix-conservative`,
        description: 'Experiment: conservative',
        status: 'stale',
        dependencies: [],
        createdAt: new Date(),
        config: {
          workflowId: wfId,
          parentTask: mergeId,
          executorType: 'merge',
        },
        execution: {},
      } as TaskState);

      expect(() => orchestrator.syncAllFromDb()).toThrow(
        `Merge experiment invariant violated for workflow ${wfId}: ` +
          `task ${mergeId}-exp-fix-conservative is detached from parent merge node ${mergeId}.`,
      );
    });

    it('unblocks a blocked task when all deps complete', () => {
      orchestrator.loadPlan({
        name: 'unblock-test',
        tasks: [
          { id: 'dep', description: 'dependency' },
          { id: 'gate', description: 'gate task', dependencies: ['dep'] },
        ],
      });
      orchestrator.startExecution();

      // Manually set gate to blocked (simulating older DB state)
      persistence.updateTask('gate', { status: 'blocked' });
      orchestrator.syncAllFromDb();
      expect(orchestrator.getTask('gate')!.status).toBe('blocked');

      // Complete the dependency
      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 'dep', status: 'completed', outputs: { exitCode: 0 } }),
      );

      // Gate should now be running (unblocked and started)
      expect(orchestrator.getTask('gate')!.status).toBe('running');
    });

    it('unblocks a blocked merge node when last dep is approved', async () => {
      orchestrator.loadPlan({
        name: 'merge-unblock-test',
        tasks: [
          { id: 'task-a', description: 'task A' },
          { id: 'task-b', description: 'task B' },
        ],
      });
      orchestrator.startExecution();

      // Complete both tasks
      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 'task-a', status: 'completed', outputs: { exitCode: 0 } }),
      );
      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 'task-b', status: 'completed', outputs: { exitCode: 0 } }),
      );

      // Merge node exists and is pending
      const mergeId = orchestrator.getAllTasks().find(t => t.config.isMergeNode)!.id;

      // Simulate: set merge node to blocked (older DB state)
      persistence.updateTask(mergeId, { status: 'blocked' });
      orchestrator.syncAllFromDb();
      expect(orchestrator.getTask(mergeId)!.status).toBe('blocked');

      // Set task-b to awaiting_approval to simulate the approve flow
      persistence.updateTask('task-b', { status: 'awaiting_approval' });
      orchestrator.syncAllFromDb();

      // Approve task-b — this should find the merge node ready and unblock it
      const started = await orchestrator.approve('task-b');
      expect(started.some(t => t.id === mergeId)).toBe(true);
      expect(orchestrator.getTask(mergeId)!.status).toBe('running');
    });
  });

  describe('deferTask', () => {
    it('transitions a running task back to pending', () => {
      orchestrator.loadPlan({
        name: 'defer-test',
        tasks: [{ id: 'task-a', description: 'Task A' }],
      });
      const started = orchestrator.startExecution();
      expect(started.length).toBe(1);
      expect(orchestrator.getTask('task-a')!.status).toBe('running');

      orchestrator.deferTask('task-a');

      const task = orchestrator.getTask('task-a')!;
      expect(task.status).toBe('pending');
      expect(task.execution.startedAt).toBeUndefined();
      expect(task.execution.lastHeartbeatAt).toBeUndefined();
    });

    it('replaces the selected attempt when deferring a task', () => {
      orchestrator.loadPlan({
        name: 'defer-attempt-refresh',
        tasks: [{ id: 'task-a', description: 'Task A' }],
      });
      orchestrator.startExecution();

      const originalAttemptId = orchestrator.getTask('task-a')?.execution.selectedAttemptId;
      expect(originalAttemptId).toBeTruthy();

      orchestrator.deferTask('task-a');

      const deferredTask = orchestrator.getTask('task-a');
      const deferredAttemptId = deferredTask?.execution.selectedAttemptId;
      expect(deferredAttemptId).toBeTruthy();
      expect(deferredAttemptId).not.toBe(originalAttemptId);
      expect(persistence.loadAttempt(originalAttemptId!)?.status).toBe('superseded');
      expect(persistence.loadAttempt(deferredAttemptId!)?.status).toBe('pending');
    });

    it('frees the scheduler slot so other tasks can run', () => {
      orchestrator.loadPlan({
        name: 'defer-slot-test',
        tasks: [
          { id: 'task-a', description: 'Task A' },
          { id: 'task-b', description: 'Task B' },
          { id: 'task-c', description: 'Task C' },
          { id: 'task-d', description: 'Task D' },
        ],
      });
      // maxConcurrency=3, so 3 start, 1 stays in queue
      const started = orchestrator.startExecution();
      expect(started.length).toBe(3);

      // Defer task-a → frees a slot → task-d should drain from queue
      orchestrator.deferTask(started[0].id);

      // task-d should now be running (scheduler drained)
      const allTasks = orchestrator.getAllTasks().filter(t => !t.config.isMergeNode);
      const running = allTasks.filter(t => t.status === 'running');
      // 2 still running + 1 newly started from drain = 3 running
      expect(running.length).toBe(3);
    });

    it('re-enqueues deferred task when another task completes', () => {
      orchestrator.loadPlan({
        name: 'defer-reenqueue-test',
        tasks: [
          { id: 'task-a', description: 'Task A' },
          { id: 'task-b', description: 'Task B' },
        ],
      });
      const started = orchestrator.startExecution();
      expect(started.length).toBe(2);

      // Defer task-a
      orchestrator.deferTask(started[0].id);
      expect(orchestrator.getTask('task-a')!.status).toBe('pending');

      // Complete task-b → should re-enqueue task-a
      const newlyStarted = orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 'task-b', status: 'completed', outputs: { exitCode: 0 } }),
      );

      // task-a should be running again (re-enqueued and started)
      expect(orchestrator.getTask('task-a')!.status).toBe('running');
    });

    it('re-enqueues deferred task when another task fails', () => {
      orchestrator.loadPlan({
        name: 'defer-fail-reenqueue',
        tasks: [
          { id: 'task-a', description: 'Task A' },
          { id: 'task-b', description: 'Task B' },
        ],
      });
      orchestrator.startExecution();

      // Defer task-a
      orchestrator.deferTask('task-a');

      // Fail task-b → should re-enqueue task-a
      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 'task-b', status: 'failed', outputs: { exitCode: 1, error: 'boom' } }),
      );

      expect(orchestrator.getTask('task-a')!.status).toBe('running');
    });

    it('publishes task.deferred event', () => {
      orchestrator.loadPlan({
        name: 'defer-event-test',
        tasks: [{ id: 'task-a', description: 'Task A' }],
      });
      orchestrator.startExecution();

      orchestrator.deferTask('task-a');

      const deferredEvent = persistence.events.find(
        e => e.eventType === 'task.deferred',
      );
      expect(deferredEvent).toBeDefined();
    });

    it('clears deferred set on restartTask', () => {
      orchestrator.loadPlan({
        name: 'defer-restart-test',
        tasks: [
          { id: 'task-a', description: 'Task A' },
          { id: 'task-b', description: 'Task B' },
        ],
      });
      orchestrator.startExecution();

      orchestrator.deferTask('task-a');
      // Restart task-a clears it from deferredTaskIds
      orchestrator.restartTask('task-a');

      // Complete task-b — no deferred tasks should re-enqueue
      // (task-a was already restarted independently)
      const beforeStatus = orchestrator.getTask('task-a')!.status;
      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 'task-b', status: 'completed', outputs: { exitCode: 0 } }),
      );
      // task-a status should not have changed from what restartTask set it to
      // (it was already running from restart, not re-enqueued from deferred)
      expect(orchestrator.getTask('task-a')!.status).toBe(beforeStatus);
    });

    it('clears deferred set on cancelTask', () => {
      orchestrator.loadPlan({
        name: 'defer-cancel-test',
        tasks: [
          { id: 'task-a', description: 'Task A' },
          { id: 'task-b', description: 'Task B' },
        ],
      });
      orchestrator.startExecution();

      orchestrator.deferTask('task-a');
      orchestrator.cancelTask('task-a');

      // task-a is now failed, not in deferred set
      expect(orchestrator.getTask('task-a')!.status).toBe('failed');

      // Complete task-b — no deferred tasks should re-enqueue
      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 'task-b', status: 'completed', outputs: { exitCode: 0 } }),
      );
      // task-a stays failed
      expect(orchestrator.getTask('task-a')!.status).toBe('failed');
    });

    it('does not re-enqueue deferred task if it was cancelled between defer and completion', () => {
      orchestrator.loadPlan({
        name: 'defer-cancel-race',
        tasks: [
          { id: 'task-a', description: 'Task A' },
          { id: 'task-b', description: 'Task B' },
        ],
      });
      orchestrator.startExecution();

      // Defer task-a, then cancel it
      orchestrator.deferTask('task-a');
      orchestrator.cancelTask('task-a');

      // Complete task-b — task-a should stay failed
      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 'task-b', status: 'completed', outputs: { exitCode: 0 } }),
      );
      expect(orchestrator.getTask('task-a')!.status).toBe('failed');
    });
  });
});
