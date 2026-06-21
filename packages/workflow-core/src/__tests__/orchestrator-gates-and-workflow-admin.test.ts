import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { reconciliationNeedsInputWorkResponse } from './reconciliation-needs-input-shim.js';
import { rid, sid } from './scoped-test-helpers.js';
import { Orchestrator, PlanConflictError, descriptionForMergeNode } from '../orchestrator.js';
import type { PlanDefinition, OrchestratorPersistence, OrchestratorMessageBus } from '../orchestrator.js';
import { computeWorkflowRollup } from '../task-types.js';
import type { TaskState, TaskDelta, TaskStateChanges, Attempt, ExternalDependency, ExternalDependencyChange, DetachedExternalDependency } from '../task-types.js';
import type { Logger, WorkResponse } from '@invoker/contracts';

// ── In-Memory Persistence Mock ──────────────────────────────

class InMemoryPersistence implements OrchestratorPersistence {
  workflows = new Map<string, {
    id: string;
    name: string;
    status: string;
    createdAt: string;
    updatedAt: string;
    repoUrl?: string;
    baseBranch?: string;
    featureBranch?: string;
    mergeMode?: 'manual' | 'automatic' | 'external_review';
    externalDependencies?: ExternalDependency[];
    externalDependencyChanges?: ExternalDependencyChange[];
    detachedExternalDependencies?: DetachedExternalDependency[];
  }>();
  tasks = new Map<string, { workflowId: string; task: TaskState }>();
  private attempts = new Map<string, Attempt[]>();
  events: Array<{ taskId: string; eventType: string; payload?: unknown }> = [];
  launchDispatches: Array<{
    id: number;
    taskId: string;
    attemptId: string;
    workflowId: string;
    generation: number;
    state: 'enqueued';
    priority: 'normal';
  }> = [];
  updateWorkflowCalls = new Map<string, number>();

