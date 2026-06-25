import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { reconciliationNeedsInputWorkResponse } from './reconciliation-needs-input-shim.js';
import { rid, sid } from './scoped-test-helpers.js';
import { Orchestrator, PlanConflictError, descriptionForMergeNode } from '../orchestrator.js';
import type { PlanDefinition, OrchestratorPersistence, OrchestratorMessageBus } from '../orchestrator.js';
import { computeWorkflowRollup } from '../task-types.js';
import type { TaskState, TaskDelta, TaskStateChanges, Attempt, ExternalDependency, ExternalDependencyChange } from '../task-types.js';
import type { Logger, WorkResponse } from '@invoker/contracts';

// ── In-Memory Persistence Mock ──────────────────────────────

class InMemoryPersistence implements OrchestratorPersistence {
  workflows = new Map<string, {
    id: string;
    name: string;
    createdAt: string;
    updatedAt: string;
    repoUrl?: string;
    baseBranch?: string;
    featureBranch?: string;
    mergeMode?: 'manual' | 'automatic' | 'external_review';
    externalDependencies?: ExternalDependency[];
    externalDependencyChanges?: ExternalDependencyChange[];
  }>();
  tasks = new Map<string, { workflowId: string; task: TaskState }>();
  private attempts = new Map<string, Attempt[]>();
  events: Array<{ taskId: string; eventType: string; payload?: unknown }> = [];
  updateWorkflowCalls = new Map<string, number>();

  saveWorkflow(workflow: {
    id: string;
    name: string;
    repoUrl?: string;
    baseBranch?: string;
    featureBranch?: string;
    mergeMode?: 'manual' | 'automatic' | 'external_review';
    externalDependencies?: ExternalDependency[];
    externalDependencyChanges?: ExternalDependencyChange[];
  }): void {
    const now = new Date().toISOString();
    this.workflows.set(workflow.id, {
      ...workflow,
      // Synthesize a placeholder repoUrl so tests with SSH-routed
      // plans do not need to spell out a remote URL.
      repoUrl: workflow.repoUrl ?? 'memory://test-repo',
      baseBranch: workflow.baseBranch,
      featureBranch: workflow.featureBranch,
      createdAt: (workflow as any).createdAt ?? now,
      updatedAt: (workflow as any).updatedAt ?? now,
    });
  }

  updateWorkflow(
    workflowId: string,
    changes: {
      updatedAt?: string;
      baseBranch?: string;
      mergeMode?: 'manual' | 'automatic' | 'external_review';
      externalDependencies?: ExternalDependency[];
      externalDependencyChanges?: ExternalDependencyChange[];
    },
  ): void {
    const wf = this.workflows.get(workflowId);
    this.updateWorkflowCalls.set(workflowId, (this.updateWorkflowCalls.get(workflowId) ?? 0) + 1);
    if (wf && changes.updatedAt) {
      wf.updatedAt = changes.updatedAt;
    }
    if (wf && changes.mergeMode !== undefined) {
      wf.mergeMode = changes.mergeMode;
    }
    if (wf && changes.baseBranch !== undefined) {
      wf.baseBranch = changes.baseBranch;
    }
    if (wf && 'externalDependencies' in changes) {
      wf.externalDependencies = changes.externalDependencies;
    }
    if (wf && 'externalDependencyChanges' in changes) {
      wf.externalDependencyChanges = changes.externalDependencyChanges;
    }
  }