  saveWorkflow(workflow: {
    id: string;
    name: string;
    status: string;
    repoUrl?: string;
    baseBranch?: string;
    featureBranch?: string;
    mergeMode?: 'manual' | 'automatic' | 'external_review';
    externalDependencies?: ExternalDependency[];
    externalDependencyChanges?: ExternalDependencyChange[];
    detachedExternalDependencies?: DetachedExternalDependency[];
  }): void {
    const now = new Date().toISOString();
    this.workflows.set(workflow.id, {
      ...workflow,
      // Synthesize a placeholder repoUrl so SSH-validation tests
      // (Step 5 `editTaskType` → ssh) keep passing without each
      // plan having to spell out a remote URL.
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
      status?: string;
      updatedAt?: string;
      baseBranch?: string;
      mergeMode?: 'manual' | 'automatic' | 'external_review';
      externalDependencies?: ExternalDependency[];
      externalDependencyChanges?: ExternalDependencyChange[];
      detachedExternalDependencies?: DetachedExternalDependency[];
    },
  ): void {
    const wf = this.workflows.get(workflowId);
    this.updateWorkflowCalls.set(workflowId, (this.updateWorkflowCalls.get(workflowId) ?? 0) + 1);
    if (wf && changes.status) {
      wf.status = changes.status;
    }
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
    if (wf && 'detachedExternalDependencies' in changes) {
      wf.detachedExternalDependencies = changes.detachedExternalDependencies;
    }
  }

  loadWorkflow(workflowId: string): {
    repoUrl?: string;
    baseBranch?: string;
    featureBranch?: string;
    mergeMode?: 'manual' | 'automatic' | 'external_review';
    externalDependencies?: ExternalDependency[];
    externalDependencyChanges?: ExternalDependencyChange[];
    detachedExternalDependencies?: DetachedExternalDependency[];
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
    const workflows = Array.from(this.workflows.values()).map((workflow) => {
      const tasks = tasksByWorkflowId.get(workflow.id) ?? [];
      if (tasks.length === 0) return workflow;
      const rollup = computeWorkflowRollup(tasks);
      return { ...workflow, status: rollup.status, rollup };
    });
    return {
      workflows,
      tasks: Array.from(this.tasks.values()).map((entry) => entry.task),
      tasksByWorkflowId,
    };
  }

  private withDerivedStatus<T extends { id: string; status: string }>(workflow: T): T {
    const tasks = this.loadTasks(workflow.id);
    if (tasks.length === 0) return workflow;
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

  enqueueLaunchDispatch(input: {
    taskId: string;
    attemptId: string;
    workflowId: string;
    generation: number;
  }): { id: number; state: 'enqueued'; priority: 'normal' } {
    const row = {
      id: this.launchDispatches.length + 1,
      taskId: input.taskId,
      attemptId: input.attemptId,
      workflowId: input.workflowId,
      generation: input.generation,
      state: 'enqueued' as const,
      priority: 'normal' as const,
    };
    this.launchDispatches.push(row);
    return row;
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
      orchestrator.retryTask('t2');
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
      orchestrator.retryTask('f2');
      const task = orchestrator.getTask('f2')!;
      expect(task.status === 'pending' || task.status === 'running').toBe(true);
      expect(task.execution.isFixingWithAI).toBeFalsy();
      expect(task.execution.pendingFixError).toBeUndefined();
    });

    it('revertConflictResolution restores failed state', () => {
      orchestrator.beginConflictResolution('f2');
      orchestrator.setFixAwaitingApproval('f2', 'test failed: expected 1 to be 2');
      orchestrator.revertConflictResolution('f2', 'test failed: expected 1 to be 2');
      const task = orchestrator.getTask('f2')!;
      expect(task.status).toBe('failed');
      expect(task.execution.error).toBe('test failed: expected 1 to be 2');
    });

    it('non-merge merge_conflict JSON pendingFixError resume relaunches with a fresh attempt', async () => {
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
      expect(task.execution.selectedAttemptId).not.toBe(fixAttemptId);
      expect(persistence.loadAttempt(fixAttemptId!)?.status).toBe('superseded');
      expect(persistence.loadAttempt(task.execution.selectedAttemptId!)?.status).toBe('running');
    });

    it('non-merge merge_conflict fix approval relaunches through the launch outbox when launch is deferred', async () => {
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
        deferRunningUntilLaunch: true,
      });
      orchestrator.loadPlan({
        name: 'deferred-fix-test',
        tasks: [
          { id: 'f1', description: 'Root task' },
          { id: 'f2', description: 'Failing task', dependencies: ['f1'] },
        ],
      });
      orchestrator.startExecution();
      const f1 = orchestrator.getTask('f1')!;
      expect(f1.status).toBe('pending');
      expect(f1.execution.phase).toBe('launching');
      orchestrator.markTaskRunningAfterLaunch('f1', f1.execution.selectedAttemptId!);
      orchestrator.handleWorkerResponse(
        makeResponse({
          actionId: 'f1',
          attemptId: f1.execution.selectedAttemptId!,
          status: 'completed',
          outputs: { exitCode: 0 },
        }),
      );
      const f2Launch = orchestrator.getTask('f2')!;
      expect(f2Launch.status).toBe('pending');
      expect(f2Launch.execution.phase).toBe('launching');
      orchestrator.markTaskRunningAfterLaunch('f2', f2Launch.execution.selectedAttemptId!);

      const mergeConflictError = JSON.stringify({
        type: 'merge_conflict',
        failedBranch: 'experiment/non-merge-branch-abc123',
        conflictFiles: ['src/non-merge.ts'],
      });
      orchestrator.handleWorkerResponse(
        makeResponse({
          actionId: 'f2',
          attemptId: f2Launch.execution.selectedAttemptId!,
          executionGeneration: f2Launch.execution.generation,
          status: 'failed',
          outputs: { exitCode: 1, error: mergeConflictError },
        }),
      );
      const { savedError } = orchestrator.beginConflictResolution('f2');
      expect(savedError).toBe(mergeConflictError);
      const fixAttemptId = orchestrator.getTask('f2')!.execution.selectedAttemptId!;
      orchestrator.setFixAwaitingApproval('f2', mergeConflictError);
      const dispatchesBeforeApproval = persistence.launchDispatches.length;

      const started = await orchestrator.resumeTaskAfterFixApproval('f2');

      expect(started).toHaveLength(1);
      expect(started[0].status).toBe('pending');
      expect(started[0].execution.phase).toBe('launching');
      expect(started[0].execution.selectedAttemptId).not.toBe(fixAttemptId);
      expect(started[0].execution.pendingFixError).toBeUndefined();
      expect(persistence.loadAttempt(fixAttemptId)?.status).toBe('superseded');
      expect(persistence.launchDispatches).toHaveLength(dispatchesBeforeApproval + 1);
      const dispatch = persistence.launchDispatches.at(-1)!;
      expect(dispatch.taskId).toBe(started[0].id);
      expect(dispatch.attemptId).toBe(started[0].execution.selectedAttemptId);
      expect(persistence.events.some(
        (event) => event.taskId === started[0].id && event.eventType === 'task.launch_claimed',
      )).toBe(true);
      expect(persistence.events.some(
        (event) => event.taskId === started[0].id && event.eventType === 'task.dispatch_enqueued',
      )).toBe(true);
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

  // Step 16 (`docs/architecture/task-invalidation-roadmap.md`,
  // chart row "Approve or reject fix"): pin the orchestrator-level
  // contract that production callers depend on through the
  // `MUTATION_POLICIES.fixApprove` / `MUTATION_POLICIES.fixReject`
  // wires (`packages/app/src/workflow-actions.ts → buildInvalidationDeps`
  // routes both via the existing `approveTask` / `rejectTask` action
  // wrappers).
  //
  // The chart's hard contract is that fix decisions are
  // **non-invalidating control flow over an existing fix attempt's
  // output**:
  //
  //   - Approve continues with the fix attempt's branch / commit /
  //     workspacePath as the task's authoritative result. Status
  //     transitions to `completed` (or `running` for merge / merge-
  //     conflict cases that need a publish step).
  //   - Reject reverts the task to its pre-fix `failed` state, with
  //     the original `pendingFixError` restored. The fix attempt's
  //     branch pointer is discarded but the task's lineage is not.
  //
  // Neither path may bump `task.execution.generation`, neither may
  // invoke retry/recreate, and neither may cancel the task itself
  // (by the time the decision runs the task is already terminal).
  // These tests pin all three invariants directly on the orchestrator
  // primitives the policy wires call.
  describe('Step 16: fix-decision is non-invalidating (no gen bump, no cancel, no retry/recreate)', () => {
    beforeEach(() => {
      orchestrator.loadPlan({
        name: 'fix-decision-test',
        tasks: [
          { id: 'fd1', description: 'Root task' },
          { id: 'fd2', description: 'Failing task', dependencies: ['fd1'] },
        ],
      });
      orchestrator.startExecution();
      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 'fd1', status: 'completed', outputs: { exitCode: 0 } }),
      );
      orchestrator.handleWorkerResponse(
        makeResponse({
          actionId: 'fd2',
          status: 'failed',
          outputs: { exitCode: 1, error: 'original failure' },
        }),
      );
      expect(orchestrator.getTask('fd2')!.status).toBe('failed');
    });

    it('approve: status -> completed, generation unchanged on edited task and dependents, lineage preserved, no retry/recreate spy fires', async () => {
      // Move fd2 through the fix attempt into awaiting_approval
      // with a pendingFixError. This is exactly the state an
      // `approveTask` invocation lands on in the fix flow.
      const { savedError } = orchestrator.beginConflictResolution('fd2');
      // Hydrate workspace lineage on the task so the preservation
      // half of the assertion is meaningful (the in-memory mock
      // does not synthesize branch/workspacePath itself).
      const persistedKey = Array.from(persistence.tasks.keys()).find(
        (k) => k === 'fd2' || k.endsWith('/fd2'),
      );
      if (!persistedKey) throw new Error('test setup: persisted fd2 key not found');
      persistence.updateTask(persistedKey, {
        execution: {
          branch: 'experiment/fix-attempt-branch',
          commit: 'fa11ed01',
          workspacePath: '/tmp/fix-attempt-workspace',
        },
      });
      orchestrator.setFixAwaitingApproval('fd2', savedError);

      const genBeforeApprove = {
        fd1: orchestrator.getTask('fd1')!.execution.generation ?? 0,
        fd2: orchestrator.getTask('fd2')!.execution.generation ?? 0,
      };
      const lineageBefore = orchestrator.getTask('fd2')!.execution;

      // Spy on the retry/recreate/cancel orchestrator primitives —
      // none must fire as a side effect of `approve`.
      const retryTaskSpy = vi.spyOn(orchestrator, 'retryTask');
      const recreateTaskSpy = vi.spyOn(orchestrator, 'recreateTask');
      const retryWorkflowSpy = vi.spyOn(orchestrator, 'retryWorkflow');
      const recreateWorkflowSpy = vi.spyOn(orchestrator, 'recreateWorkflow');
      const cancelTaskSpy = vi.spyOn(orchestrator, 'cancelTask');
      const cancelWorkflowSpy = vi.spyOn(orchestrator, 'cancelWorkflow');

      await orchestrator.approve('fd2');

      const fd2After = orchestrator.getTask('fd2')!;
      expect(fd2After.status).toBe('completed');

      // Generation invariants — the heart of the chart's
      // "approve or reject fix is non-invalidating" rule.
      expect(fd2After.execution.generation ?? 0).toBe(genBeforeApprove.fd2);
      expect(orchestrator.getTask('fd1')!.execution.generation ?? 0).toBe(
        genBeforeApprove.fd1,
      );

      // Lineage preserved — fix attempt's branch/commit/workspacePath
      // is now the task's authoritative lineage (continue-class).
      expect(fd2After.execution.branch).toBe(lineageBefore.branch);
      expect(fd2After.execution.commit).toBe(lineageBefore.commit);
      expect(fd2After.execution.workspacePath).toBe(lineageBefore.workspacePath);

      // No retry/recreate/cancel orchestrator primitives fire.
      expect(retryTaskSpy).not.toHaveBeenCalled();
      expect(recreateTaskSpy).not.toHaveBeenCalled();
      expect(retryWorkflowSpy).not.toHaveBeenCalled();
      expect(recreateWorkflowSpy).not.toHaveBeenCalled();
      expect(cancelTaskSpy).not.toHaveBeenCalled();
      expect(cancelWorkflowSpy).not.toHaveBeenCalled();
    });

    it('reject (revertConflictResolution): status -> failed (original error), generation unchanged on edited task and dependents, no retry/recreate/cancel spy fires', () => {
      const { savedError } = orchestrator.beginConflictResolution('fd2');
      orchestrator.setFixAwaitingApproval('fd2', savedError);
      expect(orchestrator.getTask('fd2')!.status).toBe('awaiting_approval');
      expect(orchestrator.getTask('fd2')!.execution.pendingFixError).toBe(savedError);

      const genBeforeReject = {
        fd1: orchestrator.getTask('fd1')!.execution.generation ?? 0,
        fd2: orchestrator.getTask('fd2')!.execution.generation ?? 0,
      };

      const retryTaskSpy = vi.spyOn(orchestrator, 'retryTask');
      const recreateTaskSpy = vi.spyOn(orchestrator, 'recreateTask');
      const retryWorkflowSpy = vi.spyOn(orchestrator, 'retryWorkflow');
      const recreateWorkflowSpy = vi.spyOn(orchestrator, 'recreateWorkflow');
      const cancelTaskSpy = vi.spyOn(orchestrator, 'cancelTask');
      const cancelWorkflowSpy = vi.spyOn(orchestrator, 'cancelWorkflow');

      orchestrator.revertConflictResolution('fd2', savedError);

      const fd2After = orchestrator.getTask('fd2')!;
      expect(fd2After.status).toBe('failed');
      expect(fd2After.execution.error).toBe(savedError);

      // Generation invariants — revert is also non-invalidating.
      expect(fd2After.execution.generation ?? 0).toBe(genBeforeReject.fd2);
      expect(orchestrator.getTask('fd1')!.execution.generation ?? 0).toBe(
        genBeforeReject.fd1,
      );

      expect(retryTaskSpy).not.toHaveBeenCalled();
      expect(recreateTaskSpy).not.toHaveBeenCalled();
      expect(retryWorkflowSpy).not.toHaveBeenCalled();
      expect(recreateWorkflowSpy).not.toHaveBeenCalled();
      expect(cancelTaskSpy).not.toHaveBeenCalled();
      expect(cancelWorkflowSpy).not.toHaveBeenCalled();
    });