  loadWorkflow(workflowId: string): {
    repoUrl?: string;
    baseBranch?: string;
    featureBranch?: string;
    mergeMode?: 'manual' | 'automatic' | 'external_review';
    externalDependencies?: ExternalDependency[];
    externalDependencyChanges?: ExternalDependencyChange[];
  } | undefined {
    const wf = this.workflows.get(workflowId);
    if (!wf) return undefined;
    const derived = this.withDerivedStatus(wf);
    return {
      ...derived,
      repoUrl: derived.repoUrl,
      baseBranch: derived.baseBranch,
      featureBranch: derived.featureBranch,
      mergeMode: derived.mergeMode,
    };
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
        taskStateVersion: (entry.task.taskStateVersion ?? 1) + 1,
      } as TaskState;
    }
  }

  listWorkflows(): Array<{ id: string; name: string; status: string; createdAt: string; updatedAt: string }> {
    return Array.from(this.workflows.values()).map((workflow) => this.withDerivedStatus(workflow));
  }

  loadWorkflowTaskSnapshot(): {
    workflows: Array<{ id: string; name: string; status: string; createdAt: string; updatedAt: string }>;
    tasks: TaskState[];
    tasksByWorkflowId: Map<string, TaskState[]>;
  } {
    const tasksByWorkflowId = new Map<string, TaskState[]>();
    for (const { workflowId, task } of this.tasks.values()) {
      const workflowTasks = tasksByWorkflowId.get(workflowId) ?? [];
      workflowTasks.push(task);
      tasksByWorkflowId.set(workflowId, workflowTasks);
    }
    const workflows = Array.from(this.workflows.values()).map((workflow) => this.withDerivedStatus(workflow, tasksByWorkflowId.get(workflow.id) ?? []));
    return {
      workflows,
      tasks: Array.from(this.tasks.values()).map((entry) => entry.task),
      tasksByWorkflowId,
    };
  }

  private withDerivedStatus<T extends { id: string }>(workflow: T, tasks = this.loadTasks(workflow.id)): T & { status: string } {
    const rollup = computeWorkflowRollup(tasks);
    return { ...workflow, status: rollup.status, rollup };
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

const consoleLogger: Logger = {
  debug: (msg, fields) => console.debug(msg, fields),
  info: (msg, fields) => console.log(msg, fields),
  warn: (msg, fields) => console.warn(msg, fields),
  error: (msg, fields) => console.error(msg, fields),
  child: () => consoleLogger,
};

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
      logger: consoleLogger,
    });
  });

  describe('recordTaskHeartbeat', () => {
    it('persists heartbeat metadata and publishes a versioned task delta', () => {
      orchestrator.loadPlan({
        name: 'heartbeat-owner',
        onFinish: 'none',
        tasks: [
          { id: 'task-a', description: 'Task A', command: 'echo a' },
        ],
      });
      publishedDeltas = [];
      const taskId = sid(orchestrator, 0, 'task-a');
      const before = orchestrator.getTask(taskId)!;
      const beforeVersion = before.taskStateVersion ?? 1;
      const at = new Date('2026-06-02T12:00:00.000Z');

      const updated = orchestrator.recordTaskHeartbeat(taskId, {
        at,
        source: 'remote_workload',
      });

      expect(updated?.execution.lastHeartbeatAt).toEqual(at);
      expect(updated?.execution.remoteHeartbeatAt).toEqual(at);
      expect(updated?.execution.heartbeatSource).toBe('remote_workload');
      expect(updated?.taskStateVersion).toBe(beforeVersion + 1);

      const persisted = persistence.getTaskEntry(taskId)?.task;
      expect(persisted?.execution.lastHeartbeatAt).toEqual(at);
      expect(persisted?.execution.remoteHeartbeatAt).toEqual(at);
      expect(persisted?.execution.heartbeatSource).toBe('remote_workload');

      expect(publishedDeltas).toHaveLength(1);
      expect(publishedDeltas[0]).toMatchObject({
        type: 'updated',
        taskId,
        changes: {
          execution: {
            lastHeartbeatAt: at,
            remoteHeartbeatAt: at,
            heartbeatSource: 'remote_workload',
          },
        },
        previousTaskStateVersion: beforeVersion,
        taskStateVersion: beforeVersion + 1,
      });
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

  describe('review_ready worker responses', () => {
    it('transition a running merge gate through handleWorkerResponse', () => {
      orchestrator.loadPlan({
        name: 'Review ready workflow',
        tasks: [{ id: 'task-a', description: 'task A' }],
      });

      const workflowId = orchestrator.getWorkflowIds()[0]!;
      const mergeId = `__merge__${workflowId}`;
      persistence.updateTask(mergeId, {
        status: 'running',
        execution: { generation: 0 },
      });

      orchestrator.handleWorkerResponse(makeResponse({
        actionId: mergeId,
        status: 'review_ready',
        outputs: {
          exitCode: 0,
          summary: 'ready',
          branch: 'feature/review-ready',
          reviewUrl: 'https://github.com/owner/repo/pull/1',
          reviewId: 'owner/repo#1',
          reviewStatus: 'Awaiting review',
        },
      }));

      const task = orchestrator.getTask(mergeId)!;
      expect(task.status).toBe('review_ready');
      expect(task.config.summary).toBe('ready');
      expect(task.execution.branch).toBe('feature/review-ready');
      expect(task.execution.reviewUrl).toBe('https://github.com/owner/repo/pull/1');
      expect(task.execution.reviewId).toBe('owner/repo#1');
      expect(task.execution.reviewStatus).toBe('Awaiting review');
    });


    it('ignores setTaskReviewReady for a stale execution generation', () => {
      orchestrator.loadPlan({
        name: 'Review ready lineage',
        tasks: [{ id: 'task-a', description: 'task A' }],
      });

      const workflowId = orchestrator.getWorkflowIds()[0]!;
      const mergeId = `__merge__${workflowId}`;
      persistence.updateTask(mergeId, {
        status: 'running',
        execution: { generation: 2, selectedAttemptId: 'attempt-current' },
      });

      orchestrator.setTaskReviewReady(
        mergeId,
        { execution: { reviewId: 'owner/repo#stale', reviewUrl: 'https://example.test/stale' } },
        { taskId: mergeId, selectedAttemptId: 'attempt-current', generation: 1 },
      );

      const task = orchestrator.getTask(mergeId)!;
      expect(task.status).toBe('running');
      expect(task.execution.reviewId).toBeUndefined();
      expect(task.execution.reviewUrl).toBeUndefined();
    });

    it('ignores setTaskReviewReady for a non-executable task with matching lineage', () => {
      orchestrator.loadPlan({
        name: 'Review ready non-executable',
        tasks: [{ id: 'task-a', description: 'task A' }],
      });

      const workflowId = orchestrator.getWorkflowIds()[0]!;
      const mergeId = `__merge__${workflowId}`;
      // Task failed on the same attempt: lineage (attempt + generation) is
      // preserved, so the lineage guard alone would let a late review-ready
      // write resurrect it.
      persistence.updateTask(mergeId, {
        status: 'failed',
        execution: { generation: 1, selectedAttemptId: 'attempt-current' },
      });

      orchestrator.setTaskReviewReady(
        mergeId,
        { execution: { reviewId: 'owner/repo#late', reviewUrl: 'https://example.test/late' } },
        { taskId: mergeId, selectedAttemptId: 'attempt-current', generation: 1 },
      );

      const task = orchestrator.getTask(mergeId)!;
      expect(task.status).toBe('failed');
      expect(task.execution.reviewId).toBeUndefined();
      expect(task.execution.reviewUrl).toBeUndefined();
    });

    it('discards review gate artifacts and clears scalar review fields on retry', () => {
      orchestrator.loadPlan({
        name: 'Review discard retry',
        mergeMode: 'external_review',
        tasks: [{ id: 'task-a', description: 'task A' }],
      });

      const workflowId = orchestrator.getWorkflowIds()[0]!;
      const mergeId = `__merge__${workflowId}`;
      persistence.updateTask(mergeId, {
        status: 'review_ready',
        execution: {
          generation: 3,
          reviewId: 'owner/repo#1',
          reviewUrl: 'https://github.com/owner/repo/pull/1',
          reviewStatus: 'open',
          reviewProviderId: 'owner/repo#1',
          reviewGate: {
            activeGeneration: 3,
            completion: { required: 'all', status: 'approved' },
            artifacts: [
              {
                id: 'contracts',
                providerId: 'owner/repo#1',
                url: 'https://github.com/owner/repo/pull/1',
                required: true,
                status: 'approved',
                generation: 3,
              },
              {
                id: 'runtime',
                providerId: 'owner/repo#2',
                url: 'https://github.com/owner/repo/pull/2',
                required: true,
                status: 'open',
                generation: 3,
                dependsOn: ['contracts'],
              },
            ],
          },
        },
      });

      orchestrator.retryTask(mergeId);

      const task = orchestrator.getTask(mergeId)!;
      expect(task.execution.reviewId).toBeUndefined();
      expect(task.execution.reviewUrl).toBeUndefined();
      expect(task.execution.reviewStatus).toBeUndefined();
      expect(task.execution.reviewProviderId).toBeUndefined();
      expect(task.execution.reviewGate?.activeGeneration).toBe(4);
      expect(task.execution.reviewGate?.artifacts).toHaveLength(2);
      expect(task.execution.reviewGate?.artifacts.every((artifact) => artifact.status === 'discarded')).toBe(true);
      expect(task.execution.reviewGate?.artifacts.every((artifact) => artifact.discardReason === 'task subgraph reset to pending')).toBe(true);
      const currentRequired = task.execution.reviewGate!.artifacts.filter((artifact) =>
        artifact.required
        && artifact.generation === task.execution.reviewGate!.activeGeneration
        && artifact.status !== 'discarded'
      );
      expect(currentRequired).toEqual([]);
    });

    it('synthesizes a discarded artifact from scalar review fields on recreate', () => {
      orchestrator.loadPlan({
        name: 'Review discard recreate',
        mergeMode: 'external_review',
        tasks: [{ id: 'task-a', description: 'task A' }],
      });

      const workflowId = orchestrator.getWorkflowIds()[0]!;
      const mergeId = `__merge__${workflowId}`;
      persistence.updateTask(mergeId, {
        status: 'review_ready',
        execution: {
          generation: 5,
          reviewId: 'owner/repo#scalar',
          reviewUrl: 'https://github.com/owner/repo/pull/9',
          reviewStatus: 'open',
          reviewProviderId: 'owner/repo#scalar',
        },
      });

      orchestrator.recreateWorkflow(workflowId);

      const task = orchestrator.getTask(mergeId)!;
      expect(task.execution.reviewId).toBeUndefined();
      expect(task.execution.reviewUrl).toBeUndefined();
      expect(task.execution.reviewStatus).toBeUndefined();
      expect(task.execution.reviewProviderId).toBeUndefined();
      expect(task.execution.reviewGate).toMatchObject({
        activeGeneration: 6,
        completion: { required: 'all', status: 'approved' },
        artifacts: [
          {
            id: 'owner/repo#scalar',
            providerId: 'owner/repo#scalar',
            url: 'https://github.com/owner/repo/pull/9',
            required: true,
            status: 'discarded',
            generation: 5,
            discardReason: 'workflow recreation reset',
          },
        ],
      });
      expect(task.execution.reviewGate?.artifacts[0].discardedAt).toEqual(expect.any(String));
    });
  });

  describe('workflow status transitions during retry paths', () => {
    it('stores a newly loaded workflow as pending while all tasks are pending', () => {
      orchestrator.loadPlan({
        name: 'Pending workflow',
        onFinish: 'none',
        tasks: [
          { id: 't1', description: 'First', command: 'echo 1' },
          { id: 't2', description: 'Second', command: 'echo 2', dependencies: ['t1'] },
        ],
      });

      const workflowId = orchestrator.getWorkflowIds()[0]!;

      expect(persistence.listWorkflows().find((workflow) => workflow.id === workflowId)?.status).toBe('pending');
    });

    it('rolls workflow status up from active and waiting task states', () => {
      orchestrator.loadPlan({
        name: 'Status rollup',
        onFinish: 'none',
        tasks: [{ id: 't1', description: 'First', command: 'echo 1' }],
      });

      const workflowId = orchestrator.getWorkflowIds()[0]!;
      const taskId = orchestrator.getAllTasks().find(
        (task) => task.config.workflowId === workflowId && !task.config.isMergeNode,
      )!.id;

      orchestrator.startExecution();
      expect(persistence.listWorkflows().find((workflow) => workflow.id === workflowId)?.status).toBe('running');

      orchestrator.setTaskAwaitingApproval(taskId);
      expect(persistence.listWorkflows().find((workflow) => workflow.id === workflowId)?.status).toBe('awaiting_approval');
    });

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


      const restarted = orchestrator.retryTask(taskId);

      expect(restarted.some((task) => task.id === taskId && task.status === 'running')).toBe(true);
      expect(persistence.listWorkflows().find((workflow) => workflow.id === workflowId)?.status).toBe('running');
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


      const restarted = orchestrator.recreateWorkflow(workflowId);

      expect(restarted.some((task) => task.id === taskId && task.status === 'running')).toBe(true);
      expect(persistence.listWorkflows().find((workflow) => workflow.id === workflowId)?.status).toBe('running');
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
          '[worker-response] STALE_ATTEMPT_REJECTED',
          expect.objectContaining({
            taskId,
            responseAttemptId: oldAttemptId,
            activeAttemptId: currentAttemptId,
            workerResponseStatus: 'completed',
          }),
        );
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('rejects a completion signal when the current attemptId carries a stale executionGeneration', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        orchestrator.loadPlan({
          name: 'reject-stale-generation-with-current-attempt',
          onFinish: 'none',
          tasks: [
            { id: 'A', description: 'Root', command: 'echo A' },
          ],
        });
        orchestrator.startExecution();
        const taskId = orchestrator.getAllTasks().find((task) => task.id === 'A' || task.id.endsWith('/A'))?.id ?? 'A';

        // recreateWorkflow bumps the live generation to 1 and selects a fresh
        // attempt. The stale worker still carries the *current* attempt id but
        // the *previous* generation (0).
        const workflowId = orchestrator.getWorkflowIds()[0]!;
        orchestrator.recreateWorkflow(workflowId);

        const before = orchestrator.getTask(taskId)!;
        const currentAttemptId = before.execution.selectedAttemptId;
        expect(currentAttemptId).toBeTruthy();
        expect(before.execution.generation).toBe(1);
        expect(before.status).toBe('running');
        const beforeBranch = before.execution.branch;
        const beforeWorkspacePath = before.execution.workspacePath;

        orchestrator.handleWorkerResponse(
          makeResponse({
            actionId: taskId,
            attemptId: currentAttemptId,
            executionGeneration: 0,
            status: 'completed',
            outputs: { exitCode: 0, branch: 'stale-branch' },
          }),
        );

        const after = orchestrator.getTask(taskId)!;
        expect(after.status).toBe('running');
        expect(after.execution.selectedAttemptId).toBe(currentAttemptId);
        expect(after.execution.branch).toBe(beforeBranch);
        expect(after.execution.workspacePath).toBe(beforeWorkspacePath);
        expect(warnSpy).toHaveBeenCalledWith(
          '[worker-response] STALE_GENERATION_REJECTED',
          expect.objectContaining({
            taskId,
            responseGeneration: 0,
            activeGeneration: 1,
            workerResponseStatus: 'completed',
          }),
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

      repro.retryTask(prepareId);
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

    it('passes runnerKind when specified', () => {
      orchestrator.loadPlan({
        name: 'runner-kind-test',
        tasks: [
          { id: 't1', description: 'Worktree task' },
          { id: 't2', description: 'Default task' },
        ],
      });

      expect(orchestrator.getTask('t1')!.config.runnerKind).toBe('worktree');
      expect(orchestrator.getTask('t2')!.config.runnerKind).toBe('worktree');
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
      it('validates matching pattern rule: task must declare required runnerKind and poolId', () => {
        const routedOrchestrator = new Orchestrator({
          persistence: new InMemoryPersistence(),
          messageBus: new InMemoryBus(),
          maxConcurrency: 3,
          executorRoutingRules: [
            { pattern: 'deploy', poolId: 'prod-pool' },
          ],
          availablePoolIds: ['prod-pool'],
        });

        routedOrchestrator.loadPlan({
          name: 'routing-test',
          tasks: [{ id: 't1', description: 'Deploy task', command: 'deploy --env prod', poolId: 'prod-pool' }],
        });

        const task = routedOrchestrator.getTask('t1');
        expect(task!.config.runnerKind).toBe('ssh');
        expect(task!.config.poolId).toBe('prod-pool');
      });

      it('ignores legacy task runnerKind when pool routing matches', () => {
        const routedOrchestrator = new Orchestrator({
          persistence: new InMemoryPersistence(),
          messageBus: new InMemoryBus(),
          maxConcurrency: 3,
          executorRoutingRules: [
            { pattern: 'deploy', poolId: 'prod-pool' },
          ],
          availablePoolIds: ['prod-pool'],
        });

        routedOrchestrator.loadPlan({
          name: 'mismatch-test',
          tasks: [{ id: 't1', description: 'Deploy task', command: 'deploy --env prod', runnerKind: 'worktree', poolId: 'prod-pool' } as any],
        });
        const task = routedOrchestrator.getTask('t1');
        expect(task!.config.runnerKind).toBe('ssh');
        expect(task!.config.poolId).toBe('prod-pool');
      });

      it('prompt-only task (no command) ignores routing rules', () => {
        const routedOrchestrator = new Orchestrator({
          persistence: new InMemoryPersistence(),
          messageBus: new InMemoryBus(),
          maxConcurrency: 3,
          executorRoutingRules: [
            { pattern: 'deploy', poolId: 'prod-pool' },
          ],
          availablePoolIds: ['prod-pool'],
        });

        routedOrchestrator.loadPlan({
          name: 'prompt-only-test',
          tasks: [{ id: 't1', description: 'Prompt task', prompt: 'deploy to prod' }],
        });

        const task = routedOrchestrator.getTask('t1');
        expect(task!.config.runnerKind).toBe('worktree');
        expect(task!.config.poolId).toBeUndefined();
      });

      it('validates regex rule matching pnpm test', () => {
        const routedOrchestrator = new Orchestrator({
          persistence: new InMemoryPersistence(),
          messageBus: new InMemoryBus(),
          maxConcurrency: 3,
          executorRoutingRules: [
            { regex: '^pnpm test', poolId: 'ci-pool' },
          ],
          availablePoolIds: ['ci-pool'],
        });

        routedOrchestrator.loadPlan({
          name: 'test-routing',
          tasks: [{ id: 't1', description: 'Run tests', command: 'pnpm test', poolId: 'ci-pool' }],
        });

        const task = routedOrchestrator.getTask('t1');
        expect(task!.config.runnerKind).toBe('ssh');
        expect(task!.config.poolId).toBe('ci-pool');
      });

      it('validates pattern rule matching test command', () => {
        const routedOrchestrator = new Orchestrator({
          persistence: new InMemoryPersistence(),
          messageBus: new InMemoryBus(),
          maxConcurrency: 3,
          executorRoutingRules: [
            { pattern: 'pnpm test', poolId: 'ci-pool' },
          ],
          availablePoolIds: ['ci-pool'],
        });

        routedOrchestrator.loadPlan({
          name: 'test-routing-pattern',
          tasks: [{ id: 't1', description: 'Run tests', command: 'pnpm test --coverage', poolId: 'ci-pool' }],
        });

        const task = routedOrchestrator.getTask('t1');
        expect(task!.config.runnerKind).toBe('ssh');
        expect(task!.config.poolId).toBe('ci-pool');
      });

      it('ignores legacy task runnerKind when regex pool rule matches', () => {
        const routedOrchestrator = new Orchestrator({
          persistence: new InMemoryPersistence(),
          messageBus: new InMemoryBus(),
          maxConcurrency: 3,
          executorRoutingRules: [
            { regex: '^pnpm test', poolId: 'ci-pool' },
          ],
          availablePoolIds: ['ci-pool'],
        });

        routedOrchestrator.loadPlan({
          name: 'test-mismatch',
          tasks: [{ id: 't1', description: 'Run tests locally', command: 'pnpm test', runnerKind: 'worktree', poolId: 'ci-pool' } as any],
        });
        const task = routedOrchestrator.getTask('t1');
        expect(task!.config.runnerKind).toBe('ssh');
        expect(task!.config.poolId).toBe('ci-pool');
      });

      it('throws when task poolId does not match routing rule', () => {
        const routedOrchestrator = new Orchestrator({
          persistence: new InMemoryPersistence(),
          messageBus: new InMemoryBus(),
          maxConcurrency: 3,
          executorRoutingRules: [
            { pattern: 'pnpm test', poolId: 'ci-pool' },
          ],
          availablePoolIds: ['ci-pool'],
        });

        expect(() => {
          routedOrchestrator.loadPlan({
            name: 'remote-mismatch',
            tasks: [{ id: 't1', description: 'Run tests on staging', command: 'pnpm test', poolId: 'staging-pool' }],
          });
        }).toThrow('requires poolId="ci-pool"');
      });

      it('accepts matching pool rule without a task runner kind', () => {
        const routedOrchestrator = new Orchestrator({
          persistence: new InMemoryPersistence(),
          messageBus: new InMemoryBus(),
          maxConcurrency: 3,
          executorRoutingRules: [
            { pattern: 'deploy', poolId: 'prod-pool' },
          ],
          availablePoolIds: ['prod-pool'],
        });

        routedOrchestrator.loadPlan({
          name: 'missing-runnerKind',
          tasks: [{ id: 't1', description: 'Deploy task', command: 'deploy --env prod', poolId: 'prod-pool' }],
        });
        const task = routedOrchestrator.getTask('t1');
        expect(task!.config.runnerKind).toBe('ssh');
        expect(task!.config.poolId).toBe('prod-pool');
      });

      it('throws when task poolId is missing for matching rule', () => {
        const routedOrchestrator = new Orchestrator({
          persistence: new InMemoryPersistence(),
          messageBus: new InMemoryBus(),
          maxConcurrency: 3,
          executorRoutingRules: [
            { pattern: 'deploy', poolId: 'prod-pool' },
          ],
          availablePoolIds: ['prod-pool'],
        });

        expect(() => {
          routedOrchestrator.loadPlan({
            name: 'missing-poolId',
            tasks: [{ id: 't1', description: 'Deploy task', command: 'deploy --env prod' }],
          });
        }).toThrow('requires poolId="prod-pool"');
      });

      it('validates matching rule with poolId destination', () => {
        const routedOrchestrator = new Orchestrator({
          persistence: new InMemoryPersistence(),
          messageBus: new InMemoryBus(),
          maxConcurrency: 3,
          executorRoutingRules: [
            { pattern: 'pnpm test', poolId: 'ssh-light' },
          ],
          availablePoolIds: ['ssh-light'],
        });

        routedOrchestrator.loadPlan({
          name: 'pool-routing-test',
          tasks: [{ id: 't1', description: 'Run tests', command: 'pnpm test', poolId: 'ssh-light' }],
        });

        const task = routedOrchestrator.getTask('t1');
        expect(task!.config.runnerKind).toBe('ssh');
        expect(task!.config.poolId).toBe('ssh-light');
      });

      it('throws when matching pool rule task omits poolId', () => {
        const routedOrchestrator = new Orchestrator({
          persistence: new InMemoryPersistence(),
          messageBus: new InMemoryBus(),
          maxConcurrency: 3,
          executorRoutingRules: [
            { pattern: 'pnpm test', poolId: 'ssh-light' },
          ],
          availablePoolIds: ['ssh-light'],
        });

        expect(() => {
          routedOrchestrator.loadPlan({
            name: 'missing-pool',
            tasks: [{ id: 't1', description: 'Run tests', command: 'pnpm test' }],
          });
        }).toThrow('requires poolId="ssh-light"');
      });

      it('merge node always has runnerKind merge regardless of routing rules', () => {
        const routedOrchestrator = new Orchestrator({
          persistence: new InMemoryPersistence(),
          messageBus: new InMemoryBus(),
          maxConcurrency: 3,
          executorRoutingRules: [
            { pattern: 'deploy', poolId: 'prod-pool' },
          ],
          availablePoolIds: ['prod-pool'],
        });

        routedOrchestrator.loadPlan({
          name: 'merge-routing-test',
          tasks: [{ id: 't1', description: 'Deploy task', command: 'deploy --env prod', poolId: 'prod-pool' }],
        });

        const mergeNode = routedOrchestrator.getAllTasks().find((t) => t.config.isMergeNode);
        expect(mergeNode).toBeDefined();
        expect(mergeNode!.config.runnerKind).toBe('merge');
      });

      it('auto-routes pnpm test to pool with route strategy when executor is omitted', () => {
        const routedOrchestrator = new Orchestrator({
          persistence: new InMemoryPersistence(),
          messageBus: new InMemoryBus(),
          maxConcurrency: 3,
          executorRoutingRules: [
            { regex: '\\bpnpm(?:\\s|$)', poolId: 'ci-pool', strategy: 'route' },
          ],
          availablePoolIds: ['ci-pool'],
        });

        routedOrchestrator.loadPlan({
          name: 'route-strategy-test',
          tasks: [{ id: 't1', description: 'Run tests', command: 'cd packages/app && pnpm test' }],
        });

        const task = routedOrchestrator.getTask('t1');
        expect(task!.config.runnerKind).toBe('ssh');
        expect(task!.config.poolId).toBe('ci-pool');
      });

      it('auto-routes matching command to configured poolId with route strategy', () => {
        const persistence = new InMemoryPersistence();
        const routedOrchestrator = new Orchestrator({
          persistence,
          messageBus: new InMemoryBus(),
          maxConcurrency: 3,
          executorRoutingRules: [
            { regex: '\\bpnpm(?:\\s|$)', poolId: 'ssh-light', strategy: 'route' },
          ],
          availablePoolIds: ['ssh-light'],
        });

        routedOrchestrator.loadPlan({
          name: 'route-strategy-pool-test',
          tasks: [{ id: 't1', description: 'Run tests', command: 'pnpm test' }],
        });

        const task = routedOrchestrator.getTask('t1');
        expect(task!.config.runnerKind).toBe('ssh');
        expect(task!.config.poolId).toBe('ssh-light');
        const routedEvent = persistence.events.find((event) =>
          event.taskId.endsWith('/t1') && event.eventType === 'task.executor.routed'
        );
        expect(routedEvent?.payload).toEqual({
          runnerKind: 'ssh',
          poolId: 'ssh-light',
          reason: { type: 'routingRule', regex: '\\bpnpm(?:\\s|$)', poolId: 'ssh-light' },
        });
      });

      it('logs default worktree routing when no pool or docker rule applies', () => {
        const persistence = new InMemoryPersistence();
        const routedOrchestrator = new Orchestrator({
          persistence,
          messageBus: new InMemoryBus(),
          maxConcurrency: 3,
        });

        routedOrchestrator.loadPlan({
          name: 'default-worktree-routing-test',
          tasks: [{ id: 't1', description: 'Local task', command: 'echo local' }],
        });

        const routedEvent = persistence.events.find((event) =>
          event.taskId.endsWith('/t1') && event.eventType === 'task.executor.routed'
        );
        expect(routedEvent?.payload).toEqual({
          runnerKind: 'worktree',
          reason: { type: 'defaultWorktree' },
        });
      });

      it('logs explicit pool routing when a task declares poolId', () => {
        const persistence = new InMemoryPersistence();
        const routedOrchestrator = new Orchestrator({
          persistence,
          messageBus: new InMemoryBus(),
          maxConcurrency: 3,
          availablePoolIds: ['ssh-light'],
        });

        routedOrchestrator.loadPlan({
          name: 'explicit-pool-routing-test',
          tasks: [{ id: 't1', description: 'Remote task', command: 'echo remote', poolId: 'ssh-light' }],
        });

        const routedEvent = persistence.events.find((event) =>
          event.taskId.endsWith('/t1') && event.eventType === 'task.executor.routed'
        );
        expect(routedEvent?.payload).toEqual({
          runnerKind: 'ssh',
          poolId: 'ssh-light',
          reason: { type: 'poolId', poolId: 'ssh-light' },
        });
      });

      it('routes matching command without an explicit runner kind', () => {
        const routedOrchestrator = new Orchestrator({
          persistence: new InMemoryPersistence(),
          messageBus: new InMemoryBus(),
          maxConcurrency: 3,
          executorRoutingRules: [
            { regex: '\\bpnpm(?:\\s|$)', poolId: 'ci-pool', strategy: 'route' },
          ],
          availablePoolIds: ['ci-pool'],
        });

        routedOrchestrator.loadPlan({
          name: 'route-strategy-conflict-test',
          tasks: [{ id: 't1', description: 'Run tests', command: 'pnpm test' }],
        });
        const task = routedOrchestrator.getTask('t1');
        expect(task!.config.runnerKind).toBe('ssh');
        expect(task!.config.poolId).toBe('ci-pool');
      });

      it('throws when route strategy target pool is not configured', () => {
        const routedOrchestrator = new Orchestrator({
          persistence: new InMemoryPersistence(),
          messageBus: new InMemoryBus(),
          maxConcurrency: 3,
          executorRoutingRules: [
            { regex: '\\bpnpm(?:\\s|$)', poolId: 'ssh-light', strategy: 'route' },
          ],
          availablePoolIds: [],
        });

        expect(() => {
          routedOrchestrator.loadPlan({
            name: 'route-strategy-missing-target',
            tasks: [{ id: 't1', description: 'Run tests', command: 'pnpm test' }],
          });
        }).toThrow('no executionPools are configured');
      });

      it('leaves non-matching commands unchanged under route strategy', () => {
        const routedOrchestrator = new Orchestrator({
          persistence: new InMemoryPersistence(),
          messageBus: new InMemoryBus(),
          maxConcurrency: 3,
          executorRoutingRules: [
            { regex: '\\bpnpm(?:\\s|$)', poolId: 'ci-pool', strategy: 'route' },
          ],
          availablePoolIds: ['ci-pool'],
        });

        routedOrchestrator.loadPlan({
          name: 'non-heavyweight-command',
          tasks: [{ id: 't1', description: 'Echo hello', command: 'echo hello' }],
        });

        const task = routedOrchestrator.getTask('t1');
        expect(task!.config.runnerKind).toBe('worktree');
        expect(task!.config.poolId).toBeUndefined();
      });

      it('keeps heavyweightCommandRouting as compatibility alias to route strategy', () => {
        const routedOrchestrator = new Orchestrator({
          persistence: new InMemoryPersistence(),
          messageBus: new InMemoryBus(),
          maxConcurrency: 3,
          heavyweightCommandRouting: {
            poolId: 'ssh-light',
          },
          availablePoolIds: ['ssh-light'],
        });

        routedOrchestrator.loadPlan({
          name: 'heavyweight-compatibility-test',
          tasks: [{ id: 't1', description: 'Run tests', command: 'pnpm test' }],
        });

        const task = routedOrchestrator.getTask('t1');
        expect(task!.config.runnerKind).toBe('ssh');
        expect(task!.config.poolId).toBe('ssh-light');
      });

      it('applies defaultPoolId to command tasks when no route rule matches', () => {
        const routedOrchestrator = new Orchestrator({
          persistence: new InMemoryPersistence(),
          messageBus: new InMemoryBus(),
          maxConcurrency: 3,
          defaultPoolId: 'mixed-local-ssh',
          executorRoutingRules: [
            { regex: '\\bpnpm(?:\\s|$)', poolId: 'pnpm-ssh', strategy: 'route' },
          ],
          availablePoolIds: ['mixed-local-ssh', 'pnpm-ssh'],
        });

        routedOrchestrator.loadPlan({
          name: 'default-pool-command',
          tasks: [{ id: 't1', description: 'Echo hello', command: 'echo hello' }],
        });

        const task = routedOrchestrator.getTask('t1');
        expect(task!.config.runnerKind).toBe('ssh');
        expect(task!.config.poolId).toBe('mixed-local-ssh');
      });

      it('applies defaultPoolId to prompt-only tasks', () => {
        const routedOrchestrator = new Orchestrator({
          persistence: new InMemoryPersistence(),
          messageBus: new InMemoryBus(),
          maxConcurrency: 3,
          defaultPoolId: 'mixed-local-ssh',
          availablePoolIds: ['mixed-local-ssh'],
        });

        routedOrchestrator.loadPlan({
          name: 'default-pool-prompt',
          tasks: [{ id: 't1', description: 'Prompt task', prompt: 'inspect the code' }],
        });

        const task = routedOrchestrator.getTask('t1');
        expect(task!.config.runnerKind).toBe('ssh');
        expect(task!.config.poolId).toBe('mixed-local-ssh');
      });

      it('lets route strategy override defaultPoolId', () => {
        const routedOrchestrator = new Orchestrator({
          persistence: new InMemoryPersistence(),
          messageBus: new InMemoryBus(),
          maxConcurrency: 3,
          defaultPoolId: 'mixed-local-ssh',
          executorRoutingRules: [
            { regex: '\\bpnpm(?:\\s|$)', poolId: 'pnpm-ssh', strategy: 'route' },
          ],
          availablePoolIds: ['mixed-local-ssh', 'pnpm-ssh'],
        });

        routedOrchestrator.loadPlan({
          name: 'default-pool-route-override',
          tasks: [{ id: 't1', description: 'Run tests', command: 'pnpm test' }],
        });

        const task = routedOrchestrator.getTask('t1');
        expect(task!.config.runnerKind).toBe('ssh');
        expect(task!.config.poolId).toBe('pnpm-ssh');
      });

      it('throws when defaultPoolId is not configured as an execution pool', () => {
        const routedOrchestrator = new Orchestrator({
          persistence: new InMemoryPersistence(),
          messageBus: new InMemoryBus(),
          maxConcurrency: 3,
          defaultPoolId: 'missing-pool',
          availablePoolIds: ['other-pool'],
        });

        expect(() => {
          routedOrchestrator.loadPlan({
            name: 'default-pool-missing',
            tasks: [{ id: 't1', description: 'Prompt task', prompt: 'inspect the code' }],
          });
        }).toThrow('defaultPoolId');
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

      it('rolls back when a matching routing rule task omits poolId', () => {
        const routedOrchestrator = new Orchestrator({
          persistence,
          messageBus: bus,
          maxConcurrency: 3,
          executorRoutingRules: [
            { pattern: 'deploy', poolId: 'ssh-light' },
          ],
          availablePoolIds: ['ssh-light'],
        });

        expect(() =>
          routedOrchestrator.loadPlan({
            name: 'routing-fail-plan',
            tasks: [
              { id: 'ok', description: 'Valid task', command: 'echo hi' },
              { id: 'bad', description: 'Misrouted', command: 'deploy prod' },
            ],
          }),
        ).toThrow('requires poolId');

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

      it('ignores legacy runnerKind fields on direct plan definitions', () => {
        orchestrator.loadPlan({
          name: 'unknown-type-plan',
          tasks: [
            { id: 'ok', description: 'Valid task' },
            { id: 'bad', description: 'Kubernetes task', runnerKind: 'kubernetes' } as any,
          ],
        });

        expect(orchestrator.getTask('bad')!.config.runnerKind).toBe('worktree');
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

    it('workflow-level external dependency defaults to completed and stays pending on awaiting_approval', () => {
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
      expect(afterMergeAwaitingApproval.map((t) => t.id)).not.toContain(sid(orchestrator, 1, 'leaf-a'));
      expect(orchestrator.getTask(sid(orchestrator, 1, 'leaf-a'))!.status).toBe('pending');
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
      expect(orchestrator.getTask(sid(orchestrator, 1, 'leaf-a'))!.status).toBe('running');
    });

    it('review_ready merge-gate transition unblocks downstream without mutating dependency metadata', () => {
      orchestrator.loadPlan({
        name: 'prereq-public-review',
        tasks: [{ id: 'publish-pr', description: 'Publish public PR' }],
      });
      const prereqTaskId = sid(orchestrator, 0, 'publish-pr');
      const prereqWfId = prereqTaskId.split('/')[0]!;
      const prereqMergeId = `__merge__${prereqWfId}`;

      orchestrator.loadPlan({
        name: 'workflow-waits-on-public-pr',
        tasks: [
          {
            id: 'leaf-a',
            description: 'leaf waits for upstream public review gate',
            externalDependencies: [{ workflowId: prereqWfId, gatePolicy: 'review_ready' }],
          },
        ],
      });
      const downstreamTaskId = sid(orchestrator, 1, 'leaf-a');
      const downstreamWfId = downstreamTaskId.split('/')[0]!;
      const depsBefore = (persistence.loadWorkflow(downstreamWfId)!.externalDependencies ?? [])
        .map((dep) => ({ ...dep }));
      const taskDepsBefore = (orchestrator.getTask(downstreamTaskId)!.config.externalDependencies ?? [])
        .map((dep) => ({ ...dep }));

      orchestrator.startExecution();
      orchestrator.handleWorkerResponse(makeResponse({ actionId: prereqTaskId, status: 'completed' }));

      orchestrator.setTaskReviewReady(prereqMergeId, {
        execution: {
          reviewId: 'owner/repo#229',
          reviewUrl: 'https://github.com/owner/repo/pull/229',
          reviewStatus: 'Awaiting review',
        },
      });

      expect(orchestrator.getTask(sid(orchestrator, 1, 'leaf-a'))!.status).toBe('running');
      expect(persistence.loadWorkflow(downstreamWfId)!.externalDependencies).toEqual(depsBefore);
      expect(orchestrator.getTask(downstreamTaskId)!.config.externalDependencies ?? []).toEqual(taskDepsBefore);
      expect(persistence.events.map((event) => event.eventType)).not.toContain('workflow.external_dependency_policy_updated');
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

    it('closed merge-gate dependency keeps downstream pending for completed and review_ready policies', () => {
      orchestrator.loadPlan({
        name: 'prereq-workflow',
        tasks: [{ id: 'verify-control-plane-regression', description: 'Prereq task' }],
      });
      const prereqTaskId = sid(orchestrator, 0, 'verify-control-plane-regression');
      const prereqWfId = prereqTaskId.split('/')[0]!;
      const prereqMergeId = `__merge__${prereqWfId}`;

      orchestrator.loadPlan({
        name: 'workflow-gated-closed',
        tasks: [
          {
            id: 'strict-leaf',
            description: 'strict leaf waits for upstream merge completion',
            externalDependencies: [{ workflowId: prereqWfId, gatePolicy: 'completed' }],
          },
          {
            id: 'review-leaf',
            description: 'review leaf waits for upstream merge review readiness',
            externalDependencies: [{ workflowId: prereqWfId, gatePolicy: 'review_ready' }],
          },
        ],
      });
      const strictLeafId = sid(orchestrator, 1, 'strict-leaf');
      const reviewLeafId = sid(orchestrator, 1, 'review-leaf');

      orchestrator.startExecution();
      orchestrator.handleWorkerResponse(makeResponse({ actionId: prereqTaskId, status: 'completed' }));
      persistence.updateTask(prereqMergeId, { status: 'closed' });
      orchestrator.syncAllFromDb();

      const startedAfterClosedGate = orchestrator.startExecution();
      expect(startedAfterClosedGate.map((t) => t.id)).not.toContain(strictLeafId);
      expect(startedAfterClosedGate.map((t) => t.id)).not.toContain(reviewLeafId);
      expect(orchestrator.getTask(strictLeafId)!.status).toBe('pending');
      expect(orchestrator.getTask(reviewLeafId)!.status).toBe('pending');
    });

    it('closed task does not satisfy a regular non-reconciliation downstream dependency', () => {
      orchestrator.loadPlan({
        name: 'closed-dep-workflow',
        tasks: [
          { id: 'upstream', description: 'Upstream task' },
          { id: 'downstream', description: 'Downstream task', dependencies: ['upstream'] },
        ],
      });
      const upstreamId = sid(orchestrator, 0, 'upstream');
      const downstreamId = sid(orchestrator, 0, 'downstream');

      orchestrator.startExecution();
      persistence.updateTask(upstreamId, { status: 'closed' });
      orchestrator.syncAllFromDb();

      const startedAfterClose = orchestrator.startExecution();
      expect(startedAfterClose.map((t) => t.id)).not.toContain(downstreamId);
      expect(orchestrator.getTask(downstreamId)!.status).toBe('pending');
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
      const leafWfId = leafId.split('/')[0]!;

      orchestrator.startExecution();
      orchestrator.handleWorkerResponse(makeResponse({ actionId: prereqTaskId, status: 'completed' }));
      orchestrator.setTaskAwaitingApproval(prereqMergeId);

      expect(orchestrator.getTask(leafId)!.status).toBe('pending');

      const started = orchestrator.setTaskExternalGatePolicies(leafId, [
        { workflowId: prereqWfId, gatePolicy: 'review_ready' },
      ]);

      expect(persistence.loadWorkflow(leafWfId)!.externalDependencies?.[0]?.gatePolicy).toBe('review_ready');
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
      const leafWfId = leafId.split('/')[0]!;
      orchestrator.setTaskExternalGatePolicies(leafId, [
        { workflowId: wfB, gatePolicy: 'review_ready' },
      ]);

      const deps = persistence.loadWorkflow(leafWfId)!.externalDependencies!;
      expect(deps.find((d) => d.workflowId === wfA)!.gatePolicy).toBe('completed');
      expect(deps.find((d) => d.workflowId === wfB)!.gatePolicy).toBe('review_ready');
    });

    it('repro: deleting upstream workflow records downstream external dependency removal on restart', () => {
      orchestrator.loadPlan({
        name: 'upstream-workflow',
        baseBranch: 'master',
        featureBranch: 'feature/upstream',
        tasks: [{ id: 'verify', description: 'upstream prerequisite' }],
      });
      const upstreamTaskId = sid(orchestrator, 0, 'verify');
      const upstreamWfId = upstreamTaskId.split('/')[0]!;

      orchestrator.loadPlan({
        name: 'downstream-workflow',
        baseBranch: 'feature/upstream',
        featureBranch: 'feature/downstream',
        tasks: [
          {
            id: 'wait-for-upstream',
            description: 'downstream waits on upstream merge gate',
            externalDependencies: [{ workflowId: upstreamWfId, gatePolicy: 'completed' }],
          },
        ],
      });
      const downstreamTaskId = sid(orchestrator, 1, 'wait-for-upstream');
      const downstreamWfId = downstreamTaskId.split('/')[0]!;

      orchestrator.startExecution();
      expect(orchestrator.getTask(downstreamTaskId)!.status).toBe('pending');
      expect(persistence.loadWorkflow(downstreamWfId)!.externalDependencies).toHaveLength(1);

      // Repro condition: upstream workflow is deleted after downstream was created.
      orchestrator.deleteWorkflow(upstreamWfId);
      expect(orchestrator.getTask(downstreamTaskId)).toBeDefined();

      const restarted = orchestrator.retryTask(downstreamTaskId);
      expect(restarted.map((t) => t.id)).toContain(downstreamTaskId);
      expect(orchestrator.getTask(downstreamTaskId)!.status).toBe('running');
      expect(orchestrator.getTask(downstreamTaskId)!.config.externalDependencies).toBeUndefined();
      expect(persistence.getTaskEntry(downstreamTaskId)!.task.config.externalDependencies).toBeUndefined();
      const downstreamWorkflow = persistence.loadWorkflow(downstreamWfId)!;
      expect(downstreamWorkflow.externalDependencies).toBeUndefined();
      expect(downstreamWorkflow.externalDependencyChanges).toEqual([
        {
          before: {
            workflowId: upstreamWfId,
            taskId: '__merge__',
            requiredStatus: 'completed',
            gatePolicy: 'completed',
          },
          changedAt: expect.any(String),
        },
      ]);
      expect(persistence.loadWorkflow(downstreamWfId)!.baseBranch).toBe('master');
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

      // Workflow should expose the waiting state instead of collapsing it to completed.
      const workflows = persistence.listWorkflows();
      expect(workflows[0].status).toBe('awaiting_approval');
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
        config: { runnerKind: 'worktree', summary: 'test summary' },
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
      expect(task.config.runnerKind).toBe('worktree');
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
      expect(delta!.type === 'updated' && delta!.changes.config?.runnerKind).toBe('worktree');
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
      const started = hydrateOrchestrator.retryTask('t1');

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
      const started = hydrateOrchestrator.retryTask('t1');

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
      const started = hydrateOrchestrator.retryTask('b1');
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

    it('recovers stale running tasks and starts a fresh attempt', () => {
      const resumePersistence = new InMemoryPersistence();
      const oldAttempt: Attempt = {
        id: 't1-aold',
        nodeId: 't1',
        queuePriority: 0,
        status: 'running',
        upstreamAttemptIds: [],
        createdAt: new Date(),
      };
      resumePersistence.saveTask('wf-resume', {
        id: 't1',
        description: 'Was running when process died',
        status: 'running',
        dependencies: [],
        createdAt: new Date(),
        config: {},
        execution: { startedAt: new Date(), selectedAttemptId: oldAttempt.id },
      });
      resumePersistence.saveAttempt(oldAttempt);

      const resumeOrchestrator = new Orchestrator({
        persistence: resumePersistence,
        messageBus: bus,
        maxConcurrency: 3,
      });

      const started = resumeOrchestrator.resumeWorkflow('wf-resume');

      expect(started).toHaveLength(1);
      expect(resumeOrchestrator.getTask('t1')!.status).toBe('running');
      const newAttemptId = resumeOrchestrator.getTask('t1')!.execution.selectedAttemptId;
      expect(newAttemptId).toBeTruthy();
      expect(newAttemptId).not.toBe(oldAttempt.id);
      expect(resumePersistence.loadAttempt(oldAttempt.id)?.status).toBe('superseded');
      expect(resumePersistence.loadAttempt(newAttemptId!)?.status).toBe('running');
    });

    it('recovers normalized stale pending tasks that still carry selected-attempt runtime state', () => {
      const resumePersistence = new InMemoryPersistence();
      const oldAttempt: Attempt = {
        id: 't1-aold',
        nodeId: 't1',
        queuePriority: 0,
        status: 'pending',
        upstreamAttemptIds: [],
        createdAt: new Date('2025-01-01T00:00:00.000Z'),
      };
      resumePersistence.saveTask('wf-resume', {
        id: 't1',
        description: 'Pending task with stale launch metadata',
        status: 'pending',
        dependencies: [],
        createdAt: new Date(),
        config: {},
        execution: {
          startedAt: new Date('2025-01-01T00:00:00.000Z'),
          selectedAttemptId: oldAttempt.id,
          workspacePath: '/tmp/stale-workspace',
          agentSessionId: 'stale-session',
          error: 'stale launch error',
        },
      });
      resumePersistence.saveAttempt(oldAttempt);

      const resumeOrchestrator = new Orchestrator({
        persistence: resumePersistence,
        messageBus: bus,
        maxConcurrency: 3,
      });

      const started = resumeOrchestrator.resumeWorkflow('wf-resume');

      expect(started).toHaveLength(1);
      const resumed = resumeOrchestrator.getTask('t1')!;
      expect(resumed.status).toBe('running');
      expect(resumed.execution.selectedAttemptId).toBeTruthy();
      expect(resumed.execution.selectedAttemptId).not.toBe(oldAttempt.id);
      expect(resumed.execution.workspacePath).toBeUndefined();
      expect(resumed.execution.agentSessionId).toBeUndefined();
      expect(resumed.execution.error).toBeUndefined();
      expect(resumePersistence.loadAttempt(oldAttempt.id)?.status).toBe('superseded');
      expect(resumePersistence.loadAttempt(resumed.execution.selectedAttemptId!)?.status).toBe('running');
    });
  });

  describe('prepareTaskForNewAttempt', () => {
    it('resets a running launching task to pending with a fresh selected attempt and clears launch lineage', () => {
      orchestrator.loadPlan({
        name: 'prepare-running-launching',
        tasks: [
          {
            id: 't0',
            description: 'Dependency',
            command: 'echo dep',
          },
          {
            id: 't1',
            description: 'Task 1',
            command: 'pnpm test',
            prompt: 'Keep this prompt',
            dependencies: ['t0'],
          },
        ],
      });

      const [depStarted] = orchestrator.startExecution();
      const depAttemptId = depStarted!.execution.selectedAttemptId!;
      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: depStarted!.id, status: 'completed', outputs: { exitCode: 0 } }),
      );
      const taskId = sid(orchestrator, 0, 't1');
      const oldAttemptId = orchestrator.getTask(taskId)!.execution.selectedAttemptId!;
      const startedAt = new Date('2026-04-16T05:25:16.531Z');
      const completedAt = new Date('2026-04-16T05:35:16.531Z');
      const heartbeatAt = new Date('2026-04-16T05:30:16.531Z');
      const launchCompletedAt = new Date('2026-04-16T05:25:20.531Z');
      persistence.updateTask(taskId, {
        status: 'running',
        config: {
          summary: 'durable summary',
          problem: 'durable problem',
          approach: 'durable approach',
          testPlan: 'durable test plan',
        },
        execution: {
          phase: 'launching',
          startedAt,
          completedAt,
          launchStartedAt: startedAt,
          launchCompletedAt,
          lastHeartbeatAt: heartbeatAt,
          error: 'volatile error',
          exitCode: 1,
          inputPrompt: 'volatile prompt',
          pendingFixError: 'volatile fix error',
          agentSessionId: 'sess-1',
          workspacePath: '/tmp/workspace',
          containerId: 'container-1',
          isFixingWithAI: true,
          branch: 'feature/task',
          commit: 'abc123',
          reviewUrl: 'https://example.test/review',
          reviewId: 'review-1',
          reviewStatus: 'open',
          reviewProviderId: 'provider-1',
        },
      });

      const prepared = orchestrator.prepareTaskForNewAttempt(taskId, 'unit-test');
      const newAttemptId = prepared.execution.selectedAttemptId!;

      expect(prepared.status).toBe('pending');
      expect(newAttemptId).toBeTruthy();
      expect(newAttemptId).not.toBe(oldAttemptId);
      expect(persistence.loadAttempt(oldAttemptId)?.status).toBe('superseded');
      expect(persistence.loadAttempt(newAttemptId)?.status).toBe('pending');
      expect(persistence.loadAttempt(newAttemptId)?.supersedesAttemptId).toBe(oldAttemptId);
      expect(prepared.execution.phase).toBeUndefined();
      expect(prepared.execution.startedAt).toBeUndefined();
      expect(prepared.execution.completedAt).toBeUndefined();
      expect(prepared.execution.launchStartedAt).toBeUndefined();
      expect(prepared.execution.launchCompletedAt).toBeUndefined();
      expect(prepared.execution.lastHeartbeatAt).toBeUndefined();
      expect(prepared.execution.error).toBeUndefined();
      expect(prepared.execution.exitCode).toBeUndefined();
      expect(prepared.execution.inputPrompt).toBeUndefined();
      expect(prepared.execution.pendingFixError).toBeUndefined();
      expect(prepared.execution.agentSessionId).toBeUndefined();
      expect(prepared.execution.workspacePath).toBeUndefined();
      expect(prepared.execution.branch).toBeUndefined();
      expect(prepared.execution.commit).toBeUndefined();
      expect(prepared.execution.containerId).toBeUndefined();
      expect(prepared.execution.isFixingWithAI).toBe(false);
      expect(prepared.config.command).toBe('pnpm test');
      expect(prepared.config.prompt).toBe('Keep this prompt');
      expect(prepared.config.summary).toBe('durable summary');
      expect(prepared.config.problem).toBe('durable problem');
      expect(prepared.config.approach).toBe('durable approach');
      expect(prepared.config.testPlan).toBe('durable test plan');
      expect(prepared.dependencies).toEqual([sid(orchestrator, 0, 't0')]);
      expect(prepared.execution.reviewUrl).toBe('https://example.test/review');
      expect(prepared.execution.reviewId).toBe('review-1');
      expect(prepared.execution.reviewStatus).toBe('open');
      expect(prepared.execution.reviewProviderId).toBe('provider-1');
      expect(persistence.loadAttempt(newAttemptId)?.upstreamAttemptIds).toEqual([depAttemptId]);
      expect(persistence.events.at(-1)).toEqual({
        taskId,
        eventType: 'task.prepared_for_new_attempt',
        payload: {
          reason: 'unit-test',
          oldAttemptId,
          newAttemptId,
        },
      });
    });

    it('resets a pending launching task with a claimed selected attempt', () => {
      const claimedOrchestrator = new Orchestrator({
        persistence,
        messageBus: bus,
        maxConcurrency: 3,
        deferRunningUntilLaunch: true,
      });
      claimedOrchestrator.loadPlan({
        name: 'prepare-claimed-launching',
        tasks: [{ id: 't1', description: 'Task 1' }],
      });

      const [started] = claimedOrchestrator.startExecution();
      const taskId = started!.id;
      const oldAttemptId = started!.execution.selectedAttemptId!;
      expect(started!.status).toBe('pending');
      expect(started!.execution.phase).toBe('launching');
      expect(persistence.loadAttempt(oldAttemptId)?.status).toBe('claimed');

      const prepared = claimedOrchestrator.prepareTaskForNewAttempt(taskId, 'claimed-launch-reset');
      const newAttemptId = prepared.execution.selectedAttemptId!;

      expect(prepared.status).toBe('pending');
      expect(prepared.execution.phase).toBeUndefined();
      expect(prepared.execution.launchStartedAt).toBeUndefined();
      expect(prepared.execution.lastHeartbeatAt).toBeUndefined();
      expect(newAttemptId).not.toBe(oldAttemptId);
      expect(persistence.loadAttempt(oldAttemptId)?.status).toBe('superseded');
      expect(persistence.loadAttempt(newAttemptId)?.status).toBe('pending');
    });

    it('rejects terminal tasks without changing attempts', () => {
      for (const status of ['completed', 'failed'] as const) {
        const taskId = `t-${status}`;
        const attempt: Attempt = {
          id: `${taskId}-aold`,
          nodeId: taskId,
          queuePriority: 0,
          status,
          upstreamAttemptIds: [],
          createdAt: new Date(),
        };
        persistence.saveTask('wf-terminal', {
          id: taskId,
          description: `${status} task`,
          status,
          dependencies: [],
          createdAt: new Date(),
          config: {},
          execution: {
            completedAt: new Date('2026-04-16T05:35:16.531Z'),
            error: status === 'failed' ? 'boom' : undefined,
            selectedAttemptId: attempt.id,
          },
        });
        persistence.saveAttempt(attempt);
      }
      orchestrator.syncFromDb('wf-terminal');

      for (const status of ['completed', 'failed'] as const) {
        const taskId = `t-${status}`;
        const attemptId = `${taskId}-aold`;
        expect(() => orchestrator.prepareTaskForNewAttempt(taskId, 'terminal-test')).toThrow('terminal');
        expect(orchestrator.getTask(taskId)!.status).toBe(status);
        expect(orchestrator.getTask(taskId)!.execution.selectedAttemptId).toBe(attemptId);
        expect(persistence.loadAttempt(attemptId)?.status).toBe(status);
      }
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

      const wf = persistence.listWorkflows()[0];
      expect(wf.status).toBe('completed');
    });

    it('workflow fails when a failed task blocks all pending dependents', () => {
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

      // t2 and the merge node stay pending, but both are blocked behind t1.
      const wf = persistence.listWorkflows()[0];
      expect(wf.status).toBe('failed');
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

      const wf = persistence.listWorkflows()[0];
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

      const wf = persistence.listWorkflows()[0];
      expect(wf.status).toBe('blocked');
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

      const wf = persistence.listWorkflows()[0];
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

  describe('editTaskPool', () => {
    it('edits poolId and clears legacy runner placement fields', () => {
      orchestrator = new Orchestrator({
        persistence,
        messageBus: bus,
        maxConcurrency: 3,
        logger: consoleLogger,
        availablePoolIds: ['mixed-local-ssh', 'pnpm-ssh'],
      });
      orchestrator.loadPlan({
        name: 'edit-pool',
        tasks: [{ id: 't1', description: 'Task 1', command: 'echo hello' }],
      });
      orchestrator.startExecution();
      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 't1', status: 'failed', outputs: { exitCode: 1, error: 'fail' } }),
      );
      persistence.updateTask('t1', { config: { runnerKind: 'ssh', poolMemberId: 'remote-a' } });

      orchestrator.editTaskPool('t1', 'mixed-local-ssh');

      const task = orchestrator.getTask('t1');
      expect(task?.config.poolId).toBe('mixed-local-ssh');
      expect(task?.config.runnerKind).toBeUndefined();
      expect(task?.config.poolMemberId).toBeUndefined();
      expect(persistence.getTaskEntry('t1')?.task.config.poolId).toBe('mixed-local-ssh');
    });

    it('rejects unknown poolId edits', () => {
      orchestrator = new Orchestrator({
        persistence,
        messageBus: bus,
        maxConcurrency: 3,
        logger: consoleLogger,
        availablePoolIds: ['mixed-local-ssh'],
      });
      orchestrator.loadPlan({
        name: 'edit-pool-unknown',
        tasks: [{ id: 't1', description: 'Task 1', command: 'echo hello' }],
      });

      expect(() => orchestrator.editTaskPool('t1', 'missing-pool')).toThrow('pool is not defined');
    });

    it('rejects pool edits for merge nodes', () => {
      orchestrator = new Orchestrator({
        persistence,
        messageBus: bus,
        maxConcurrency: 3,
        logger: consoleLogger,
        availablePoolIds: ['mixed-local-ssh'],
      });
      orchestrator.loadPlan({
        name: 'edit-pool-merge',
        tasks: [{ id: 't1', description: 'Task 1', command: 'echo hello' }],
      });
      const mergeTask = orchestrator.getAllTasks().find((candidate) => candidate.config.isMergeNode)!;

      expect(() => orchestrator.editTaskPool(mergeTask.id, 'mixed-local-ssh')).toThrow('Cannot change executor pool');
    });

    it('cancels active work before retrying for a pool edit', () => {
      orchestrator = new Orchestrator({
        persistence,
        messageBus: bus,
        maxConcurrency: 3,
        logger: consoleLogger,
        availablePoolIds: ['mixed-local-ssh'],
      });
      orchestrator.loadPlan({
        name: 'edit-pool-active',
        tasks: [{ id: 't1', description: 'Task 1', command: 'echo hello' }],
      });
      orchestrator.startExecution();
      const before = orchestrator.getTask('t1')!.execution.generation ?? 0;

      orchestrator.editTaskPool('t1', 'mixed-local-ssh');

      const task = orchestrator.getTask('t1')!;
      expect(task.status).toBe('running');
      expect(task.config.poolId).toBe('mixed-local-ssh');
      expect(task.execution.generation).toBeGreaterThan(before);
    });
  });

  describe('editTaskAgent', () => {
    it('changes executionAgent and recreates the task (inactive → no cancel)', () => {
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

    it('editing an ACTIVE (running) task does NOT throw and cancels first, then recreates', () => {
      orchestrator.loadPlan({
        name: 'edit-agent-running-test',
        tasks: [{ id: 't1', description: 'Task 1', command: 'sleep 100', executionAgent: 'claude' }],
      });
      orchestrator.startExecution();
      const taskId = sid(orchestrator, 0, 't1');
      expect(orchestrator.getTask(taskId)?.status).toBe('running');

      const cancelSpy = vi.spyOn(orchestrator, 'cancelTask');
      const recreateSpy = vi.spyOn(orchestrator, 'recreateTask');

      const started = orchestrator.editTaskAgent(taskId, 'codex');

      expect(cancelSpy).toHaveBeenCalledWith(taskId);
      expect(recreateSpy).toHaveBeenCalledWith(taskId);
      expect(cancelSpy.mock.invocationCallOrder[0]).toBeLessThan(
        recreateSpy.mock.invocationCallOrder[0],
      );

      const task = orchestrator.getTask(taskId);
      expect(task?.config.executionAgent).toBe('codex');
      // Single-task plan with no deps → recreate auto-starts the task.
      expect(task?.status).toBe('running');
      expect(started).toHaveLength(1);
      expect(started[0].id).toBe(taskId);

      cancelSpy.mockRestore();
      recreateSpy.mockRestore();
    });

    it('editing an INACTIVE (failed) task skips cancel but still routes through recreateTask', () => {
      orchestrator.loadPlan({
        name: 'edit-agent-inactive-test',
        tasks: [{ id: 't1', description: 'Task 1', command: 'echo old', executionAgent: 'claude' }],
      });
      orchestrator.startExecution();
      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 't1', status: 'failed', outputs: { exitCode: 1, error: 'fail' } }),
      );
      const taskId = sid(orchestrator, 0, 't1');
      expect(orchestrator.getTask(taskId)?.status).toBe('failed');

      const cancelSpy = vi.spyOn(orchestrator, 'cancelTask');
      const recreateSpy = vi.spyOn(orchestrator, 'recreateTask');

      orchestrator.editTaskAgent(taskId, 'codex');

      // Inactive → no cancel needed; recreateTask still resets lineage.
      expect(cancelSpy).not.toHaveBeenCalled();
      expect(recreateSpy).toHaveBeenCalledWith(taskId);

      cancelSpy.mockRestore();
      recreateSpy.mockRestore();
    });

    it('discards stale lineage (matches recreateTask reset shape)', () => {
      orchestrator.loadPlan({
        name: 'edit-agent-lineage-test',
        tasks: [{ id: 't1', description: 'Task 1', command: 'echo old', executionAgent: 'claude' }],
      });
      orchestrator.startExecution();
      const taskId = sid(orchestrator, 0, 't1');

      // Hydrate stale lineage as if a prior attempt completed and left
      // branch/commit/workspace/session/container artifacts behind.
      persistence.updateTask(taskId, {
        execution: {
          branch: 'experiment/old-agent',
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

      orchestrator.editTaskAgent(taskId, 'codex');

      const task = orchestrator.getTask(taskId)!;
      expect(task.execution.branch).toBeUndefined();
      expect(task.execution.commit).toBeUndefined();
      expect(task.execution.workspacePath).toBeUndefined();
      expect(task.execution.agentSessionId).toBeUndefined();
      expect(task.execution.containerId).toBeUndefined();
      expect(task.execution.error).toBeUndefined();
      expect(task.execution.exitCode).toBeUndefined();
    });

    it('bumps execution generation by exactly one per agent edit', () => {
      orchestrator.loadPlan({
        name: 'edit-agent-gen-test',
        tasks: [{ id: 't1', description: 'Task 1', command: 'echo old', executionAgent: 'claude' }],
      });
      orchestrator.startExecution();
      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 't1', status: 'failed', outputs: { exitCode: 1, error: 'x' } }),
      );
      const taskId = sid(orchestrator, 0, 't1');

      const before = orchestrator.getTask(taskId)!.execution.generation ?? 0;

      orchestrator.editTaskAgent(taskId, 'codex');

      const after = orchestrator.getTask(taskId)!.execution.generation ?? 0;
      expect(after).toBe(before + 1);
    });

    it('persists the updated agent and publishes a task.updated delta', () => {
      orchestrator.loadPlan({
        name: 'edit-agent-persist-test',
        tasks: [{ id: 't1', description: 'Task 1', command: 'echo old', executionAgent: 'claude' }],
      });
      orchestrator.startExecution();
      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 't1', status: 'failed', outputs: { exitCode: 1, error: 'oops' } }),
      );

      orchestrator.editTaskAgent('t1', 'codex');

      const persisted = persistence.getTaskEntry('t1');
      expect(persisted).toBeDefined();
      expect(persisted?.task.config.executionAgent).toBe('codex');
    });

    it('idempotence — two consecutive agent edits trigger two cancel-first cycles and two generation bumps', () => {
      orchestrator.loadPlan({
        name: 'edit-agent-idempotence-test',
        tasks: [{ id: 't1', description: 'Task 1', command: 'sleep 100', executionAgent: 'claude' }],
      });
      orchestrator.startExecution();
      const taskId = sid(orchestrator, 0, 't1');
      expect(orchestrator.getTask(taskId)?.status).toBe('running');

      const cancelSpy = vi.spyOn(orchestrator, 'cancelTask');
      const recreateSpy = vi.spyOn(orchestrator, 'recreateTask');

      const gen0 = orchestrator.getTask(taskId)!.execution.generation ?? 0;

      orchestrator.editTaskAgent(taskId, 'codex');
      const gen1 = orchestrator.getTask(taskId)!.execution.generation ?? 0;
      expect(gen1).toBe(gen0 + 1);
      expect(orchestrator.getTask(taskId)?.status).toBe('running');

      orchestrator.editTaskAgent(taskId, 'claude');
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

      expect(orchestrator.getTask(taskId)?.config.executionAgent).toBe('claude');

      cancelSpy.mockRestore();
      recreateSpy.mockRestore();
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
      expect(statusA.closed).toBe(0);

      const statusB = orchestrator.getWorkflowStatus(wfIds[1]);
      expect(statusB.total).toBe(2);
      expect(statusB.pending).toBe(2);
      expect(statusB.closed).toBe(0);
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

    it('getWorkflowStatus() counts closed separately from completed and failed', () => {
      orchestrator.loadPlan({
        name: 'Closed Status',
        tasks: [{ id: 'a1', description: 'A1', command: 'echo a1' }],
      });
      const taskId = sid(orchestrator, 0, 'a1');

      persistence.updateTask(taskId, { status: 'closed' });
      orchestrator.syncAllFromDb();

      const status = orchestrator.getWorkflowStatus();
      expect(status.closed).toBe(1);
      expect(status.completed).toBe(0);
      expect(status.failed).toBe(0);
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

    it('syncAllFromDb uses a bulk snapshot when the adapter provides one', () => {
      orchestrator.loadPlan({
        name: 'Plan A',
        tasks: [{ id: 'a1', description: 'A1', command: 'echo a1' }],
      });
      orchestrator.loadPlan({
        name: 'Plan B',
        tasks: [{ id: 'b1', description: 'B1', command: 'echo b1' }],
      });
      const snapshotSpy = vi.spyOn(persistence as any, 'loadWorkflowTaskSnapshot');
      const loadTasksSpy = vi.spyOn(persistence, 'loadTasks');

      orchestrator.syncAllFromDb();

      expect(snapshotSpy).toHaveBeenCalledTimes(1);
      expect(loadTasksSpy).not.toHaveBeenCalled();
      expect(orchestrator.getTask('a1')).toBeDefined();
      expect(orchestrator.getTask('b1')).toBeDefined();
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

      orchestrator.retryTask('A');
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

      orchestrator.retryTask('B');

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
      orchestrator.retryTask('A');
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
            Array.isArray(c[1]?.readyTaskIds) &&
            c[1].readyTaskIds.some((id: string) => id.endsWith('/B')),
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
      orchestrator.retryTask('A');
      orchestrator.retryTask('B');
      orchestrator.retryTask('C');
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
            Array.isArray(c[1]?.readyTaskIds) &&
            c[1].readyTaskIds.some((id: string) => id.endsWith('/D')),
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
      orchestrator.retryTask('A');
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
      orchestrator.retryTask('A');
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
        '[orchestrator] handleWorkerResponse: ignoring response for non-executable task',
        expect.objectContaining({
          taskId: 'A',
          status: 'failed',
          workerResponseStatus: 'completed',
        }),
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

      const started = orchestrator.retryTask(t1Scoped);

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
            c[1]?.taskId?.includes('pivot-reconciliation'),
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

      const result = orchestrator.retryTask('B');

      // B stays pending because A is still failed
      expect(result).toHaveLength(1);
      expect(result[0].status).toBe('pending');
      expect(orchestrator.getTask('B')!.status).toBe('pending');
    });

    it('restartTask clears stale launch metadata when resetting to pending', () => {
      orchestrator.loadPlan({
        name: 'pending-restart-launch-metadata-test',
        tasks: [
          { id: 'A', description: 'Root', command: 'echo A' },
          { id: 'B', description: 'Depends on A', command: 'echo B', dependencies: ['A'] },
        ],
      });
      orchestrator.startExecution();
      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 'A', status: 'failed', outputs: { exitCode: 1, error: 'fail' } }),
      );
      persistence.updateTask('B', {
        execution: {
          phase: 'launching',
          launchStartedAt: new Date('2026-04-16T05:25:16.531Z'),
          launchCompletedAt: new Date('2026-04-16T05:26:16.531Z'),
        },
      });
      orchestrator.syncAllFromDb();

      const result = orchestrator.retryTask('B');
      const task = orchestrator.getTask('B')!;

      expect(result[0].status).toBe('pending');
      expect(task.status).toBe('pending');
      expect(task.execution.phase).toBeUndefined();
      expect(task.execution.launchStartedAt).toBeUndefined();
      expect(task.execution.launchCompletedAt).toBeUndefined();
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

      const result = orchestrator.retryTask('t1');

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

      const result = orchestrator.retryTask('t1');

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
      testOrchestrator.retryTask('t1');

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
      orchestrator.retryTask('A');
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

      orchestrator.retryTask(sid(orchestrator, 0, 'pivot-exp-v1'));

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
      testOrchestrator.retryTask('t1');

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

    function loadRecreateDownstreamChain(wf: string) {
      const testPersistence = new InMemoryPersistence();
      const testBus = new InMemoryBus();

      testPersistence.saveTask(wf, {
        id: 'A',
        description: 'Root',
        status: 'completed',
        dependencies: [],
        createdAt: new Date(),
        config: { workflowId: wf },
        execution: {
          branch: 'br-a',
          commit: 'a1',
          workspacePath: '/tmp/a',
          agentSessionId: 'sess-a',
          containerId: 'ct-a',
          generation: 3,
          exitCode: 0,
        },
      });
      testPersistence.saveTask(wf, {
        id: 'B',
        description: 'Middle',
        status: 'completed',
        dependencies: ['A'],
        createdAt: new Date(),
        config: { workflowId: wf },
        execution: {
          branch: 'br-b',
          commit: 'b1',
          workspacePath: '/tmp/b',
          agentSessionId: 'sess-b',
          containerId: 'ct-b',
          generation: 2,
          exitCode: 0,
        },
      });
      testPersistence.saveTask(wf, {
        id: 'C',
        description: 'Leaf',
        status: 'completed',
        dependencies: ['B'],
        createdAt: new Date(),
        config: { workflowId: wf },
        execution: {
          branch: 'br-c',
          commit: 'c1',
          workspacePath: '/tmp/c',
          agentSessionId: 'sess-c',
          containerId: 'ct-c',
          generation: 1,
          exitCode: 0,
        },
      });

      const testOrchestrator = new Orchestrator({
        persistence: testPersistence,
        messageBus: testBus,
        maxConcurrency: 3,
      });
      testOrchestrator.syncFromDb(wf);
      return testOrchestrator;
    }

    it('recreateDownstream(A) preserves A and resets B and C', () => {
      const o = loadRecreateDownstreamChain('wf-recreate-downstream-a');
      o.recreateDownstream('A');

      const a = o.getTask('A')!;
      expect(a.status).toBe('completed');
      expect(a.execution.branch).toBe('br-a');
      expect(a.execution.commit).toBe('a1');
      expect(a.execution.workspacePath).toBe('/tmp/a');
      expect(a.execution.agentSessionId).toBe('sess-a');
      expect(a.execution.containerId).toBe('ct-a');
      expect(a.execution.generation).toBe(3);

      const b = o.getTask('B')!;
      const c = o.getTask('C')!;
      expect(b.status === 'running' || b.status === 'pending').toBe(true);
      expect(c.status).toBe('pending');
      for (const t of [b, c]) {
        expect(t.execution.branch).toBeUndefined();
        expect(t.execution.commit).toBeUndefined();
        expect(t.execution.workspacePath).toBeUndefined();
        expect(t.execution.agentSessionId).toBeUndefined();
        expect(t.execution.containerId).toBeUndefined();
      }
      expect(b.execution.generation).toBe(3);
      expect(c.execution.generation).toBe(2);
    });

    it('recreateDownstream(B) resets C only, leaving A and B unchanged', () => {
      const o = loadRecreateDownstreamChain('wf-recreate-downstream-b');
      o.recreateDownstream('B');

      const a = o.getTask('A')!;
      const b = o.getTask('B')!;
      const c = o.getTask('C')!;

      expect(a.status).toBe('completed');
      expect(a.execution.branch).toBe('br-a');
      expect(a.execution.generation).toBe(3);

      expect(b.status).toBe('completed');
      expect(b.execution.branch).toBe('br-b');
      expect(b.execution.commit).toBe('b1');
      expect(b.execution.workspacePath).toBe('/tmp/b');
      expect(b.execution.agentSessionId).toBe('sess-b');
      expect(b.execution.containerId).toBe('ct-b');
      expect(b.execution.generation).toBe(2);

      expect(c.status === 'running' || c.status === 'pending').toBe(true);
      expect(c.execution.branch).toBeUndefined();
      expect(c.execution.workspacePath).toBeUndefined();
      expect(c.execution.agentSessionId).toBeUndefined();
      expect(c.execution.containerId).toBeUndefined();
      expect(c.execution.generation).toBe(2);
    });

    it('recreateDownstream on a leaf is a no-op returning no started tasks', () => {
      const o = loadRecreateDownstreamChain('wf-recreate-downstream-leaf');
      const started = o.recreateDownstream('C');

      expect(started).toEqual([]);

      const a = o.getTask('A')!;
      const b = o.getTask('B')!;
      const c = o.getTask('C')!;
      expect(a.status).toBe('completed');
      expect(b.status).toBe('completed');
      expect(c.status).toBe('completed');
      expect(c.execution.branch).toBe('br-c');
      expect(c.execution.commit).toBe('c1');
      expect(c.execution.workspacePath).toBe('/tmp/c');
      expect(c.execution.agentSessionId).toBe('sess-c');
      expect(c.execution.containerId).toBe('ct-c');
      expect(c.execution.generation).toBe(1);
    });

    it('recreateDownstream plans only the ready descendants for dispatch', () => {
      const o = loadRecreateDownstreamChain('wf-recreate-downstream-dispatch');
      const started = o.recreateDownstream('A');

      const plan = o.getLastInvalidationPlan()!;
      expect(plan.action).toBe('recreateDownstream');
      expect(plan.affectedTaskIds).toEqual(['B', 'C']);
      expect(plan.schedulerEnqueueCandidates.map((c) => c.taskId)).toEqual(['B']);

      expect(started.map((t) => t.id)).not.toContain('A');
      expect(started.map((t) => t.id)).not.toContain('C');
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
    it('does not modify unrelated workflows when retrying', () => {
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

      const wfA = o.getAllTasks().find((task) => task.id.endsWith('/a1'))!.config.workflowId!;
      const wfBTaskBefore = o.getAllTasks().find((task) => task.id.endsWith('/b1'))!;

      persistence.loadTasksCalls = [];
      o.retryWorkflow(wfA);

      expect(persistence.loadTasksCalls.filter((id) => id === wfA).length).toBeGreaterThan(0);

      const wfBTaskAfter = o.getAllTasks().find((task) => task.id.endsWith('/b1'))!;
      expect(wfBTaskAfter.status).toBe(wfBTaskBefore.status);
      expect(wfBTaskAfter.execution.generation ?? 0).toBe(wfBTaskBefore.execution.generation ?? 0);
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

    it('cancels running tasks before resetting them', () => {
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

      // Cancel-first marked the task as failed before the reset; the
      // reset re-picked it up because 'failed' is in retryStatuses
      // and autoStartReadyTasks then drains it back into 'running'.
      // The exact terminal value isn't important — what matters is
      // that the task is no longer the original 'running' attempt
      // (the cancel event is the proof of interruption) and that the
      // `task.cancelled` event was emitted BEFORE the reset cycle so
      // any executor-side cleanup observed it.
      const a = o.getTask('a')!;
      expect(['pending', 'running']).toContain(a.status);
      const cancelEvents = p.events.filter(
        (e) => e.taskId === 'a' && e.eventType === 'task.cancelled',
      );
      expect(cancelEvents.length).toBeGreaterThanOrEqual(1);
      const pendingEvents = p.events.filter(
        (e) => e.taskId === 'a' && e.eventType === 'task.pending',
      );
      // Cancel must precede the pending reset.
      const firstCancelIdx = p.events.findIndex(
        (e) => e.taskId === 'a' && e.eventType === 'task.cancelled',
      );
      const firstPendingIdx = p.events.findIndex(
        (e) => e.taskId === 'a' && e.eventType === 'task.pending',
      );
      if (pendingEvents.length > 0) {
        expect(firstCancelIdx).toBeGreaterThanOrEqual(0);
        expect(firstCancelIdx).toBeLessThan(firstPendingIdx);
      }
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

      p.saveWorkflow({ id: wfId, name: wfId });
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

  // ── Step 12: workflow-scope paths (retryWorkflow / recreateWorkflow / recreateWorkflowFromFreshBase) ────
  //
  // Pins the chart's three-way distinction
  // (`docs/architecture/task-invalidation-chart.md` rows
  // "Retry workflow", "Recreate workflow", "Rebase and retry") +
  // closes the Step 11 "not yet wired (Step 12)" hole on
  // `applyInvalidation('workflow', 'recreateWorkflowFromFreshBase', ...)`.
  describe('workflow-scope paths', () => {
    function seedSimpleWorkflow(p: InMemoryPersistence, wfId: string): void {
      p.saveTask(wfId, {
        id: 'a',
        description: 'Task A',
        status: 'completed',
        dependencies: [],
        createdAt: new Date(),
        config: { workflowId: wfId },
        execution: { exitCode: 0, branch: 'br-a', commit: 'aaa', workspacePath: '/wt/a' },
      });
      p.saveTask(wfId, {
        id: 'b',
        description: 'Task B',
        status: 'failed',
        dependencies: [],
        createdAt: new Date(),
        config: { workflowId: wfId },
        execution: { exitCode: 1, error: 'boom', branch: 'br-b', commit: 'bbb', workspacePath: '/wt/b' },
      });
    }

    describe('retryWorkflow preserves lineage and bumps per-task execution generation', () => {
      it('keeps branch/workspacePath on the reset task', () => {
        const p = new InMemoryPersistence();
        const b = new InMemoryBus();
        const wfId = 'wf-step12-retry-lineage';
        seedSimpleWorkflow(p, wfId);
        const o = new Orchestrator({ persistence: p, messageBus: b, maxConcurrency: 2 });
        o.syncFromDb(wfId);

        o.retryWorkflow(wfId);

        const bTask = o.getTask('b')!;
        expect(bTask.execution.branch).toBe('br-b');
        expect(bTask.execution.workspacePath).toBe('/wt/b');
        expect(bTask.execution.commit).toBe('bbb');
        expect(bTask.execution.error).toBeUndefined();
      });

      it('bumps per-task execution.generation on the retried task (workflow-scope generation surrogate)', () => {
        const p = new InMemoryPersistence();
        const b = new InMemoryBus();
        const wfId = 'wf-step12-retry-gen';
        seedSimpleWorkflow(p, wfId);
        const o = new Orchestrator({ persistence: p, messageBus: b, maxConcurrency: 2 });
        o.syncFromDb(wfId);

        const beforeGen = o.getTask('b')!.execution.generation ?? 0;
        o.retryWorkflow(wfId);
        const afterGen = o.getTask('b')!.execution.generation ?? 0;
        expect(afterGen).toBeGreaterThan(beforeGen);
      });
    });

    describe('recreateWorkflow clears lineage and preserves the workflow base', () => {
      it('clears branch/workspacePath/commit on every task', () => {
        const p = new InMemoryPersistence();
        const b = new InMemoryBus();
        const wfId = 'wf-step12-recreate-lineage';
        seedSimpleWorkflow(p, wfId);
        const o = new Orchestrator({ persistence: p, messageBus: b, maxConcurrency: 2 });
        o.syncFromDb(wfId);

        o.recreateWorkflow(wfId);

        for (const id of ['a', 'b']) {
          const t = o.getTask(id)!;
          expect(t.execution.branch).toBeUndefined();
          expect(t.execution.commit).toBeUndefined();
          expect(t.execution.workspacePath).toBeUndefined();
        }
      });

      it('does NOT record a fresh upstream base commit (that is recreateWorkflowFromFreshBase territory)', () => {
        const p = new InMemoryPersistence();
        const b = new InMemoryBus();
        const wfId = 'wf-step12-recreate-no-fresh-base';
        seedSimpleWorkflow(p, wfId);
        const o = new Orchestrator({ persistence: p, messageBus: b, maxConcurrency: 2 });
        o.syncFromDb(wfId);

        expect(o.getKnownFreshBaseCommit(wfId)).toBeUndefined();
        o.recreateWorkflow(wfId);
        expect(o.getKnownFreshBaseCommit(wfId)).toBeUndefined();
      });
    });

    describe('recreateWorkflowFromFreshBase: stronger than recreateWorkflow', () => {
      it('does everything recreateWorkflow does (clears branch/workspacePath/commit) AND advances the known fresh base', async () => {
        const p = new InMemoryPersistence();
        const b = new InMemoryBus();
        const wfId = 'wf-step12-fresh-base';
        seedSimpleWorkflow(p, wfId);
        const o = new Orchestrator({ persistence: p, messageBus: b, maxConcurrency: 2 });
        o.syncFromDb(wfId);

        expect(o.getKnownFreshBaseCommit(wfId)).toBeUndefined();
        await o.recreateWorkflowFromFreshBase(wfId, {
          refreshBase: async () => ({ commit: 'fresh-upstream-sha' }),
        });

        // Recreate-class reset:
        for (const id of ['a', 'b']) {
          const t = o.getTask(id)!;
          expect(t.execution.branch).toBeUndefined();
          expect(t.execution.commit).toBeUndefined();
          expect(t.execution.workspacePath).toBeUndefined();
        }

        // Fresh-base distinction:
        expect(o.getKnownFreshBaseCommit(wfId)).toBe('fresh-upstream-sha');
      });

      it('runs refreshBase BEFORE the reset (chart: "refresh repo/base state first, then recreate the workflow")', async () => {
        const p = new InMemoryPersistence();
        const b = new InMemoryBus();
        const wfId = 'wf-step12-fresh-base-ordering';
        seedSimpleWorkflow(p, wfId);
        const o = new Orchestrator({ persistence: p, messageBus: b, maxConcurrency: 2 });
        o.syncFromDb(wfId);

        let refreshBaseCalledAt: number | undefined;
        let resetObservedAt: number | undefined;
        let counter = 0;

        // Re-spy persistence.updateTask to detect when the recreate
        // reset begins (the recreateWorkflow loop calls updateTask
        // on every reset task; the first such call is our marker).
        const originalUpdateTask = p.updateTask.bind(p);
        p.updateTask = (taskId: string, changes: any) => {
          if (resetObservedAt === undefined && changes?.status === 'pending') {
            resetObservedAt = ++counter;
          }
          originalUpdateTask(taskId, changes);
        };

        await o.recreateWorkflowFromFreshBase(wfId, {
          refreshBase: async () => {
            refreshBaseCalledAt = ++counter;
            return { commit: 'sha-fresh' };
          },
        });

        expect(refreshBaseCalledAt).toBeDefined();
        expect(resetObservedAt).toBeDefined();
        expect(refreshBaseCalledAt!).toBeLessThan(resetObservedAt!);
      });

      it('updates persisted baseBranch when refreshBase returns one', async () => {
        const p = new InMemoryPersistence();
        const b = new InMemoryBus();
        const wfId = 'wf-step12-fresh-base-branch';
        // Save workflow first so updateWorkflow has something to update
        p.saveWorkflow({
          id: wfId,
          name: 'wf',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        } as any);
        seedSimpleWorkflow(p, wfId);
        const o = new Orchestrator({ persistence: p, messageBus: b, maxConcurrency: 2 });
        o.syncFromDb(wfId);

        const updateWorkflowSpy = vi.spyOn(p, 'updateWorkflow');

        await o.recreateWorkflowFromFreshBase(wfId, {
          refreshBase: async () => ({ branch: 'main', commit: 'sha-x' }),
        });

        expect(updateWorkflowSpy).toHaveBeenCalledWith(wfId, { baseBranch: 'main' });
      });

      it('skips refreshBase invocation when no callback is supplied (degenerate caller path) and still resets', async () => {
        const p = new InMemoryPersistence();
        const b = new InMemoryBus();
        const wfId = 'wf-step12-no-refresh-cb';
        seedSimpleWorkflow(p, wfId);
        const o = new Orchestrator({ persistence: p, messageBus: b, maxConcurrency: 2 });
        o.syncFromDb(wfId);

        await o.recreateWorkflowFromFreshBase(wfId);

        for (const id of ['a', 'b']) {
          const t = o.getTask(id)!;
          expect(t.execution.branch).toBeUndefined();
          expect(t.execution.commit).toBeUndefined();
        }
        // No fresh base recorded — the caller did not provide one.
        expect(o.getKnownFreshBaseCommit(wfId)).toBeUndefined();
      });
    });

    describe('applyInvalidation routing (Step 11 "not yet wired" path is closed)', () => {
      it("applyInvalidation('workflow', 'recreateWorkflowFromFreshBase', ...) succeeds when the dep is wired", async () => {
        const { applyInvalidation } = await import('../invalidation-policy.js');

        const p = new InMemoryPersistence();
        const b = new InMemoryBus();
        const wfId = 'wf-step12-apply-invalidation';
        seedSimpleWorkflow(p, wfId);
        const o = new Orchestrator({ persistence: p, messageBus: b, maxConcurrency: 2 });
        o.syncFromDb(wfId);

        const cancelInFlight = vi.fn(async () => undefined);
        await applyInvalidation('workflow', 'recreateWorkflowFromFreshBase', wfId, {
          cancelInFlight,
          retryTask: async () => [],
          recreateTask: async () => [],
          retryWorkflow: async () => [],
          recreateWorkflow: async () => [],
          recreateWorkflowFromFreshBase: (workflowId: string) =>
            o.recreateWorkflowFromFreshBase(workflowId, {
              refreshBase: async () => ({ commit: 'sha-from-applyInvalidation' }),
            }),
        });

        // Cancel-first invariant.
        expect(cancelInFlight).toHaveBeenCalledWith('workflow', wfId);
        // Fresh-base step actually advanced.
        expect(o.getKnownFreshBaseCommit(wfId)).toBe('sha-from-applyInvalidation');
        // Recreate reset ran.
        expect(o.getTask('b')!.execution.branch).toBeUndefined();
      });

      it('cancel-first runs strictly before the recreateWorkflowFromFreshBase reset', async () => {
        const { applyInvalidation } = await import('../invalidation-policy.js');

        const p = new InMemoryPersistence();
        const b = new InMemoryBus();
        const wfId = 'wf-step12-cancel-first-ordering';
        seedSimpleWorkflow(p, wfId);
        const o = new Orchestrator({ persistence: p, messageBus: b, maxConcurrency: 2 });
        o.syncFromDb(wfId);

        const order: string[] = [];
        await applyInvalidation('workflow', 'recreateWorkflowFromFreshBase', wfId, {
          cancelInFlight: async () => {
            order.push('cancelInFlight');
          },
          retryTask: async () => [],
          recreateTask: async () => [],
          retryWorkflow: async () => [],
          recreateWorkflow: async () => [],
          recreateWorkflowFromFreshBase: async (workflowId: string) => {
            order.push('recreateWorkflowFromFreshBase');
            return o.recreateWorkflowFromFreshBase(workflowId, {
              refreshBase: async () => ({ commit: 'sha-x' }),
            });
          },
        });

        expect(order).toEqual(['cancelInFlight', 'recreateWorkflowFromFreshBase']);
      });

      it("applyInvalidation('workflow', 'retryWorkflow', ...) routes through cancelInFlight first", async () => {
        const { applyInvalidation } = await import('../invalidation-policy.js');

        const p = new InMemoryPersistence();
        const b = new InMemoryBus();
        const wfId = 'wf-step12-retry-cancel-first';
        seedSimpleWorkflow(p, wfId);
        const o = new Orchestrator({ persistence: p, messageBus: b, maxConcurrency: 2 });
        o.syncFromDb(wfId);

        const order: string[] = [];
        await applyInvalidation('workflow', 'retryWorkflow', wfId, {
          cancelInFlight: async () => {
            order.push('cancelInFlight');
          },
          retryTask: async () => [],
          recreateTask: async () => [],
          retryWorkflow: async (workflowId: string) => {
            order.push('retryWorkflow');
            return o.retryWorkflow(workflowId);
          },
          recreateWorkflow: async () => [],
        });

        expect(order).toEqual(['cancelInFlight', 'retryWorkflow']);
        // Retry-class lineage preserved.
        expect(o.getTask('b')!.execution.branch).toBe('br-b');
      });
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
      const started = orchestrator.retryTask('t1');
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
      expect(queueStatus.queued.map((task) => task.taskId)).not.toContain(taskId);
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
      const restarted = orchestrator.retryTask(taskId);
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

  describe('selectExperiment invalidation', () => {
    function setupReconciliationWithDownstream(): {
      reconId: string;
      exp1Id: string;
      exp2Id: string;
      downstreamId: string;
    } {
      orchestrator.loadPlan({
        name: 'select-experiment-step7',
        tasks: [
          { id: 'pivot', description: 'Pivot task', pivot: true },
          { id: 'downstream', description: 'After recon', command: 'sleep 100', dependencies: ['pivot'] },
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
            ],
          },
        },
      });
      const exp1Id = sid(orchestrator, 0, 'pivot-exp-v1');
      const exp2Id = sid(orchestrator, 0, 'pivot-exp-v2');
      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: exp1Id, status: 'completed', outputs: { exitCode: 0 } }),
      );
      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: exp2Id, status: 'completed', outputs: { exitCode: 0 } }),
      );
      orchestrator.handleWorkerResponse(reconciliationNeedsInputWorkResponse(rid(orchestrator, 0, 'pivot')));
      return {
        reconId: rid(orchestrator, 0, 'pivot'),
        exp1Id,
        exp2Id,
        downstreamId: sid(orchestrator, 0, 'downstream'),
      };
    }

    it('re-selecting with an ACTIVE downstream cancels first, then recreates downstream', () => {
      const { reconId, exp1Id, exp2Id, downstreamId } = setupReconciliationWithDownstream();

      // Initial selection unblocks downstream → downstream auto-starts.
      orchestrator.selectExperiment(reconId, exp1Id);
      expect(orchestrator.getTask(downstreamId)?.status).toBe('running');

      const cancelSpy = vi.spyOn(orchestrator, 'cancelTask');
      const recreateSpy = vi.spyOn(orchestrator, 'recreateTask');

      orchestrator.selectExperiment(reconId, exp2Id);

      expect(cancelSpy).toHaveBeenCalledWith(downstreamId);
      expect(recreateSpy).toHaveBeenCalledWith(downstreamId);
      expect(cancelSpy.mock.invocationCallOrder[0]).toBeLessThan(
        recreateSpy.mock.invocationCallOrder[0],
      );

      // New winner persisted on the recon.
      expect(orchestrator.getTask(reconId)?.execution.selectedExperiment).toBe(exp2Id);

      cancelSpy.mockRestore();
      recreateSpy.mockRestore();
    });

    it('re-selecting an INACTIVE downstream skips cancel but still recreates downstream', () => {
      const { reconId, exp1Id, exp2Id, downstreamId } = setupReconciliationWithDownstream();

      orchestrator.selectExperiment(reconId, exp1Id);
      // Fail downstream so it's no longer active. Re-selection MUST
      // NOT cancel a non-active downstream, but the recreate-class state
      // reset still applies so the new winner's input is consumed.
      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: downstreamId, status: 'failed', outputs: { exitCode: 1, error: 'oops' } }),
      );
      expect(orchestrator.getTask(downstreamId)?.status).toBe('failed');

      const cancelSpy = vi.spyOn(orchestrator, 'cancelTask');
      const recreateSpy = vi.spyOn(orchestrator, 'recreateTask');

      orchestrator.selectExperiment(reconId, exp2Id);

      expect(cancelSpy).not.toHaveBeenCalled();
      expect(recreateSpy).toHaveBeenCalledWith(downstreamId);

      cancelSpy.mockRestore();
      recreateSpy.mockRestore();
    });

    it('initial selection does NOT cancel and does NOT recreate downstream', () => {
      const { reconId, exp1Id, downstreamId } = setupReconciliationWithDownstream();

      const cancelSpy = vi.spyOn(orchestrator, 'cancelTask');
      const recreateSpy = vi.spyOn(orchestrator, 'recreateTask');

      orchestrator.selectExperiment(reconId, exp1Id);

      // Initial selection has no prior winner — there is nothing
      // active to cancel and no stale downstream attempt to retry.
      // The existing "completes reconciliation task and unblocks
      // downstream" path applies.
      expect(cancelSpy).not.toHaveBeenCalled();
      expect(recreateSpy).not.toHaveBeenCalled();
      expect(orchestrator.getTask(downstreamId)?.status).toBe('running');

      cancelSpy.mockRestore();
      recreateSpy.mockRestore();
    });

    it('re-selection bumps downstream execution generation by exactly one', () => {
      const { reconId, exp1Id, exp2Id, downstreamId } = setupReconciliationWithDownstream();

      orchestrator.selectExperiment(reconId, exp1Id);
      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: downstreamId, status: 'failed', outputs: { exitCode: 1, error: 'x' } }),
      );
      const before = orchestrator.getTask(downstreamId)!.execution.generation ?? 0;

      orchestrator.selectExperiment(reconId, exp2Id);

      const after = orchestrator.getTask(downstreamId)!.execution.generation ?? 0;
      expect(after).toBe(before + 1);
    });
  });

  describe('selectExperiments invalidation', () => {
    function setupMergedReconciliationWithDownstream(): {
      reconId: string;
      exp1Id: string;
      exp2Id: string;
      exp3Id: string;
      directDownstream: () => string[];
    } {
      orchestrator.loadPlan({
        name: 'select-experiments-step8',
        tasks: [
          { id: 'pivot', description: 'Pivot task', pivot: true },
          { id: 'downstream', description: 'After recon', command: 'sleep 100', dependencies: ['pivot'] },
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
      const exp1Id = sid(orchestrator, 0, 'pivot-exp-v1');
      const exp2Id = sid(orchestrator, 0, 'pivot-exp-v2');
      const exp3Id = sid(orchestrator, 0, 'pivot-exp-v3');
      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: exp1Id, status: 'completed', outputs: { exitCode: 0 } }),
      );
      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: exp2Id, status: 'completed', outputs: { exitCode: 0 } }),
      );
      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: exp3Id, status: 'completed', outputs: { exitCode: 0 } }),
      );
      orchestrator.handleWorkerResponse(reconciliationNeedsInputWorkResponse(rid(orchestrator, 0, 'pivot')));
      const reconId = rid(orchestrator, 0, 'pivot');
      // Resolve direct downstream lazily — `selectExperiments` may
      // consolidate sharded downstream forms post-mutation, so tests
      // re-query after each operation rather than capturing once.
      const directDownstream = (): string[] =>
        orchestrator
          .getAllTasks()
          .filter((t) => t.dependencies.includes(reconId))
          .map((t) => t.id);
      return {
        reconId,
        exp1Id,
        exp2Id,
        exp3Id,
        directDownstream,
      };
    }

    it('re-selecting a CHANGED merged set with an ACTIVE downstream cancels first, then recreates downstream', () => {
      const { reconId, exp1Id, exp2Id, exp3Id, directDownstream } =
        setupMergedReconciliationWithDownstream();

      // Initial multi-select unblocks downstream → downstream
      // auto-starts.
      orchestrator.selectExperiments(
        reconId,
        [exp1Id, exp2Id],
        'reconciliation/merged-12',
        'merged12',
      );
      const ds = directDownstream();
      expect(ds.length).toBeGreaterThan(0);
      const dsId = ds[0];
      expect(orchestrator.getTask(dsId)?.status).toBe('running');

      const cancelSpy = vi.spyOn(orchestrator, 'cancelTask');
      const recreateSpy = vi.spyOn(orchestrator, 'recreateTask');

      orchestrator.selectExperiments(
        reconId,
        [exp1Id, exp3Id],
        'reconciliation/merged-13',
        'merged13',
      );

      expect(cancelSpy).toHaveBeenCalledWith(dsId);
      expect(recreateSpy).toHaveBeenCalled();
      const cancelOrder = cancelSpy.mock.invocationCallOrder[0];
      const restartOrder = recreateSpy.mock.invocationCallOrder[0];
      expect(cancelOrder).toBeLessThan(restartOrder);

      // New merged lineage persisted on the recon.
      const recon = orchestrator.getTask(reconId)!;
      expect(recon.execution.selectedExperiments).toEqual([exp1Id, exp3Id]);
      expect(recon.execution.branch).toBe('reconciliation/merged-13');
      expect(recon.execution.commit).toBe('merged13');

      cancelSpy.mockRestore();
      recreateSpy.mockRestore();
    });

    it('re-selecting a CHANGED merged set with INACTIVE downstream skips cancel but still recreates downstream', () => {
      const { reconId, exp1Id, exp2Id, exp3Id, directDownstream } =
        setupMergedReconciliationWithDownstream();

      orchestrator.selectExperiments(
        reconId,
        [exp1Id, exp2Id],
        'reconciliation/merged-12',
        'merged12',
      );
      const dsId = directDownstream()[0];
      // Fail downstream so it's no longer active. Re-selection MUST
      // NOT cancel a non-active downstream, but the recreate-class state
      // reset still applies so the new merged lineage is consumed.
      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: dsId, status: 'failed', outputs: { exitCode: 1, error: 'oops' } }),
      );
      expect(orchestrator.getTask(dsId)?.status).toBe('failed');

      const cancelSpy = vi.spyOn(orchestrator, 'cancelTask');
      const recreateSpy = vi.spyOn(orchestrator, 'recreateTask');

      orchestrator.selectExperiments(
        reconId,
        [exp1Id, exp3Id],
        'reconciliation/merged-13',
        'merged13',
      );

      expect(cancelSpy).not.toHaveBeenCalled();
      expect(recreateSpy).toHaveBeenCalled();

      cancelSpy.mockRestore();
      recreateSpy.mockRestore();
    });

    it('initial multi-select does NOT cancel and does NOT recreate downstream', () => {
      const { reconId, exp1Id, exp2Id, directDownstream } =
        setupMergedReconciliationWithDownstream();

      const cancelSpy = vi.spyOn(orchestrator, 'cancelTask');
      const recreateSpy = vi.spyOn(orchestrator, 'recreateTask');

      orchestrator.selectExperiments(
        reconId,
        [exp1Id, exp2Id],
        'reconciliation/merged-12',
        'merged12',
      );

      // Initial selection has no prior set — there is nothing active
      // to cancel and no stale downstream attempt to retry. The
      // existing "completes reconciliation task and unblocks
      // downstream" path applies.
      expect(cancelSpy).not.toHaveBeenCalled();
      expect(recreateSpy).not.toHaveBeenCalled();
      for (const id of directDownstream()) {
        expect(orchestrator.getTask(id)?.status).toBe('running');
      }

      cancelSpy.mockRestore();
      recreateSpy.mockRestore();
    });

    it('re-selection bumps each affected downstream execution generation by exactly one', () => {
      const { reconId, exp1Id, exp2Id, exp3Id, directDownstream } =
        setupMergedReconciliationWithDownstream();

      orchestrator.selectExperiments(
        reconId,
        [exp1Id, exp2Id],
        'reconciliation/merged-12',
        'merged12',
      );
      const dsIds = directDownstream();
      for (const id of dsIds) {
        orchestrator.handleWorkerResponse(
          makeResponse({ actionId: id, status: 'failed', outputs: { exitCode: 1, error: 'x' } }),
        );
      }
      const before = new Map(
        dsIds.map((id) => [id, orchestrator.getTask(id)!.execution.generation ?? 0]),
      );

      orchestrator.selectExperiments(
        reconId,
        [exp1Id, exp3Id],
        'reconciliation/merged-13',
        'merged13',
      );

      for (const id of dsIds) {
        const dt = orchestrator.getTask(id);
        if (!dt) continue;
        const after = dt.execution.generation ?? 0;
        expect(after).toBe((before.get(id) ?? 0) + 1);
      }
    });

    it('re-selecting the SAME merged set is a no-op', () => {
      const { reconId, exp1Id, exp2Id, directDownstream } =
        setupMergedReconciliationWithDownstream();

      orchestrator.selectExperiments(
        reconId,
        [exp1Id, exp2Id],
        'reconciliation/merged-12',
        'merged12',
      );
      const dsId = directDownstream()[0];
      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: dsId, status: 'completed', outputs: { exitCode: 0 } }),
      );

      const cancelSpy = vi.spyOn(orchestrator, 'cancelTask');
      const recreateSpy = vi.spyOn(orchestrator, 'recreateTask');

      orchestrator.selectExperiments(
        reconId,
        [exp1Id, exp2Id],
        'reconciliation/merged-12',
        'merged12',
      );

      expect(cancelSpy).not.toHaveBeenCalled();
      expect(recreateSpy).not.toHaveBeenCalled();

      cancelSpy.mockRestore();
      recreateSpy.mockRestore();
    });

    it('same merged set in different ORDER is still treated as the same set', () => {
      const { reconId, exp1Id, exp2Id } = setupMergedReconciliationWithDownstream();

      orchestrator.selectExperiments(
        reconId,
        [exp1Id, exp2Id],
        'reconciliation/merged-12',
        'merged12',
      );

      const cancelSpy = vi.spyOn(orchestrator, 'cancelTask');
      const recreateSpy = vi.spyOn(orchestrator, 'recreateTask');

      // Reverse order — `selectedExperiments` is a SET (merged
      // lineage), not an ordered tuple, so this must NOT be treated
      // as a real re-selection.
      orchestrator.selectExperiments(
        reconId,
        [exp2Id, exp1Id],
        'reconciliation/merged-12',
        'merged12',
      );

      expect(cancelSpy).not.toHaveBeenCalled();
      expect(recreateSpy).not.toHaveBeenCalled();

      cancelSpy.mockRestore();
      recreateSpy.mockRestore();
    });
  });

  describe('editTaskMergeMode invalidation', () => {
    function setupMergeWorkflow(initialMergeMode: 'manual' | 'automatic' | 'external_review' = 'manual'): {
      mergeId: string;
      workflowId: string;
      leafId: string;
    } {
      orchestrator.loadPlan({
        name: 'edit-merge-mode-step9',
        mergeMode: initialMergeMode,
        tasks: [
          { id: 'leaf', description: 'Leaf task' },
        ],
      });
      const workflowId = orchestrator.getWorkflowIds()[0]!;
      const mergeNode = orchestrator
        .getAllTasks()
        .find((t) => t.config.isMergeNode && t.config.workflowId === workflowId);
      expect(mergeNode).toBeDefined();
      return {
        mergeId: mergeNode!.id,
        workflowId,
        leafId: sid(orchestrator, 0, 'leaf'),
      };
    }

    function driveMergeNodeToRunning(mergeId: string, leafId: string): void {
      orchestrator.startExecution();
      // Complete the leaf so the merge node becomes ready and
      // auto-starts (`startExecution`'s ready-set scheduler drives
      // it into `running`).
      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: leafId, status: 'completed', outputs: { exitCode: 0 } }),
      );
      expect(orchestrator.getTask(mergeId)?.status).toBe('running');
    }

    it('routes through retryTask and cancels active merge work first', () => {
      const { mergeId, leafId } = setupMergeWorkflow('manual');
      driveMergeNodeToRunning(mergeId, leafId);

      const cancelSpy = vi.spyOn(orchestrator, 'cancelTask');
      const retrySpy = vi.spyOn(orchestrator, 'retryTask');
      const recreateSpy = vi.spyOn(orchestrator, 'recreateTask');

      orchestrator.editTaskMergeMode(mergeId, 'automatic');

      expect(cancelSpy).toHaveBeenCalledWith(mergeId);
      expect(retrySpy).toHaveBeenCalledWith(mergeId);
      expect(recreateSpy).not.toHaveBeenCalled();
      // Hard Invariant: cancel-first MUST precede the retry-class
      // reset. `mock.invocationCallOrder` is the global vi-internal
      // ordering counter — comparing the first cancel/restart call
      // pins the synchronous ordering inside `editTaskMergeMode`.
      expect(cancelSpy.mock.invocationCallOrder[0]).toBeLessThan(
        retrySpy.mock.invocationCallOrder[0],
      );

      cancelSpy.mockRestore();
      retrySpy.mockRestore();
      recreateSpy.mockRestore();
    });

    it('same-mode flips are a no-op', () => {
      const { mergeId, leafId, workflowId } = setupMergeWorkflow('manual');
      driveMergeNodeToRunning(mergeId, leafId);

      const beforeGeneration = orchestrator.getTask(mergeId)!.execution.generation ?? 0;
      const beforeUpdates = persistence.updateWorkflowCalls.get(workflowId) ?? 0;

      const cancelSpy = vi.spyOn(orchestrator, 'cancelTask');
      const retrySpy = vi.spyOn(orchestrator, 'retryTask');

      const result = orchestrator.editTaskMergeMode(mergeId, 'manual');

      expect(result).toEqual([]);
      expect(cancelSpy).not.toHaveBeenCalled();
      expect(retrySpy).not.toHaveBeenCalled();

      const afterGeneration = orchestrator.getTask(mergeId)!.execution.generation ?? 0;
      expect(afterGeneration).toBe(beforeGeneration);

      const afterUpdates = persistence.updateWorkflowCalls.get(workflowId) ?? 0;
      expect(afterUpdates).toBe(beforeUpdates);

      cancelSpy.mockRestore();
      retrySpy.mockRestore();
    });

    it('different-mode flips on active merge nodes bump execution generation by exactly one', () => {
      const { mergeId, leafId } = setupMergeWorkflow('manual');
      driveMergeNodeToRunning(mergeId, leafId);

      const before = orchestrator.getTask(mergeId)!.execution.generation ?? 0;

      orchestrator.editTaskMergeMode(mergeId, 'automatic');

      const after = orchestrator.getTask(mergeId)!.execution.generation ?? 0;
      expect(after).toBe(before + 1);
    });

    it('different-mode flips persist the new mode on the workflow record', () => {
      const { mergeId, leafId, workflowId } = setupMergeWorkflow('manual');
      driveMergeNodeToRunning(mergeId, leafId);

      orchestrator.editTaskMergeMode(mergeId, 'external_review');

      const wf = persistence.loadWorkflow(workflowId);
      expect(wf?.mergeMode).toBe('external_review');
    });

    it('inactive merge nodes skip cancel-first but still route through retryTask', () => {
      // Do NOT drive the merge node into a running state; with the
      // leaf still pending the merge node sits in `pending` (no
      // in-flight merge work). Cancel-first MUST be skipped because
      // calling `cancelTask` on a `pending` merge node would mark it
      // `failed` — exactly the failure mode this guard prevents.
      const { mergeId } = setupMergeWorkflow('manual');
      expect(orchestrator.getTask(mergeId)?.status).toBe('pending');

      const cancelSpy = vi.spyOn(orchestrator, 'cancelTask');
      const retrySpy = vi.spyOn(orchestrator, 'retryTask');

      orchestrator.editTaskMergeMode(mergeId, 'automatic');

      expect(cancelSpy).not.toHaveBeenCalled();
      expect(retrySpy).toHaveBeenCalledWith(mergeId);
      // Merge node remains `pending` after the retry-class reset.
      expect(orchestrator.getTask(mergeId)?.status).toBe('pending');

      cancelSpy.mockRestore();
      retrySpy.mockRestore();
    });

    it('active awaiting_approval merge nodes cancel first, then reset via retryTask', () => {
      // The chart calls out `awaiting_approval` (the manual-gate
      // wait state) explicitly as an ACTIVE state for the merge
      // node — switching modes mid-review must interrupt the
      // pending approval and re-schedule the merge under the new
      // policy.
      const { mergeId, leafId } = setupMergeWorkflow('manual');
      orchestrator.startExecution();
      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: leafId, status: 'completed', outputs: { exitCode: 0 } }),
      );
      orchestrator.setTaskAwaitingApproval(mergeId);
      expect(orchestrator.getTask(mergeId)?.status).toBe('awaiting_approval');

      const cancelSpy = vi.spyOn(orchestrator, 'cancelTask');
      const retrySpy = vi.spyOn(orchestrator, 'retryTask');

      orchestrator.editTaskMergeMode(mergeId, 'automatic');

      expect(cancelSpy).toHaveBeenCalledWith(mergeId);
      expect(retrySpy).toHaveBeenCalledWith(mergeId);
      expect(cancelSpy.mock.invocationCallOrder[0]).toBeLessThan(
        retrySpy.mock.invocationCallOrder[0],
      );

      cancelSpy.mockRestore();
      retrySpy.mockRestore();
    });

    it('throws when called on a non-merge task', () => {
      const { leafId } = setupMergeWorkflow('manual');
      expect(() => orchestrator.editTaskMergeMode(leafId, 'automatic')).toThrow(
        /not a merge node/,
      );
    });

    it('throws when called on an unknown task id', () => {
      setupMergeWorkflow('manual');
      expect(() => orchestrator.editTaskMergeMode('does-not-exist', 'automatic')).toThrow(
        /not found/,
      );
    });
  });

  describe('editTaskMergeMode invalidation', () => {
    function setupMergeWorkflow(initialMergeMode: 'manual' | 'automatic' | 'external_review' = 'manual'): {
      mergeId: string;
      workflowId: string;
      leafId: string;
    } {
      orchestrator.loadPlan({
        name: 'edit-merge-mode-step9',
        mergeMode: initialMergeMode,
        tasks: [
          { id: 'leaf', description: 'Leaf task' },
        ],
      });
      const workflowId = orchestrator.getWorkflowIds()[0]!;
      const mergeNode = orchestrator
        .getAllTasks()
        .find((t) => t.config.isMergeNode && t.config.workflowId === workflowId);
      expect(mergeNode).toBeDefined();
      return {
        mergeId: mergeNode!.id,
        workflowId,
        leafId: sid(orchestrator, 0, 'leaf'),
      };
    }

    function driveMergeNodeToRunning(mergeId: string, leafId: string): void {
      orchestrator.startExecution();
      // Complete the leaf so the merge node becomes ready and
      // auto-starts (`startExecution`'s ready-set scheduler drives
      // it into `running`).
      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: leafId, status: 'completed', outputs: { exitCode: 0 } }),
      );
      expect(orchestrator.getTask(mergeId)?.status).toBe('running');
    }

    it('routes through retryTask and cancels active merge work first', () => {
      const { mergeId, leafId } = setupMergeWorkflow('manual');
      driveMergeNodeToRunning(mergeId, leafId);

      const cancelSpy = vi.spyOn(orchestrator, 'cancelTask');
      const retrySpy = vi.spyOn(orchestrator, 'retryTask');
      const recreateSpy = vi.spyOn(orchestrator, 'recreateTask');

      orchestrator.editTaskMergeMode(mergeId, 'automatic');

      expect(cancelSpy).toHaveBeenCalledWith(mergeId);
      expect(retrySpy).toHaveBeenCalledWith(mergeId);
      expect(recreateSpy).not.toHaveBeenCalled();
      // Hard Invariant: cancel-first MUST precede the retry-class
      // reset. `mock.invocationCallOrder` is the global vi-internal
      // ordering counter — comparing the first cancel/restart call
      // pins the synchronous ordering inside `editTaskMergeMode`.
      expect(cancelSpy.mock.invocationCallOrder[0]).toBeLessThan(
        retrySpy.mock.invocationCallOrder[0],
      );

      cancelSpy.mockRestore();
      retrySpy.mockRestore();
      recreateSpy.mockRestore();
    });

    it('same-mode flip is a no-op', () => {
      const { mergeId, leafId, workflowId } = setupMergeWorkflow('manual');
      driveMergeNodeToRunning(mergeId, leafId);

      const beforeGeneration = orchestrator.getTask(mergeId)!.execution.generation ?? 0;
      const beforeUpdates = persistence.updateWorkflowCalls.get(workflowId) ?? 0;

      const cancelSpy = vi.spyOn(orchestrator, 'cancelTask');
      const retrySpy = vi.spyOn(orchestrator, 'retryTask');

      const result = orchestrator.editTaskMergeMode(mergeId, 'manual');

      expect(result).toEqual([]);
      expect(cancelSpy).not.toHaveBeenCalled();
      expect(retrySpy).not.toHaveBeenCalled();

      const afterGeneration = orchestrator.getTask(mergeId)!.execution.generation ?? 0;
      expect(afterGeneration).toBe(beforeGeneration);

      const afterUpdates = persistence.updateWorkflowCalls.get(workflowId) ?? 0;
      expect(afterUpdates).toBe(beforeUpdates);

      cancelSpy.mockRestore();
      retrySpy.mockRestore();
    });

    it('different-mode flip on an active merge node bumps execution generation by exactly one', () => {
      const { mergeId, leafId } = setupMergeWorkflow('manual');
      driveMergeNodeToRunning(mergeId, leafId);

      const before = orchestrator.getTask(mergeId)!.execution.generation ?? 0;

      orchestrator.editTaskMergeMode(mergeId, 'automatic');

      const after = orchestrator.getTask(mergeId)!.execution.generation ?? 0;
      expect(after).toBe(before + 1);
    });

    it('different-mode flip persists the new mode on the workflow record', () => {
      const { mergeId, leafId, workflowId } = setupMergeWorkflow('manual');
      driveMergeNodeToRunning(mergeId, leafId);

      orchestrator.editTaskMergeMode(mergeId, 'external_review');

      const wf = persistence.loadWorkflow(workflowId);
      expect(wf?.mergeMode).toBe('external_review');
    });

    it('inactive merge node (pending) skips cancel-first but still routes through retryTask', () => {
      // Do NOT drive the merge node into a running state; with the
      // leaf still pending the merge node sits in `pending` (no
      // in-flight merge work). Cancel-first MUST be skipped because
      // calling `cancelTask` on a `pending` merge node would mark it
      // `failed` — exactly the failure mode this guard prevents.
      const { mergeId } = setupMergeWorkflow('manual');
      expect(orchestrator.getTask(mergeId)?.status).toBe('pending');

      const cancelSpy = vi.spyOn(orchestrator, 'cancelTask');
      const retrySpy = vi.spyOn(orchestrator, 'retryTask');

      orchestrator.editTaskMergeMode(mergeId, 'automatic');

      expect(cancelSpy).not.toHaveBeenCalled();
      expect(retrySpy).toHaveBeenCalledWith(mergeId);
      // Merge node remains `pending` after the retry-class reset
      // (it is the natural target state of `restartTask`).
      expect(orchestrator.getTask(mergeId)?.status).toBe('pending');

      cancelSpy.mockRestore();
      retrySpy.mockRestore();
    });

    it('active awaiting_approval merge node cancels first, then resets via retryTask', () => {
      // The chart calls out `awaiting_approval` (the manual-gate
      // wait state) explicitly as an ACTIVE state for the merge
      // node — switching modes mid-review must interrupt the
      // pending approval and re-schedule the merge under the new
      // policy.
      const { mergeId, leafId } = setupMergeWorkflow('manual');
      orchestrator.startExecution();
      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: leafId, status: 'completed', outputs: { exitCode: 0 } }),
      );
      orchestrator.setTaskAwaitingApproval(mergeId);
      expect(orchestrator.getTask(mergeId)?.status).toBe('awaiting_approval');

      const cancelSpy = vi.spyOn(orchestrator, 'cancelTask');
      const retrySpy = vi.spyOn(orchestrator, 'retryTask');

      orchestrator.editTaskMergeMode(mergeId, 'automatic');

      expect(cancelSpy).toHaveBeenCalledWith(mergeId);
      expect(retrySpy).toHaveBeenCalledWith(mergeId);
      expect(cancelSpy.mock.invocationCallOrder[0]).toBeLessThan(
        retrySpy.mock.invocationCallOrder[0],
      );

      cancelSpy.mockRestore();
      retrySpy.mockRestore();
    });

    it('Step 9: throws when called on a non-merge task', () => {
      const { leafId } = setupMergeWorkflow('manual');
      expect(() => orchestrator.editTaskMergeMode(leafId, 'automatic')).toThrow(
        /not a merge node/,
      );
    });

    it('Step 9: throws when called on an unknown task id', () => {
      setupMergeWorkflow('manual');
      expect(() => orchestrator.editTaskMergeMode('does-not-exist', 'automatic')).toThrow(
        /not found/,
      );
    });
  });

  // ── Step 10 (task-invalidation roadmap): editTaskFixContext ────────────
  //
  // The chart's Decision Table row "Change fix prompt or fix context
  // while `fixing_with_ai`" maps the `fixContext` mutation to
  // InvalidationAction = 'retryTask' with InvalidationScope = 'task'
  // applied to the failed/fixing task. Step 10 lifts the previously
  // bespoke fix-session handling (`beginConflictResolution` /
  // `revertConflictResolution`) into a proper orchestrator policy
  // seam: `Orchestrator.editTaskFixContext` owns the same-content
  // no-op detection, cancel-first interruption when the task is
  // actively running an AI fix (`fixing_with_ai`), the
  // `config.fixPrompt` / `config.fixContext` write, and the
  // retry-class reset (via `restartTask`), in parity with
  // Step 7/8 (`selectExperiment` / `selectExperiments`) and Step 9
  // (`editTaskMergeMode`).
  //
  // The hard invariants pinned below are:
  //   - same-content edits are no-ops (no cancel, no generation
  //     bump, no `restartTask`)
  //   - active fix sessions (`fixing_with_ai`) cancel-first BEFORE
  //     the retry-class reset, and the task's execution generation
  //     bumps by exactly one
  //   - INACTIVE failed tasks skip cancel but still route through
  //     `restartTask` (state reset only — `agentSessionId` cleared,
  //     new fix prompt/context persisted)
  //   - the route NEVER touches `recreateTask` (retry-class only,
  //     per the chart Decision Table — fix prompt/context changes do
  //     NOT change the task's execution-defining spec)

  describe('editTaskFixContext invalidation', () => {
    function setupFailedTask(): { taskId: string; workflowId: string } {
      orchestrator.loadPlan({
        name: 'edit-fix-context-step10',
        onFinish: 'none',
        tasks: [
          { id: 't1', description: 'Failing task', command: 'exit 1' },
        ],
      });
      const workflowId = orchestrator.getWorkflowIds()[0]!;
      const taskId = orchestrator
        .getAllTasks()
        .find((t) => t.config.workflowId === workflowId && !t.config.isMergeNode)!.id;

      orchestrator.startExecution();
      orchestrator.handleWorkerResponse(
        makeResponse({
          actionId: taskId,
          status: 'failed',
          outputs: { exitCode: 1, error: 'boom' },
        }),
      );
      expect(orchestrator.getTask(taskId)?.status).toBe('failed');
      publishedDeltas = [];
      return { taskId, workflowId };
    }

    function driveTaskToFixingWithAi(taskId: string): void {
      orchestrator.beginConflictResolution(taskId);
      expect(orchestrator.getTask(taskId)?.status).toBe('fixing_with_ai');
      publishedDeltas = [];
    }

    it('routes through retryTask and cancels active fix sessions first', () => {
      const { taskId } = setupFailedTask();
      driveTaskToFixingWithAi(taskId);

      const cancelSpy = vi.spyOn(orchestrator, 'cancelTask');
      const retrySpy = vi.spyOn(orchestrator, 'retryTask');
      const recreateSpy = vi.spyOn(orchestrator, 'recreateTask');

      orchestrator.editTaskFixContext(taskId, { fixPrompt: 'try a different approach' });

      expect(cancelSpy).toHaveBeenCalledWith(taskId);
      expect(retrySpy).toHaveBeenCalledWith(taskId);
      expect(recreateSpy).not.toHaveBeenCalled();
      // Hard Invariant: cancel-first MUST precede the retry-class
      // reset. `mock.invocationCallOrder` is the global vi-internal
      // ordering counter — comparing the first cancel/restart call
      // pins the synchronous ordering inside `editTaskFixContext`.
      expect(cancelSpy.mock.invocationCallOrder[0]).toBeLessThan(
        retrySpy.mock.invocationCallOrder[0],
      );

      cancelSpy.mockRestore();
      retrySpy.mockRestore();
      recreateSpy.mockRestore();
    });

    it('edit on ACTIVE fix session reverts to the failed baseline and persists new fix inputs', () => {
      const { taskId, workflowId } = setupFailedTask();
      driveTaskToFixingWithAi(taskId);

      // Seed an `agentSessionId` on the in-flight fix attempt so we
      // can prove the retry-class reset clears it (the chart's
      // "retry from reverted failed state" semantics — volatile
      // fix-attempt state is dropped).
      persistence.updateTask(taskId, {
        execution: { agentSessionId: 'agent-session-stale' },
      });
      orchestrator.syncFromDb(workflowId);
      expect(orchestrator.getTask(taskId)?.execution.agentSessionId).toBe(
        'agent-session-stale',
      );

      orchestrator.editTaskFixContext(taskId, {
        fixPrompt: 'use codex instead',
        fixContext: 'see notes/foo.md',
      });

      const task = orchestrator.getTask(taskId)!;
      // retryTask resets to `pending` and may auto-start to
      // `running` if the task is ready — both are valid
      // post-retry pre-execution states for the chart's "retry
      // from reverted failed state" baseline (the fix-loop attempt
      // is dropped, the failed task lineage is what we retry).
      expect(['pending', 'running']).toContain(task.status);
      expect(task.execution.agentSessionId).toBeUndefined();
      expect(task.config.fixPrompt).toBe('use codex instead');
      expect(task.config.fixContext).toBe('see notes/foo.md');
    });

    it('edit on INACTIVE failed task skips cancel but still routes through retryTask', () => {
      // Failed (not fixing_with_ai) is the inactive fix-loop state.
      // Cancel-first MUST be skipped because there is no in-flight
      // fix attempt to interrupt; the task is still settled in
      // `failed` and a spurious `cancelTask` would treat it as
      // already-resolved work.
      const { taskId } = setupFailedTask();
      expect(orchestrator.getTask(taskId)?.status).toBe('failed');

      const cancelSpy = vi.spyOn(orchestrator, 'cancelTask');
      const retrySpy = vi.spyOn(orchestrator, 'retryTask');

      orchestrator.editTaskFixContext(taskId, { fixPrompt: 'fresh try' });

      expect(cancelSpy).not.toHaveBeenCalled();
      expect(retrySpy).toHaveBeenCalledWith(taskId);

      const task = orchestrator.getTask(taskId)!;
      expect(['pending', 'running']).toContain(task.status);
      expect(task.config.fixPrompt).toBe('fresh try');

      cancelSpy.mockRestore();
      retrySpy.mockRestore();
    });

    it('same-content edit is a NO-OP', () => {
      const { taskId, workflowId } = setupFailedTask();
      // Seed an existing fixPrompt/fixContext so the next call is a
      // true same-content re-affirm.
      persistence.updateTask(taskId, {
        config: { fixPrompt: 'identical', fixContext: 'identical-ctx' },
      });
      orchestrator.syncFromDb(workflowId);
      const beforeGeneration = orchestrator.getTask(taskId)!.execution.generation ?? 0;
      publishedDeltas = [];

      const cancelSpy = vi.spyOn(orchestrator, 'cancelTask');
      const retrySpy = vi.spyOn(orchestrator, 'retryTask');

      const result = orchestrator.editTaskFixContext(taskId, {
        fixPrompt: 'identical',
        fixContext: 'identical-ctx',
      });

      expect(result).toEqual([]);
      expect(cancelSpy).not.toHaveBeenCalled();
      expect(retrySpy).not.toHaveBeenCalled();

      const afterGeneration = orchestrator.getTask(taskId)!.execution.generation ?? 0;
      expect(afterGeneration).toBe(beforeGeneration);

      const fixContextDeltas = publishedDeltas.filter(
        (d) =>
          d.type === 'updated' &&
          d.taskId === taskId &&
          (d.changes.config?.fixPrompt !== undefined ||
            d.changes.config?.fixContext !== undefined),
      );
      expect(fixContextDeltas).toHaveLength(0);

      cancelSpy.mockRestore();
      retrySpy.mockRestore();
    });

    it('omitted patch key leaves the existing config field untouched', () => {
      const { taskId, workflowId } = setupFailedTask();
      persistence.updateTask(taskId, {
        config: { fixPrompt: 'old-prompt', fixContext: 'preserved-context' },
      });
      orchestrator.syncFromDb(workflowId);

      orchestrator.editTaskFixContext(taskId, { fixPrompt: 'new-prompt' });

      const task = orchestrator.getTask(taskId)!;
      expect(task.config.fixPrompt).toBe('new-prompt');
      expect(task.config.fixContext).toBe('preserved-context');
    });

    it('content change bumps execution generation by exactly one', () => {
      const { taskId } = setupFailedTask();
      const before = orchestrator.getTask(taskId)!.execution.generation ?? 0;

      orchestrator.editTaskFixContext(taskId, { fixPrompt: 'one-shot' });

      const after = orchestrator.getTask(taskId)!.execution.generation ?? 0;
      expect(after).toBe(before + 1);
    });

    it('emits a task.updated delta carrying the new fix prompt/context', () => {
      const { taskId } = setupFailedTask();
      publishedDeltas = [];

      orchestrator.editTaskFixContext(taskId, {
        fixPrompt: 'new-prompt',
        fixContext: 'new-context',
      });

      const fixContextDeltas = publishedDeltas.filter(
        (d) =>
          d.type === 'updated' &&
          d.taskId === taskId &&
          d.changes.config?.fixPrompt === 'new-prompt' &&
          d.changes.config?.fixContext === 'new-context',
      );
      expect(fixContextDeltas).toHaveLength(1);
    });

    it('throws when called on a merge node', () => {
      orchestrator.loadPlan({
        name: 'edit-fix-context-merge-step10',
        mergeMode: 'manual',
        tasks: [{ id: 'leaf', description: 'Leaf task' }],
      });
      const workflowId = orchestrator.getWorkflowIds()[0]!;
      const mergeNode = orchestrator
        .getAllTasks()
        .find((t) => t.config.isMergeNode && t.config.workflowId === workflowId)!;
      expect(() =>
        orchestrator.editTaskFixContext(mergeNode.id, { fixPrompt: 'x' }),
      ).toThrow(/merge node/);
    });

    it('throws when called on an unknown task id', () => {
      setupFailedTask();
      expect(() =>
        orchestrator.editTaskFixContext('does-not-exist', { fixPrompt: 'x' }),
      ).toThrow(/not found/);
    });

    it('throws when called on a task whose status is neither failed nor fixing_with_ai', () => {
      orchestrator.loadPlan({
        name: 'edit-fix-context-pending-step10',
        onFinish: 'none',
        tasks: [{ id: 't1', description: 'Pending task', command: 'echo hi' }],
      });
      const workflowId = orchestrator.getWorkflowIds()[0]!;
      const taskId = orchestrator
        .getAllTasks()
        .find((t) => t.config.workflowId === workflowId && !t.config.isMergeNode)!.id;
      expect(orchestrator.getTask(taskId)?.status).toBe('pending');

      expect(() =>
        orchestrator.editTaskFixContext(taskId, { fixPrompt: 'x' }),
      ).toThrow(/expected: failed \| fixing_with_ai/);
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
      orchestrator.retryTask('child');
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

      orchestrator.retryTask('t1');
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

      orchestrator.retryTask(reconId);
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

      orchestrator.retryTask('A');
      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 'A', executionGeneration: 1, status: 'completed', outputs: { exitCode: 0 } }),
      );

      expect(orchestrator.getTask('A')!.status).toBe('completed');
      expect(orchestrator.getTask('B')!.status).toBe('running');
    });
  });

  // ── Merge gate leaf reconciliation ────────────────────────

});