    it('reject (plain Orchestrator.reject — non-fix awaiting_approval): same invariants as the fix-flow reject', () => {
      // Non-fix path: a task parked in `awaiting_approval` without
      // a `pendingFixError`. This is the branch `rejectTask` takes
      // when the task is NOT in a fix flow (it routes to
      // `Orchestrator.reject` instead of `revertConflictResolution`).
      orchestrator.retryTask('fd2');
      expect(orchestrator.getTask('fd2')!.status).toBe('running');
      orchestrator.setTaskAwaitingApproval('fd2');
      expect(orchestrator.getTask('fd2')!.status).toBe('awaiting_approval');
      expect(orchestrator.getTask('fd2')!.execution.pendingFixError).toBeUndefined();

      const genBeforeReject = {
        fd1: orchestrator.getTask('fd1')!.execution.generation ?? 0,
        fd2: orchestrator.getTask('fd2')!.execution.generation ?? 0,
      };

      const retryTaskSpy = vi.spyOn(orchestrator, 'retryTask');
      const recreateTaskSpy = vi.spyOn(orchestrator, 'recreateTask');
      const cancelTaskSpy = vi.spyOn(orchestrator, 'cancelTask');

      orchestrator.reject('fd2', 'rejected by reviewer');

      const fd2After = orchestrator.getTask('fd2')!;
      expect(fd2After.status).toBe('failed');
      expect(fd2After.execution.error).toBe('rejected by reviewer');

      expect(fd2After.execution.generation ?? 0).toBe(genBeforeReject.fd2);
      expect(orchestrator.getTask('fd1')!.execution.generation ?? 0).toBe(
        genBeforeReject.fd1,
      );

      expect(retryTaskSpy).not.toHaveBeenCalled();
      expect(recreateTaskSpy).not.toHaveBeenCalled();
      expect(cancelTaskSpy).not.toHaveBeenCalled();
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

    it('detaches direct dependents when deleting a workflow', () => {
      orchestrator.loadPlan({
        name: 'upstream-delete-target',
        baseBranch: 'master',
        featureBranch: 'feature/upstream-delete-target',
        tasks: [{ id: 'verify', description: 'upstream prerequisite' }],
      });
      const upstreamTaskId = sid(orchestrator, 0, 'verify');
      const upstreamWfId = upstreamTaskId.split('/')[0]!;

      orchestrator.loadPlan({
        name: 'downstream-external-dependent',
        baseBranch: 'feature/upstream-delete-target',
        featureBranch: 'feature/downstream-external-dependent',
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
      persistence.updateTask(downstreamTaskId, {
        execution: {
          branch: 'feature/downstream-external-dependent-task',
          commit: 'abc123',
          workspacePath: '/tmp/downstream-worktree',
          reviewId: '12',
          reviewUrl: 'https://github.com/owner/repo/pull/12',
        },
      });

      orchestrator.deleteWorkflow(upstreamWfId);

      const downstream = orchestrator.getTask(downstreamTaskId)!;
      expect(downstream.status).toBe('pending');
      expect(downstream.execution.blockedBy).toBeUndefined();
      expect(downstream.execution.branch).toBeUndefined();
      expect(downstream.execution.commit).toBeUndefined();
      expect(downstream.execution.workspacePath).toBeUndefined();
      expect(downstream.execution.reviewId).toBeUndefined();
      expect(downstream.execution.reviewUrl).toBeUndefined();
      expect(downstream.config.externalDependencies).toBeUndefined();
      expect(persistence.loadWorkflow(downstreamTaskId.split('/')[0]!)!.baseBranch).toBe('master');
    });
  });

  describe('detachWorkflow', () => {
    it('removes only the selected upstream edge, rewrites baseBranch, and voids descendants to pending', () => {
      orchestrator.loadPlan({
        name: 'upstream-a',
        baseBranch: 'master',
        featureBranch: 'feature/upstream-a',
        tasks: [{ id: 'verify-a', description: 'upstream A prerequisite' }],
      });
      const upstreamAWfId = sid(orchestrator, 0, 'verify-a').split('/')[0]!;

      orchestrator.loadPlan({
        name: 'upstream-b',
        baseBranch: 'master',
        featureBranch: 'feature/upstream-b',
        tasks: [{ id: 'verify-b', description: 'upstream B prerequisite' }],
      });
      const upstreamBWfId = sid(orchestrator, 1, 'verify-b').split('/')[0]!;

      orchestrator.loadPlan({
        name: 'target-workflow',
        baseBranch: 'feature/upstream-a',
        featureBranch: 'feature/target-workflow',
        tasks: [
          {
            id: 'wait-for-upstreams',
            description: 'target waits for two upstream workflows',
            externalDependencies: [
              { workflowId: upstreamAWfId, gatePolicy: 'review_ready' },
              { workflowId: upstreamBWfId, gatePolicy: 'review_ready' },
            ],
          },
        ],
      });
      const targetTaskId = sid(orchestrator, 2, 'wait-for-upstreams');
      const targetWfId = targetTaskId.split('/')[0]!;

      orchestrator.loadPlan({
        name: 'child-workflow',
        baseBranch: 'feature/target-workflow',
        featureBranch: 'feature/child-workflow',
        tasks: [
          {
            id: 'child-leaf',
            description: 'child waits on target workflow',
            externalDependencies: [{ workflowId: targetWfId, gatePolicy: 'review_ready' }],
          },
        ],
      });
      const childTaskId = sid(orchestrator, 3, 'child-leaf');
      persistence.updateTask(childTaskId, {
        execution: {
          branch: 'feature/child-leaf',
          commit: 'def456',
          workspacePath: '/tmp/child-worktree',
        },
      });

      orchestrator.detachWorkflow(targetWfId, upstreamAWfId);

      const targetTask = orchestrator.getTask(targetTaskId)!;
      expect(targetTask.status).toBe('pending');
      expect(persistence.loadWorkflow(targetWfId)!.externalDependencies).toEqual([
        { workflowId: upstreamBWfId, taskId: '__merge__', requiredStatus: 'completed', gatePolicy: 'review_ready' },
      ]);
      expect(persistence.loadWorkflow(targetWfId)!.externalDependencyChanges).toEqual([
        {
          before: {
            workflowId: upstreamAWfId,
            taskId: '__merge__',
            requiredStatus: 'completed',
            gatePolicy: 'review_ready',
          },
          changedAt: expect.any(String),
        },
      ]);
      expect(persistence.loadWorkflow(targetWfId)!.baseBranch).toBe('master');

      const childTask = orchestrator.getTask(childTaskId)!;
      expect(childTask.status).toBe('pending');
      expect(childTask.execution.branch).toBeUndefined();
      expect(childTask.execution.commit).toBeUndefined();
      expect(childTask.execution.workspacePath).toBeUndefined();
      expect(persistence.loadWorkflow(childTaskId.split('/')[0]!)!.externalDependencies).toEqual([
        { workflowId: targetWfId, taskId: '__merge__', requiredStatus: 'completed', gatePolicy: 'review_ready' },
      ]);
    });

    it('records read-only detach provenance while removing the active dependency and keeping audit events', () => {
      orchestrator.loadPlan({
        name: 'prov-upstream',
        baseBranch: 'master',
        featureBranch: 'feature/prov-upstream',
        tasks: [{ id: 'verify-prov', description: 'upstream prerequisite' }],
      });
      const upstreamWfId = sid(orchestrator, 0, 'verify-prov').split('/')[0]!;

      orchestrator.loadPlan({
        name: 'prov-target',
        baseBranch: 'master',
        featureBranch: 'feature/prov-target',
        tasks: [
          {
            id: 'prov-leaf',
            description: 'target depends on upstream',
            externalDependencies: [{ workflowId: upstreamWfId, gatePolicy: 'completed' }],
          },
        ],
      });
      const targetTaskId = sid(orchestrator, 1, 'prov-leaf');
      const targetWfId = targetTaskId.split('/')[0]!;

      orchestrator.detachWorkflow(targetWfId, upstreamWfId);

      const wf = persistence.loadWorkflow(targetWfId)!;
      // Active dependency removed so scheduling no longer waits on the upstream.
      expect(wf.externalDependencies).toBeUndefined();
      expect(orchestrator.getTask(targetTaskId)!.config.externalDependencies).toBeUndefined();

      // Read-only provenance preserves the full removed lineage.
      expect(wf.detachedExternalDependencies).toEqual([
        {
          workflowId: upstreamWfId,
          taskId: '__merge__',
          requiredStatus: 'completed',
          gatePolicy: 'completed',
          detachedAt: expect.any(String),
        },
      ]);

      // Existing audit trails remain intact.
      expect(wf.externalDependencyChanges).toEqual([
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
      const eventTypes = persistence.events.map((e) => e.eventType);
      expect(eventTypes).toContain('workflow.external_dependency_changed');
      expect(eventTypes).toContain('task.external_dependency_changed');
      expect(eventTypes).toContain('task.workflow_detached');
    });

    it('does not duplicate provenance when the same edge is re-added and detached again', () => {
      orchestrator.loadPlan({
        name: 'dedup-upstream',
        baseBranch: 'master',
        featureBranch: 'feature/dedup-upstream',
        tasks: [{ id: 'verify-dedup', description: 'upstream prerequisite' }],
      });
      const upstreamWfId = sid(orchestrator, 0, 'verify-dedup').split('/')[0]!;

      orchestrator.loadPlan({
        name: 'dedup-target',
        baseBranch: 'master',
        featureBranch: 'feature/dedup-target',
        tasks: [
          {
            id: 'dedup-leaf',
            description: 'target depends on upstream',
            externalDependencies: [{ workflowId: upstreamWfId, gatePolicy: 'review_ready' }],
          },
        ],
      });
      const targetTaskId = sid(orchestrator, 1, 'dedup-leaf');
      const targetWfId = targetTaskId.split('/')[0]!;

      orchestrator.detachWorkflow(targetWfId, upstreamWfId);
      expect(persistence.loadWorkflow(targetWfId)!.detachedExternalDependencies).toHaveLength(1);

      // Simulate a sync/reload that re-introduces the same active dependency.
      persistence.updateWorkflow(targetWfId, {
        externalDependencies: [
          { workflowId: upstreamWfId, taskId: '__merge__', requiredStatus: 'completed', gatePolicy: 'review_ready' },
        ],
      });

      orchestrator.detachWorkflow(targetWfId, upstreamWfId);

      // Provenance is keyed on upstream identity, so the repeat detach adds nothing.
      expect(persistence.loadWorkflow(targetWfId)!.detachedExternalDependencies).toEqual([
        {
          workflowId: upstreamWfId,
          taskId: '__merge__',
          requiredStatus: 'completed',
          gatePolicy: 'review_ready',
          detachedAt: expect.any(String),
        },
      ]);
    });

    it('voids a running target workflow and its descendants back to pending without auto-starting them', () => {
      orchestrator.loadPlan({
        name: 'upstream-runtime',
        baseBranch: 'master',
        featureBranch: 'feature/upstream-runtime',
        tasks: [{ id: 'verify-runtime', description: 'upstream runtime prerequisite' }],
      });
      const upstreamTaskId = sid(orchestrator, 0, 'verify-runtime');
      const upstreamWfId = upstreamTaskId.split('/')[0]!;
      const upstreamMergeId = `__merge__${upstreamWfId}`;

      orchestrator.loadPlan({
        name: 'target-runtime',
        baseBranch: 'feature/upstream-runtime',
        featureBranch: 'feature/target-runtime',
        tasks: [
          {
            id: 'wait-for-runtime-upstream',
            description: 'target waits on one upstream workflow',
            externalDependencies: [{ workflowId: upstreamWfId, gatePolicy: 'review_ready' }],
          },
        ],
      });
      const targetTaskId = sid(orchestrator, 1, 'wait-for-runtime-upstream');
      const targetWfId = targetTaskId.split('/')[0]!;

      orchestrator.loadPlan({
        name: 'target-runtime-child',
        baseBranch: 'feature/target-runtime',
        featureBranch: 'feature/target-runtime-child',
        tasks: [
          {
            id: 'child-runtime',
            description: 'child waits on target runtime workflow',
            externalDependencies: [{ workflowId: targetWfId, gatePolicy: 'review_ready' }],
          },
        ],
      });
      const childTaskId = sid(orchestrator, 2, 'child-runtime');

      orchestrator.startExecution();
      orchestrator.handleWorkerResponse(makeResponse({ actionId: upstreamTaskId, status: 'completed' }));
      orchestrator.setTaskAwaitingApproval(upstreamMergeId);
      orchestrator.approve(upstreamMergeId);
      expect(orchestrator.getTask(targetTaskId)!.status).toBe('running');

      orchestrator.detachWorkflow(targetWfId, upstreamWfId);

      expect(orchestrator.getTask(targetTaskId)!.status).toBe('pending');
      expect(orchestrator.getTask(targetTaskId)!.config.externalDependencies).toBeUndefined();
      expect(persistence.loadWorkflow(targetWfId)!.externalDependencyChanges).toEqual([
        {
          before: {
            workflowId: upstreamWfId,
            taskId: '__merge__',
            requiredStatus: 'completed',
            gatePolicy: 'review_ready',
          },
          changedAt: expect.any(String),
        },
      ]);
      expect(orchestrator.getTask(childTaskId)!.status).toBe('pending');
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

  describe('deleteAllWorkflows bulk (publishRemovalDeltas: false)', () => {
    it('removes all tasks from memory without publishing removal deltas', () => {
      orchestrator.loadPlan({
        name: 'wf-bulk-1',
        tasks: [{ id: 'b1', description: 'Task B1' }],
      });
      orchestrator.loadPlan({
        name: 'wf-bulk-2',
        tasks: [{ id: 'b2', description: 'Task B2' }],
      });
      expect(orchestrator.getAllTasks().length).toBeGreaterThan(0);
      publishedDeltas = [];

      orchestrator.deleteAllWorkflows({ publishRemovalDeltas: false });

      expect(orchestrator.getAllTasks()).toHaveLength(0);
      expect(orchestrator.getWorkflowIds()).toHaveLength(0);
      const removedDeltas = publishedDeltas.filter((d) => d.type === 'removed');
      expect(removedDeltas).toHaveLength(0);
    });

    it('clears persistence identically to legacy deleteAll', () => {
      orchestrator.loadPlan({
        name: 'wf-bulk-persist',
        tasks: [{ id: 'bp1', description: 'Task' }],
      });
      expect(persistence.workflows.size).toBeGreaterThan(0);

      orchestrator.deleteAllWorkflows({ publishRemovalDeltas: false });

      expect(persistence.workflows.size).toBe(0);
      expect(persistence.tasks.size).toBe(0);
    });

    it('orchestrator remains usable after bulk deleteAll', () => {
      orchestrator.loadPlan({
        name: 'wf-bulk-before',
        tasks: [{ id: 'bold1', description: 'Old task' }],
      });
      orchestrator.deleteAllWorkflows({ publishRemovalDeltas: false });

      orchestrator.loadPlan({
        name: 'wf-bulk-after',
        tasks: [{ id: 'bnew1', description: 'New task' }],
      });
      expect(orchestrator.getTask('bnew1')).toBeDefined();
      expect(orchestrator.getWorkflowIds()).toHaveLength(1);
    });

    it('legacy deleteAll still publishes removal deltas (parity check)', () => {
      orchestrator.loadPlan({
        name: 'wf-legacy-parity',
        tasks: [
          { id: 'lp1', description: 'Task 1' },
          { id: 'lp2', description: 'Task 2' },
        ],
      });
      publishedDeltas = [];

      orchestrator.deleteAllWorkflows();

      const removedDeltas = publishedDeltas.filter((d) => d.type === 'removed');
      // 2 tasks + 1 merge node = 3 removed deltas
      expect(removedDeltas).toHaveLength(3);
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
          runnerKind: 'merge',
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

    it('clears launch claim metadata when deferring a launch-claimed task', () => {
      const launchingOrchestrator = new Orchestrator({
        persistence,
        messageBus: bus,
        logger: consoleLogger,
        maxConcurrency: 3,
        deferRunningUntilLaunch: true,
      });
      launchingOrchestrator.loadPlan({
        name: 'defer-launch-claim-test',
        tasks: [{ id: 'task-a', description: 'Task A' }],
      });
      const started = launchingOrchestrator.startExecution();
      expect(started.length).toBe(1);
      expect(launchingOrchestrator.getTask('task-a')!.status).toBe('pending');
      expect(launchingOrchestrator.getTask('task-a')!.execution.phase).toBe('launching');

      launchingOrchestrator.deferTask('task-a');

      const task = launchingOrchestrator.getTask('task-a')!;
      expect(task.status).toBe('pending');
      expect(task.execution.phase).toBeUndefined();
      expect(task.execution.launchStartedAt).toBeUndefined();
      expect(task.execution.launchCompletedAt).toBeUndefined();
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
      orchestrator.retryTask('task-a');

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

  describe('replaceTask topology-fork gate', () => {
    it('forks the workflow instead of mutating a live workflow in place', () => {
      orchestrator.loadPlan({
        name: 'topology-gate-live',
        tasks: [
          { id: 'A', description: 'A', command: 'echo A' },
          { id: 'X', description: 'X', command: 'echo X', dependencies: ['A'] },
          { id: 'C', description: 'C', command: 'echo C', dependencies: ['X'] },
        ],
      });
      orchestrator.startExecution();
      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 'A', status: 'completed', outputs: { exitCode: 0 } }),
      );
      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 'X', status: 'failed', outputs: { exitCode: 1, error: 'fail' } }),
      );

      const xTask = orchestrator.getTask('X')!;
      const wfId = xTask.config.workflowId!;
      const scopedXId = xTask.id;

      const started = orchestrator.replaceTask('X', [
        { id: 'fix', description: 'Fix', command: 'echo fix' },
      ]);

      const forkedWorkflowId = orchestrator
        .getWorkflowIds()
        .find((id) => id !== wfId);

      expect(forkedWorkflowId).toBeDefined();
      expect(orchestrator.getTask(scopedXId)?.status).toBe('failed');
      const forkedFix = orchestrator
        .getAllTasks()
        .find((t) => t.config.workflowId === forkedWorkflowId && t.id.endsWith('/fix'));
      expect(forkedFix).toBeDefined();
      expect(started.some((t) => t.id === forkedFix?.id)).toBe(true);
    });

    it('allows in-place replacement on a fully terminal workflow', () => {
      orchestrator.loadPlan({
        name: 'topology-gate-terminal',
        tasks: [
          { id: 'A', description: 'A', command: 'echo A' },
          { id: 'X', description: 'X', command: 'echo X', dependencies: ['A'] },
          { id: 'C', description: 'C', command: 'echo C', dependencies: ['X'] },
        ],
      });
      orchestrator.startExecution();
      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 'A', status: 'completed', outputs: { exitCode: 0 } }),
      );
      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 'X', status: 'failed', outputs: { exitCode: 1, error: 'fail' } }),
      );
      // Cancel C → workflow now has no live non-merge tasks.
      orchestrator.cancelTask('C');

      orchestrator.replaceTask('X', [
        { id: 'fix', description: 'Fix', command: 'echo fix' },
      ]);

      expect(orchestrator.getTask('X')!.status).toBe('stale');
      expect(orchestrator.getTask('fix')).toBeDefined();
    });

    it('does not gate pure-attribute mutations even when the workflow is live', () => {
      orchestrator.loadPlan({
        name: 'topology-gate-attr',
        tasks: [
          { id: 'A', description: 'A', command: 'echo A' },
          { id: 'X', description: 'X', command: 'echo X', dependencies: ['A'] },
          { id: 'C', description: 'C', command: 'echo C', dependencies: ['X'] },
        ],
      });
      orchestrator.startExecution();
      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 'A', status: 'completed', outputs: { exitCode: 0 } }),
      );
      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 'X', status: 'failed', outputs: { exitCode: 1, error: 'fail' } }),
      );
      // C is `pending` → workflow is live by the Step 11 definition.
      expect(orchestrator.getTask('C')!.status).toBe('pending');

      // Pure-attribute edit must succeed without raising the topology gate.
      expect(() => orchestrator.editTaskCommand('A', 'echo A-v2')).not.toThrow();
      expect(orchestrator.getTask('A')!.config.command).toBe('echo A-v2');
    });
  });

  // Step 15 (`docs/architecture/task-invalidation-roadmap.md`,
  // chart row "Change external gate policy"): the orchestrator's
  // `setTaskExternalGatePolicies` is the engine's intentional
  // non-invalidating mutation. These tests pin the chart's
  // contract end-to-end inside the orchestrator: cancel/retry/
  // recreate are NEVER called, `task.execution.generation` is
  // unchanged, the persisted gate-policy field changes, and a
  // task previously blocked on the gate transitions to runnable
  // via the post-update scheduling pass.
  describe('setTaskExternalGatePolicies (Step 15 non-invalidating lock-in)', () => {
    it('does not invoke cancelTask, retryTask, or recreateTask', () => {
      orchestrator.loadPlan({
        name: 'gate-prereq',
        tasks: [{ id: 'verify', description: 'Prereq task' }],
      });
      const prereqTaskId = sid(orchestrator, 0, 'verify');
      const prereqWfId = prereqTaskId.split('/')[0]!;
      const prereqMergeId = `__merge__${prereqWfId}`;

      orchestrator.loadPlan({
        name: 'gate-downstream',
        tasks: [
          {
            id: 'leaf',
            description: 'leaf waits on upstream completion gate',
            externalDependencies: [{ workflowId: prereqWfId, gatePolicy: 'completed' }],
          },
        ],
      });
      const leafId = sid(orchestrator, 1, 'leaf');

      orchestrator.startExecution();
      orchestrator.handleWorkerResponse(makeResponse({ actionId: prereqTaskId, status: 'completed' }));
      orchestrator.setTaskAwaitingApproval(prereqMergeId);
      expect(orchestrator.getTask(leafId)!.status).toBe('pending');

      const cancelTaskSpy = vi.spyOn(orchestrator, 'cancelTask');
      const retryTaskSpy = vi.spyOn(orchestrator, 'retryTask');
      const recreateTaskSpy = vi.spyOn(orchestrator, 'recreateTask');
      const cancelWorkflowSpy = vi.spyOn(orchestrator, 'cancelWorkflow');

      orchestrator.setTaskExternalGatePolicies(leafId, [
        { workflowId: prereqWfId, gatePolicy: 'review_ready' },
      ]);

      expect(cancelTaskSpy).not.toHaveBeenCalled();
      expect(retryTaskSpy).not.toHaveBeenCalled();
      expect(recreateTaskSpy).not.toHaveBeenCalled();
      expect(cancelWorkflowSpy).not.toHaveBeenCalled();

      cancelTaskSpy.mockRestore();
      retryTaskSpy.mockRestore();
      recreateTaskSpy.mockRestore();
      cancelWorkflowSpy.mockRestore();
    });

    it("does not bump task.execution.generation on the edited task or upstream", () => {
      orchestrator.loadPlan({
        name: 'gate-prereq-gen',
        tasks: [{ id: 'verify', description: 'Prereq task' }],
      });
      const prereqTaskId = sid(orchestrator, 0, 'verify');
      const prereqWfId = prereqTaskId.split('/')[0]!;
      const prereqMergeId = `__merge__${prereqWfId}`;

      orchestrator.loadPlan({
        name: 'gate-downstream-gen',
        tasks: [
          {
            id: 'leaf',
            description: 'leaf waits on upstream completion gate',
            externalDependencies: [{ workflowId: prereqWfId, gatePolicy: 'completed' }],
          },
        ],
      });
      const leafId = sid(orchestrator, 1, 'leaf');

      orchestrator.startExecution();
      orchestrator.handleWorkerResponse(makeResponse({ actionId: prereqTaskId, status: 'completed' }));
      orchestrator.setTaskAwaitingApproval(prereqMergeId);

      const genBefore = orchestrator.getTask(leafId)!.execution.generation ?? 0;
      const upstreamGenBefore = orchestrator.getTask(prereqTaskId)!.execution.generation ?? 0;

      orchestrator.setTaskExternalGatePolicies(leafId, [
        { workflowId: prereqWfId, gatePolicy: 'review_ready' },
      ]);

      const genAfter = orchestrator.getTask(leafId)!.execution.generation ?? 0;
      const upstreamGenAfter = orchestrator.getTask(prereqTaskId)!.execution.generation ?? 0;
      expect(genAfter).toBe(genBefore);
      expect(upstreamGenAfter).toBe(upstreamGenBefore);
    });

    it('persists the updated gate-policy field on workflow metadata', () => {
      orchestrator.loadPlan({
        name: 'gate-prereq-persist',
        tasks: [{ id: 'verify', description: 'Prereq task' }],
      });
      const prereqTaskId = sid(orchestrator, 0, 'verify');
      const prereqWfId = prereqTaskId.split('/')[0]!;

      orchestrator.loadPlan({
        name: 'gate-downstream-persist',
        tasks: [
          {
            id: 'leaf',
            description: 'leaf waits on upstream completion gate',
            externalDependencies: [{ workflowId: prereqWfId, gatePolicy: 'completed' }],
          },
        ],
      });
      const leafId = sid(orchestrator, 1, 'leaf');
      const leafWfId = leafId.split('/')[0]!;

      orchestrator.setTaskExternalGatePolicies(leafId, [
        { workflowId: prereqWfId, gatePolicy: 'review_ready' },
      ]);

      const inMemoryDeps = persistence.loadWorkflow(leafWfId)!.externalDependencies!;
      expect(inMemoryDeps[0]!.gatePolicy).toBe('review_ready');
      expect(persistence.getTaskEntry(leafId)!.task.config.externalDependencies).toBeUndefined();
    });

    it('transitions a previously gate-blocked task to runnable via the scheduling pass', () => {
      orchestrator.loadPlan({
        name: 'gate-prereq-unblock',
        tasks: [{ id: 'verify', description: 'Prereq task' }],
      });
      const prereqTaskId = sid(orchestrator, 0, 'verify');
      const prereqWfId = prereqTaskId.split('/')[0]!;
      const prereqMergeId = `__merge__${prereqWfId}`;

      orchestrator.loadPlan({
        name: 'gate-downstream-unblock',
        tasks: [
          {
            id: 'leaf',
            description: 'leaf waits on upstream completion gate',
            externalDependencies: [{ workflowId: prereqWfId, gatePolicy: 'completed' }],
          },
        ],
      });
      const leafId = sid(orchestrator, 1, 'leaf');

      orchestrator.startExecution();
      orchestrator.handleWorkerResponse(makeResponse({ actionId: prereqTaskId, status: 'completed' }));
      orchestrator.setTaskAwaitingApproval(prereqMergeId);
      expect(orchestrator.getTask(leafId)!.status).toBe('pending');

      const started = orchestrator.setTaskExternalGatePolicies(leafId, [
        { workflowId: prereqWfId, gatePolicy: 'review_ready' },
      ]);

      expect(started.map((t) => t.id)).toContain(leafId);
      expect(orchestrator.getTask(leafId)!.status).toBe('running');
    });

    it('transitions an already-blocked review_ready dependent to runnable via the external gate pass', () => {
      orchestrator.loadPlan({
        name: 'gate-prereq-review-ready',
        tasks: [{ id: 'verify', description: 'Prereq task' }],
      });
      const prereqTaskId = sid(orchestrator, 0, 'verify');
      const prereqWfId = prereqTaskId.split('/')[0]!;
      const prereqMergeId = `__merge__${prereqWfId}`;

      orchestrator.loadPlan({
        name: 'gate-downstream-blocked-review-ready',
        externalDependencies: [
          { workflowId: prereqWfId, taskId: '__merge__', requiredStatus: 'completed', gatePolicy: 'review_ready' },
        ],
        tasks: [{ id: 'leaf', description: 'leaf waits on upstream review-ready gate' }],
      });
      const leafId = sid(orchestrator, 1, 'leaf');

      persistence.updateTask(prereqTaskId, { status: 'completed', execution: { completedAt: new Date() } });
      persistence.updateTask(prereqMergeId, {
        status: 'review_ready',
        execution: { reviewUrl: 'https://example.invalid/pull/1', reviewStatus: 'Awaiting review' },
      });
      persistence.updateTask(leafId, {
        status: 'blocked',
        execution: { blockedBy: `waiting on ${prereqMergeId} (running)` },
      });
      orchestrator.syncAllFromDb();

      const started = orchestrator.autoStartExternallyUnblockedReadyTasks();

      expect(started.map((t) => t.id)).toContain(leafId);
      expect(orchestrator.getTask(leafId)!.status).toBe('running');
      expect(orchestrator.getTask(leafId)!.execution.blockedBy).toBeUndefined();
    });

    it('does NOT cancel an already-running task on the same workflow', () => {
      orchestrator.loadPlan({
        name: 'gate-prereq-running',
        tasks: [{ id: 'verify', description: 'Prereq task' }],
      });
      const prereqTaskId = sid(orchestrator, 0, 'verify');
      const prereqWfId = prereqTaskId.split('/')[0]!;
      const prereqMergeId = `__merge__${prereqWfId}`;

      orchestrator.loadPlan({
        name: 'gate-mixed-downstream',
        tasks: [
          { id: 'busy', description: 'already running task' },
          {
            id: 'leaf',
            description: 'leaf waits on upstream completion gate',
          },
        ],
      });
      const busyId = sid(orchestrator, 1, 'busy');
      const leafId = sid(orchestrator, 1, 'leaf');
      const leafWfId = leafId.split('/')[0]!;

      orchestrator.startExecution();
      orchestrator.handleWorkerResponse(makeResponse({ actionId: prereqTaskId, status: 'completed' }));
      orchestrator.setTaskAwaitingApproval(prereqMergeId);
      expect(orchestrator.getTask(busyId)!.status).toBe('running');
      const busyGenBefore = orchestrator.getTask(busyId)!.execution.generation ?? 0;
      persistence.updateWorkflow(leafWfId, {
        externalDependencies: [
          { workflowId: prereqWfId, taskId: '__merge__', requiredStatus: 'completed', gatePolicy: 'completed' },
        ],
      });

      orchestrator.setTaskExternalGatePolicies(leafId, [
        { workflowId: prereqWfId, gatePolicy: 'review_ready' },
      ]);

      // The unrelated already-running task keeps its execution
      // lineage and stays running on the same generation — the
      // chart's "in-flight work survives" guarantee.
      expect(orchestrator.getTask(busyId)!.status).toBe('running');
      const busyGenAfter = orchestrator.getTask(busyId)!.execution.generation ?? 0;
      expect(busyGenAfter).toBe(busyGenBefore);
    });
  });

});
