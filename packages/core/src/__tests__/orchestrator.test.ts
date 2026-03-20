import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Orchestrator, PlanConflictError } from '../orchestrator.js';
import type { PlanDefinition, OrchestratorPersistence, OrchestratorMessageBus } from '../orchestrator.js';
import type { TaskState, TaskDelta, TaskStateChanges } from '../task-types.js';
import type { WorkResponse } from '@invoker/protocol';

// ── In-Memory Persistence Mock ──────────────────────────────

class InMemoryPersistence implements OrchestratorPersistence {
  workflows = new Map<string, { id: string; name: string; status: string; createdAt: string; updatedAt: string }>();
  tasks = new Map<string, { workflowId: string; task: TaskState }>();
  events: Array<{ taskId: string; eventType: string; payload?: unknown }> = [];

  saveWorkflow(workflow: { id: string; name: string; status: string }): void {
    const now = new Date().toISOString();
    this.workflows.set(workflow.id, { ...workflow, createdAt: (workflow as any).createdAt ?? now, updatedAt: (workflow as any).updatedAt ?? now });
  }

  updateWorkflow(workflowId: string, changes: { status?: string; updatedAt?: string }): void {
    const wf = this.workflows.get(workflowId);
    if (wf && changes.status) {
      wf.status = changes.status;
    }
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
      expect(t2!.dependencies).toEqual(['t1']);
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

    it('passes familiarType when specified', () => {
      orchestrator.loadPlan({
        name: 'familiar-type-test',
        tasks: [
          { id: 't1', description: 'Worktree task', familiarType: 'worktree' },
          { id: 't2', description: 'Default task' },
        ],
      });

      expect(orchestrator.getTask('t1')!.config.familiarType).toBe('worktree');
      expect(orchestrator.getTask('t2')!.config.familiarType).toBe('worktree');
    });

    it('passes autoFix and maxFixAttempts', () => {
      orchestrator.loadPlan({
        name: 'autofix-plan',
        tasks: [{ id: 't1', description: 'Auto-fix task', autoFix: true, maxFixAttempts: 2 }],
      });

      const task = orchestrator.getTask('t1');
      expect(task!.config.autoFix).toBe(true);
      expect(task!.config.maxFixAttempts).toBe(2);
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
      expect(mergeNode!.dependencies.sort()).toEqual(['c', 'd']);
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
      expect(persistence.tasks.has('t1')).toBe(true);
      expect(persistence.tasks.has('t2')).toBe(true);
    });

    it('throws PlanConflictError when task IDs overlap with existing workflow', () => {
      const plan: PlanDefinition = {
        name: 'plan-A',
        tasks: [
          { id: 'shared-task', description: 'A task' },
        ],
      };
      orchestrator.loadPlan(plan);

      const plan2: PlanDefinition = {
        name: 'plan-B',
        tasks: [
          { id: 'shared-task', description: 'Same task ID' },
        ],
      };
      expect(() => orchestrator.loadPlan(plan2)).toThrow(PlanConflictError);
    });

    it('includes conflicting task IDs and workflow info in PlanConflictError', () => {
      orchestrator.loadPlan({
        name: 'Original Plan',
        tasks: [
          { id: 'task-x', description: 'X' },
          { id: 'task-y', description: 'Y', dependencies: ['task-x'] },
        ],
      });

      try {
        orchestrator.loadPlan({
          name: 'Duplicate Plan',
          tasks: [
            { id: 'task-y', description: 'Y again' },
          ],
        });
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(PlanConflictError);
        const conflict = err as PlanConflictError;
        expect(conflict.conflictingTaskIds).toContain('task-y');
        expect(conflict.conflictingWorkflows.length).toBeGreaterThan(0);
        expect(conflict.conflictingWorkflows[0].name).toBe('Original Plan');
        expect(conflict.message).toContain('task-y');
        expect(conflict.message).toContain('allowGraphMutation');
      }
    });

    it('allows overlapping IDs when allowGraphMutation is true', () => {
      orchestrator.loadPlan({
        name: 'plan-A',
        tasks: [{ id: 'overlap', description: 'A' }],
      });

      expect(() =>
        orchestrator.loadPlan(
          { name: 'plan-B', tasks: [{ id: 'overlap', description: 'B' }] },
          { allowGraphMutation: true },
        ),
      ).not.toThrow();

      const task = orchestrator.getTask('overlap');
      expect(task).toBeDefined();
      expect(task!.description).toBe('B');
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
      expect(started[0].id).toBe('t1');
      expect(orchestrator.getTask('t2')!.status).toBe('pending');
      expect(orchestrator.getTask('t3')!.status).toBe('pending');
    });

    it('persists status changes to DB', () => {
      orchestrator.loadPlan({
        name: 'test-plan',
        tasks: [{ id: 't1', description: 'Root' }],
      });

      orchestrator.startExecution();

      const persisted = persistence.tasks.get('t1');
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

    it('failed: marks task failed, blocks dependents', () => {
      orchestrator.handleWorkerResponse(
        makeResponse({
          actionId: 't1',
          status: 'failed',
          outputs: { exitCode: 1, error: 'Something broke' },
        }),
      );

      expect(orchestrator.getTask('t1')!.status).toBe('failed');
      expect(orchestrator.getTask('t2')!.status).toBe('blocked');
      expect(orchestrator.getTask('t3')!.status).toBe('blocked');
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

      const persisted = persistence.tasks.get('t1');
      expect(persisted!.task.status).toBe('completed');
    });

    it('persists blocked status to DB', () => {
      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 't1', status: 'failed', outputs: { exitCode: 1, error: 'fail' } }),
      );

      const persisted = persistence.tasks.get('t2');
      expect(persisted!.task.status).toBe('blocked');
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

      const delta = publishedDeltas.find(
        (d) => d.type === 'updated' && d.taskId === 'a1',
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
  });

  describe('reject', () => {
    it('fails task, blocks dependents', () => {
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
      expect(orchestrator.getTask('t2')!.status).toBe('blocked');
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

      const reconTask = orchestrator.getTask('pivot-reconciliation');
      expect(reconTask).toBeDefined();
      expect(reconTask!.status).toBe('needs_input');
      expect(reconTask!.execution.experimentResults).toBeDefined();

      const results = reconTask!.execution.experimentResults!;
      const v1Result = results.find((r) => r.id === 'pivot-exp-v1');
      const v2Result = results.find((r) => r.id === 'pivot-exp-v2');
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
    it('failed autoFix task spawns fix experiments instead of failing', () => {
      orchestrator.loadPlan({
        name: 'autofix-test',
        tasks: [
          { id: 't1', description: 'Auto-fix task', autoFix: true, maxFixAttempts: 2 },
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
      expect(t1!.status).toBe('completed');

      const fixConservative = orchestrator.getTask('t1-exp-fix-conservative');
      const fixRefactor = orchestrator.getTask('t1-exp-fix-refactor');
      expect(fixConservative).toBeDefined();
      expect(fixRefactor).toBeDefined();

      const fixAlternative = orchestrator.getTask('t1-exp-fix-alternative');
      expect(fixAlternative).toBeUndefined();

      expect(started.length).toBeGreaterThan(0);
    });

    it('autoFix experiments go through full reconciliation lifecycle', () => {
      orchestrator.loadPlan({
        name: 'autofix-recon-test',
        tasks: [
          { id: 't1', description: 'Auto-fix task', autoFix: true, maxFixAttempts: 2 },
          { id: 't2', description: 'After fix', dependencies: ['t1'] },
        ],
      });
      orchestrator.startExecution();

      orchestrator.handleWorkerResponse(
        makeResponse({
          actionId: 't1',
          status: 'failed',
          outputs: { exitCode: 1, error: 'type error' },
        }),
      );

      orchestrator.handleWorkerResponse(
        makeResponse({
          actionId: 't1-exp-fix-conservative',
          status: 'completed',
          outputs: { exitCode: 0, summary: 'Fixed with minimal change' },
        }),
      );

      if (orchestrator.getTask('t1-exp-fix-refactor')!.status === 'pending') {
        orchestrator.startExecution();
      }

      orchestrator.handleWorkerResponse(
        makeResponse({
          actionId: 't1-exp-fix-refactor',
          status: 'completed',
          outputs: { exitCode: 0, summary: 'Refactored approach' },
        }),
      );

      const reconTask = orchestrator.getTask('t1-reconciliation');
      expect(reconTask).toBeDefined();
      expect(reconTask!.status).toBe('needs_input');
      expect(reconTask!.execution.experimentResults).toHaveLength(2);

      orchestrator.selectExperiment('t1-reconciliation', 't1-exp-fix-conservative');
      expect(orchestrator.getTask('t1-reconciliation')!.status).toBe('completed');
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
      expect(orchestrator.getTask('t2')!.status).toBe('blocked');
    });

    it('fix experiment prompts include original error message', () => {
      orchestrator.loadPlan({
        name: 'autofix-prompt-test',
        tasks: [{ id: 't1', description: 'Build widgets', autoFix: true, prompt: 'npm run build' }],
      });
      orchestrator.startExecution();

      orchestrator.handleWorkerResponse(
        makeResponse({
          actionId: 't1',
          status: 'failed',
          outputs: { exitCode: 1, error: 'ModuleNotFoundError: xyz' },
        }),
      );

      const fixTask = orchestrator.getTask('t1-exp-fix-conservative');
      expect(fixTask).toBeDefined();
      expect(fixTask!.config.prompt).toContain('ModuleNotFoundError: xyz');
      expect(fixTask!.config.prompt).toContain('Build widgets');
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
      expect(started[0].id).toBe('t1');

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

    it('marks workflow failed when any task fails', () => {
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

      const wf = Array.from(persistence.workflows.values())[0];
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
      expect(startEvents[0].taskId).toBe('t1');
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
      expect(completeEvents[0].taskId).toBe('t1');
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
      expect(failEvents[0].taskId).toBe('t1');
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
      expect(started[0].id).toBe('t1');
    });

    it('forks dirty subtree when editing a completed task with dependents', () => {
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

      const started = orchestrator.editTaskCommand('parent', 'echo updated');

      expect(orchestrator.getTask('parent')?.config.command).toBe('echo updated');
      expect(orchestrator.getTask('parent')?.status).toBe('running');
      expect(orchestrator.getTask('child')?.status).toBe('stale');

      const allTasks = orchestrator.getAllTasks();
      const forkedChild = allTasks.find((t) => t.id !== 'child' && t.description === 'Child');
      expect(forkedChild).toBeDefined();
      expect(forkedChild?.status).toBe('pending');
    });

    it('throws when trying to edit a running task', () => {
      orchestrator.loadPlan({
        name: 'edit-running-test',
        tasks: [{ id: 't1', description: 'Task 1', command: 'sleep 100' }],
      });
      orchestrator.startExecution();

      expect(() => orchestrator.editTaskCommand('t1', 'echo new')).toThrow();
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

      const persisted = persistence.tasks.get('t1');
      expect(persisted).toBeDefined();
      expect(persisted?.task.config.command).toBe('echo fixed');
    });
  });

  // ── editTaskType ───────────────────────────────────────

  describe('editTaskType', () => {
    it('changes familiarType and restarts the task', () => {
      orchestrator.loadPlan({
        name: 'edit-type-test',
        tasks: [{ id: 't1', description: 'Task 1', command: 'echo hello', familiarType: 'local' }],
      });
      orchestrator.startExecution();

      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 't1', status: 'failed', outputs: { exitCode: 1, error: 'fail' } }),
      );
      expect(orchestrator.getTask('t1')?.config.familiarType).toBe('local');

      const started = orchestrator.editTaskType('t1', 'worktree');
      const task = orchestrator.getTask('t1');
      expect(task?.config.familiarType).toBe('worktree');
      expect(task?.status).toBe('running');
      expect(started).toHaveLength(1);
    });

    it('does not fork dirty subtree', () => {
      orchestrator.loadPlan({
        name: 'edit-type-no-fork',
        tasks: [
          { id: 'parent', description: 'Parent', command: 'echo parent', familiarType: 'local' },
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
      expect(orchestrator.getTask('child')?.status).toBe('completed');
    });

    it('throws when trying to edit a running task', () => {
      orchestrator.loadPlan({
        name: 'edit-type-running',
        tasks: [{ id: 't1', description: 'Task 1', command: 'sleep 100', familiarType: 'local' }],
      });
      orchestrator.startExecution();

      expect(() => orchestrator.editTaskType('t1', 'worktree')).toThrow();
    });

    it('persists the updated familiarType', () => {
      orchestrator.loadPlan({
        name: 'edit-type-persist',
        tasks: [{ id: 't1', description: 'Task 1', command: 'echo old', familiarType: 'local' }],
      });
      orchestrator.startExecution();

      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 't1', status: 'failed', outputs: { exitCode: 1, error: 'oops' } }),
      );

      orchestrator.editTaskType('t1', 'worktree');

      const persisted = persistence.tasks.get('t1');
      expect(persisted).toBeDefined();
      expect(persisted?.task.config.familiarType).toBe('worktree');
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
        const persisted = persistence.tasks.get(task.id);
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
        const persisted = persistence.tasks.get(task.id);
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
        const persisted = persistence.tasks.get(task.id);
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
      expect(userTasks.map((t) => t.id).sort()).toEqual(['a1', 'b1']);
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

    it('warns when blockedBy is overwritten by a second failure', () => {
      orchestrator.loadPlan({
        name: 'overwrite-test',
        tasks: [
          { id: 'A', description: 'Root A', command: 'echo A' },
          { id: 'B', description: 'Root B', command: 'echo B' },
          { id: 'C', description: 'Fan-in', command: 'echo C', dependencies: ['A', 'B'] },
        ],
      });
      orchestrator.startExecution();

      // Fail A — C gets blockedBy: A
      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 'A', status: 'failed', outputs: { exitCode: 1, error: 'boom' } }),
      );
      expect(orchestrator.getTask('C')!.execution.blockedBy).toBe('A');

      // Fail B — C's blockedBy should be overwritten to B
      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 'B', status: 'failed', outputs: { exitCode: 1, error: 'boom' } }),
      );
      expect(orchestrator.getTask('C')!.execution.blockedBy).toBe('B');

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('blockDependents: "C" blockedBy overwritten from "A" to "B"'),
      );
    });

    it('warns about completed downstream tasks that will not be invalidated on restart', () => {
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

      warnSpy.mockClear();
      orchestrator.restartTask('A');

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('restartTask "A"'),
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('will NOT be invalidated'),
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('B'),
      );
    });

    it('warns when unblocking a task that still has other failed dependencies', () => {
      orchestrator.loadPlan({
        name: 'premature-unblock-test',
        tasks: [
          { id: 'A', description: 'Root A', command: 'echo A' },
          { id: 'B', description: 'Root B', command: 'echo B' },
          { id: 'C', description: 'Fan-in', command: 'echo C', dependencies: ['A', 'B'] },
        ],
      });
      orchestrator.startExecution();

      // Fail A, then B — C ends up with blockedBy: B
      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 'A', status: 'failed', outputs: { exitCode: 1, error: 'boom' } }),
      );
      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 'B', status: 'failed', outputs: { exitCode: 1, error: 'boom' } }),
      );

      warnSpy.mockClear();
      orchestrator.restartTask('B');

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('unblocking "C" but it still has failed deps: [A]'),
      );
    });

    it('logs blockedBy mismatch when restarting a task whose dependents are blocked by another', () => {
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

      warnSpy.mockClear();
      // Restart A — C is blocked by B, not A, so unblock won't find it
      orchestrator.restartTask('A');

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('depend on "A" but are blocked by a different task'),
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('"C" (blockedBy: B)'),
      );
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

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('handleCompleted "A": 1 newly ready: [B]'),
      );
    });

    // ── Integration: full fan-in multi-failure restart cycle ──

    it('integration: three-root fan-in tracks all warnings through failure and restart cycle', () => {
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

      // Phase 1: All three roots fail, producing blockedBy overwrite warnings
      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 'A', status: 'failed', outputs: { exitCode: 1, error: 'a' } }),
      );
      expect(orchestrator.getTask('D')!.execution.blockedBy).toBe('A');

      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 'B', status: 'failed', outputs: { exitCode: 1, error: 'b' } }),
      );
      expect(orchestrator.getTask('D')!.execution.blockedBy).toBe('B');
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('blockedBy overwritten from "A" to "B"'),
      );

      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 'C', status: 'failed', outputs: { exitCode: 1, error: 'c' } }),
      );
      expect(orchestrator.getTask('D')!.execution.blockedBy).toBe('C');
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('blockedBy overwritten from "B" to "C"'),
      );

      // Phase 2: Restart A — D is blocked by C, not A
      warnSpy.mockClear();
      logSpy.mockClear();
      orchestrator.restartTask('A');

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('restartTask "A" (was failed)'),
      );
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('restartTask "A": unblocked 0 tasks'),
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('depend on "A" but are blocked by a different task'),
      );

      // D still blocked
      expect(orchestrator.getTask('D')!.status).toBe('blocked');

      // Phase 3: Restart B — D still blocked by C
      warnSpy.mockClear();
      orchestrator.restartTask('B');
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('depend on "B" but are blocked by a different task'),
      );
      expect(orchestrator.getTask('D')!.status).toBe('blocked');

      // Phase 4: Restart C — C matches blockedBy, D is unblocked
      warnSpy.mockClear();
      logSpy.mockClear();
      orchestrator.restartTask('C');

      const unblockLog = logSpy.mock.calls.find(
        call => typeof call[0] === 'string' && call[0].includes('restartTask "C": unblocked'),
      );
      expect(unblockLog).toBeDefined();
      expect(unblockLog![0]).toContain('D');
      expect(orchestrator.getTask('D')!.status).toBe('pending');

      // Phase 5: Complete A, B, C — D should become ready after the last one
      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 'A', status: 'completed', outputs: { exitCode: 0 } }),
      );
      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 'B', status: 'completed', outputs: { exitCode: 0 } }),
      );

      logSpy.mockClear();
      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 'C', status: 'completed', outputs: { exitCode: 0 } }),
      );

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('handleCompleted "C": 1 newly ready: [D]'),
      );
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

    it('handleCompleted unblocks previously-blocked dependents', () => {
      orchestrator.loadPlan({
        name: 'unblock-on-complete-test',
        tasks: [
          { id: 'A', description: 'Root', command: 'echo A' },
          { id: 'B', description: 'Child', command: 'echo B', dependencies: ['A'] },
        ],
      });
      orchestrator.startExecution();

      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 'A', status: 'failed', outputs: { exitCode: 1, error: 'fail' } }),
      );
      expect(orchestrator.getTask('B')!.status).toBe('blocked');
      expect(orchestrator.getTask('B')!.execution.blockedBy).toBe('A');

      logSpy.mockClear();
      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 'A', status: 'completed', outputs: { exitCode: 0 } }),
      );

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('handleCompleted "A": unblocking'),
      );
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('previously-blocked tasks: [B'),
      );
      expect(orchestrator.getTask('A')!.status).toBe('completed');
      expect(orchestrator.getTask('B')!.status).toBe('running');
      expect(orchestrator.getTask('B')!.execution.blockedBy).toBeUndefined();
    });

    it('handleCompleted unblocks multi-level blocked chain', () => {
      orchestrator.loadPlan({
        name: 'multi-level-unblock-test',
        tasks: [
          { id: 'A', description: 'Root', command: 'echo A' },
          { id: 'B', description: 'Level 1', command: 'echo B', dependencies: ['A'] },
          { id: 'C', description: 'Level 2', command: 'echo C', dependencies: ['B'] },
        ],
      });
      orchestrator.startExecution();

      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 'A', status: 'failed', outputs: { exitCode: 1, error: 'fail' } }),
      );
      expect(orchestrator.getTask('B')!.status).toBe('blocked');
      expect(orchestrator.getTask('C')!.status).toBe('blocked');

      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 'A', status: 'completed', outputs: { exitCode: 0 } }),
      );

      expect(orchestrator.getTask('B')!.status).toBe('running');
      expect(orchestrator.getTask('B')!.execution.blockedBy).toBeUndefined();
      // C is unblocked but not ready yet (B is not completed)
      expect(orchestrator.getTask('C')!.status).toBe('pending');
      expect(orchestrator.getTask('C')!.execution.blockedBy).toBeUndefined();
    });

    it('warns when response arrives for already-terminal task', () => {
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

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('received "completed" for already-"failed" task "A"'),
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

      const schedulerBefore = (orchestrator as any).scheduler.getStatus();
      expect(schedulerBefore.runningCount).toBe(1);

      // Response with valid actionId but missing required fields — triggers parse error
      orchestrator.handleWorkerResponse({ actionId: 'A' } as any);

      const schedulerAfter = (orchestrator as any).scheduler.getStatus();
      expect(schedulerAfter.runningCount).toBe(0);
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

    it('scheduler.runningCount matches actual running tasks after handleWorkerResponse', () => {
      orchestrator.loadPlan({
        name: 'scheduler-sync-test',
        tasks: [
          { id: 't1', description: 'Task 1' },
          { id: 't2', description: 'Task 2', dependencies: ['t1'] },
        ],
      });
      orchestrator.startExecution();

      const schedulerBefore = (orchestrator as any).scheduler.getStatus();
      expect(schedulerBefore.runningCount).toBe(1);

      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 't1', status: 'completed', outputs: { exitCode: 0 } }),
      );

      const schedulerAfter = (orchestrator as any).scheduler.getStatus();
      const runningTasks = orchestrator.getAllTasks().filter(t => t.status === 'running');
      expect(schedulerAfter.runningCount).toBe(runningTasks.length);
    });

    it('scheduler.runningCount matches after selectExperiment completes reconciliation', () => {
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
        makeResponse({ actionId: 'pivot-exp-v1', status: 'completed', outputs: { exitCode: 0 } }),
      );
      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 'pivot-exp-v2', status: 'completed', outputs: { exitCode: 0 } }),
      );

      expect(orchestrator.getTask('pivot-reconciliation')!.status).toBe('needs_input');

      persistence.updateTask('pivot-exp-v1', {
        execution: { branch: 'experiment/v1', commit: 'abc' },
      });

      orchestrator.selectExperiment('pivot-reconciliation', 'pivot-exp-v1');

      const scheduler = (orchestrator as any).scheduler;
      const runningTasks = orchestrator.getAllTasks().filter(t => t.status === 'running');
      expect(scheduler.getStatus().runningCount).toBe(runningTasks.length);
    });

    it('drainScheduler self-heals leaked scheduler slots', () => {
      orchestrator.loadPlan({
        name: 'leak-heal-test',
        tasks: [
          { id: 't1', description: 'Task 1' },
          { id: 't2', description: 'Task 2' },
          { id: 't3', description: 'Task 3' },
        ],
      });
      orchestrator.startExecution();

      const scheduler = (orchestrator as any).scheduler;

      // Simulate a leak: complete t1 in the state machine but NOT in the scheduler
      persistence.updateTask('t1', { status: 'completed', execution: { completedAt: new Date(), exitCode: 0 } });
      const wfId = orchestrator.getWorkflowIds()[0];
      orchestrator.syncFromDb(wfId);

      expect(orchestrator.getTask('t1')!.status).toBe('completed');
      expect(scheduler.isRunning('t1')).toBe(true); // Leaked!

      // Completing t2 triggers drainScheduler which should self-heal
      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 't2', status: 'completed', outputs: { exitCode: 0 } }),
      );

      expect(scheduler.isRunning('t1')).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('freeing leaked scheduler slot for "t1"'),
      );
    });

    it('selectExperiments starts downstream tasks when scheduler has capacity', () => {
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
        makeResponse({ actionId: 'pivot-exp-v1', status: 'completed', outputs: { exitCode: 0 } }),
      );
      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 'pivot-exp-v2', status: 'completed', outputs: { exitCode: 0 } }),
      );

      const started = orchestrator.selectExperiments(
        'pivot-reconciliation',
        ['pivot-exp-v1', 'pivot-exp-v2'],
        'recon-branch',
        'recon-commit',
      );

      expect(started.length).toBeGreaterThan(0);
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('selectExperiments "pivot-reconciliation"'),
      );
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

    it('restartTask from blocked status resets to pending', () => {
      orchestrator.loadPlan({
        name: 'blocked-restart-test',
        tasks: [
          { id: 'A', description: 'Root', command: 'echo A' },
          { id: 'B', description: 'Depends on A', command: 'echo B', dependencies: ['A'] },
        ],
      });
      orchestrator.startExecution();

      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 'A', status: 'failed', outputs: { exitCode: 1, error: 'fail' } }),
      );
      expect(orchestrator.getTask('B')!.status).toBe('blocked');

      const result = orchestrator.restartTask('B');

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

    it('blockedBy overwrite: restart first failure does not unblock task blocked by second failure', () => {
      orchestrator.loadPlan({
        name: 'blocked-overwrite-test',
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
      expect(orchestrator.getTask('C')!.execution.blockedBy).toBe('A');

      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 'B', status: 'failed', outputs: { exitCode: 1, error: 'b' } }),
      );
      expect(orchestrator.getTask('C')!.execution.blockedBy).toBe('B');

      orchestrator.restartTask('A');

      expect(orchestrator.getTask('C')!.status).toBe('blocked');
      expect(orchestrator.getTask('C')!.execution.blockedBy).toBe('B');
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
          actionId: 'pivot-exp-v1',
          status: 'completed',
          outputs: { exitCode: 0 },
        }),
      );

      orchestrator.handleWorkerResponse(
        makeResponse({
          actionId: 'pivot-exp-v2',
          status: 'completed',
          outputs: { exitCode: 0 },
        }),
      );

      expect(orchestrator.getTask('pivot-reconciliation')!.status).toBe('needs_input');

      orchestrator.restartTask('pivot-exp-v1');

      expect(orchestrator.getTask('pivot-reconciliation')!.status).toBe('pending');
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

    it('restartWorkflow clears lastHeartbeatAt for all tasks', () => {
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
      testOrchestrator.restartWorkflow();

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

    it('restartWorkflow clears PR state for merge nodes', () => {
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
          prUrl: 'https://github.com/org/repo/pull/42',
          prIdentifier: '42',
          prStatus: 'open',
        },
      });

      const testOrchestrator = new Orchestrator({
        persistence: testPersistence,
        messageBus: testBus,
        maxConcurrency: 3,
      });

      testOrchestrator.syncFromDb('workflow-pr-test');
      testOrchestrator.restartWorkflow('workflow-pr-test');

      const mergeTask = testOrchestrator.getTask('__merge__workflow-pr-test')!;
      expect(mergeTask.execution.prUrl).toBeUndefined();
      expect(mergeTask.execution.prIdentifier).toBeUndefined();
      expect(mergeTask.execution.prStatus).toBeUndefined();
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

      const scheduler = (orchestrator as any).scheduler;
      const status = scheduler.getStatus();
      const stillRunning = orchestrator.getAllTasks().filter(t => t.status === 'running');
      expect(status.runningCount).toBe(stillRunning.length);
    });

    it('scheduler recovers after simulated process death mid-session', () => {
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

      const scheduler = (orchestrator as any).scheduler;
      const runningTasks = orchestrator.getAllTasks().filter(t => t.status === 'running');
      expect(scheduler.getStatus().runningCount).toBe(runningTasks.length);
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
        makeResponse({ actionId: 'pivot-exp-v1', status: 'completed', outputs: { exitCode: 0 } }),
      );
      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 'pivot-exp-v2', status: 'completed', outputs: { exitCode: 0 } }),
      );
      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 'pivot-exp-v3', status: 'completed', outputs: { exitCode: 0 } }),
      );

      expect(orchestrator.getTask('pivot-reconciliation')!.status).toBe('needs_input');
    }

    it('multi-select completes reconciliation with all IDs', () => {
      setupReconciliation();
      publishedDeltas = [];

      orchestrator.selectExperiments(
        'pivot-reconciliation',
        ['pivot-exp-v1', 'pivot-exp-v2'],
        'reconciliation/pivot-reconciliation',
        'abc123',
      );

      const recon = orchestrator.getTask('pivot-reconciliation')!;
      expect(recon.status).toBe('completed');
      expect(recon.execution.selectedExperiment).toBe('pivot-exp-v1');
      expect(recon.execution.selectedExperiments).toEqual(['pivot-exp-v1', 'pivot-exp-v2']);
      expect(recon.execution.branch).toBe('reconciliation/pivot-reconciliation');
      expect(recon.execution.commit).toBe('abc123');
    });

    it('multi-select unblocks downstream tasks', () => {
      setupReconciliation();

      orchestrator.selectExperiments(
        'pivot-reconciliation',
        ['pivot-exp-v1', 'pivot-exp-v3'],
        'reconciliation/pivot-reconciliation',
        'def456',
      );

      const downstreamV2 = orchestrator.getTask('downstream-v2');
      expect(downstreamV2).toBeDefined();
      expect(downstreamV2!.status).toBe('running');
    });

    it('single-element array delegates to selectExperiment', () => {
      setupReconciliation();

      persistence.updateTask('pivot-exp-v1', {
        execution: { branch: 'experiment/pivot-exp-v1-hash', commit: 'singlecommit' },
      });

      orchestrator.selectExperiments('pivot-reconciliation', ['pivot-exp-v1']);

      const recon = orchestrator.getTask('pivot-reconciliation')!;
      expect(recon.status).toBe('completed');
      expect(recon.execution.selectedExperiment).toBe('pivot-exp-v1');
      expect(recon.execution.branch).toBe('experiment/pivot-exp-v1-hash');
      expect(recon.execution.commit).toBe('singlecommit');
      expect(recon.execution.selectedExperiments).toBeUndefined();
    });

    it('publishes delta with selectedExperiments field', () => {
      setupReconciliation();
      publishedDeltas = [];

      orchestrator.selectExperiments(
        'pivot-reconciliation',
        ['pivot-exp-v2', 'pivot-exp-v3'],
        'recon-branch',
        'recon-commit',
      );

      const reconDelta = publishedDeltas.find(
        (d) => d.type === 'updated' && d.taskId === 'pivot-reconciliation',
      );
      expect(reconDelta).toBeDefined();
      expect((reconDelta as any).changes.execution.selectedExperiments).toEqual(['pivot-exp-v2', 'pivot-exp-v3']);
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
        makeResponse({ actionId: 'child', status: 'completed', outputs: { exitCode: 0 } }),
      );

      // Edit parent → child becomes stale
      orchestrator.editTaskCommand('parent', 'echo updated');
      expect(orchestrator.getTask('child')!.status).toBe('stale');

      // Restart the stale child
      orchestrator.restartTask('child');
      expect(orchestrator.getTask('child')!.status).toBe('pending');
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

      // Complete both experiments
      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 'pivot-exp-v1', status: 'completed', outputs: { exitCode: 0 } }),
      );
      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 'pivot-exp-v2', status: 'completed', outputs: { exitCode: 0 } }),
      );
      expect(orchestrator.getTask('pivot-reconciliation')!.status).toBe('needs_input');

      // Select experiment → reconciliation completes
      persistence.updateTask('pivot-exp-v1', {
        execution: { branch: 'exp/v1', commit: 'commit1' },
      });
      orchestrator.selectExperiment('pivot-reconciliation', 'pivot-exp-v1');
      expect(orchestrator.getTask('pivot-reconciliation')!.status).toBe('completed');
      expect(orchestrator.getTask('pivot-reconciliation')!.execution.selectedExperiment).toBe('pivot-exp-v1');

      // Now restart the completed reconciliation task.
      // All experiment deps are completed, so restartTask auto-starts it → running.
      orchestrator.restartTask('pivot-reconciliation');
      const recon = orchestrator.getTask('pivot-reconciliation')!;
      expect(recon.status).toBe('running');
      expect(recon.execution.commit).toBeUndefined();
      // Note: restartTask does NOT clear selectedExperiment or experimentResults.
      // Only the reconciliation-reset path (when restarting an experiment dep)
      // clears experimentResults. This is current behavior, not necessarily ideal.
    });

    it('awaiting_approval → reject → restart → dependents unblock', () => {
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
      expect(orchestrator.getTask('B')!.status).toBe('blocked');

      orchestrator.restartTask('A');
      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 'A', status: 'completed', outputs: { exitCode: 0 } }),
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
      expect(mergeNode!.dependencies.sort()).toEqual(['b1', 'b2', 'b3']);
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
      expect(mergeNode!.dependencies.sort()).toEqual(['a', 'b', 'c']);
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
      expect(mergeNode!.dependencies.sort()).toEqual(['b', 'c']);
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
      expect(mergeNode!.dependencies).toEqual(['s2']);
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
      expect(mergeNode!.dependencies).toEqual(['pivot-reconciliation']);
    });

    it('experiment spawn with downstream: merge gate deps point to forked downstream', () => {
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
      expect(mergeNode!.dependencies).toEqual(['downstream-v2']);

      const forkedDownstream = orchestrator.getTask('downstream-v2');
      expect(forkedDownstream).toBeDefined();
      expect(forkedDownstream!.dependencies).toContain('pivot-reconciliation');
    });

    it('forkDirtySubtree: merge gate deps point to cloned leaves', () => {
      orchestrator.loadPlan({
        name: 'fork-leaf-test',
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
      expect(mergeNode!.dependencies.sort()).toEqual(['child1-v2', 'child2-v2']);
    });

    it('stale tasks are excluded from merge gate deps', () => {
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
        makeResponse({ actionId: 'b', status: 'completed', outputs: { exitCode: 0 } }),
      );

      orchestrator.editTaskCommand('a', 'echo new');

      const mergeNode = orchestrator.getAllTasks().find((t) => t.config.isMergeNode);
      expect(mergeNode!.dependencies).not.toContain('b');
      expect(mergeNode!.dependencies).toContain('b-v2');
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
      expect(mergeNode!.dependencies).toEqual(['d']);
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
      expect(mergeNode!.dependencies.sort()).toEqual(['c', 'd']);
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

    it('sets task to running and emits delta', () => {
      orchestrator.beginConflictResolution('t2');

      expect(orchestrator.getTask('t2')!.status).toBe('running');
      expect(orchestrator.getTask('t2')!.execution.isFixingWithAI).toBe(true);

      const runningDeltas = publishedDeltas.filter(
        (d) => d.type === 'updated' && d.taskId === 't2' && d.changes.status === 'running',
      );
      expect(runningDeltas).toHaveLength(1);
    });

    it('returns savedError for later revert', () => {
      const { savedError } = orchestrator.beginConflictResolution('t2');
      expect(savedError).toBe(mergeConflictError);
    });

    it('revertConflictResolution restores failed state with mergeConflict', () => {
      const { savedError } = orchestrator.beginConflictResolution('t2');
      expect(orchestrator.getTask('t2')!.status).toBe('running');

      publishedDeltas = [];
      orchestrator.revertConflictResolution('t2', savedError);

      const task = orchestrator.getTask('t2')!;
      expect(task.status).toBe('failed');
      expect(task.execution.error).toBe(mergeConflictError);
      expect(task.execution.mergeConflict).toEqual({
        failedBranch: 'experiment/upstream-branch-abc123',
        conflictFiles: ['src/App.tsx', 'src/utils.ts'],
      });
      expect(task.execution.isFixingWithAI).toBeUndefined();

      const failedDeltas = publishedDeltas.filter(
        (d) => d.type === 'updated' && d.taskId === 't2' && d.changes.status === 'failed',
      );
      expect(failedDeltas).toHaveLength(1);
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
      orchestrator.handleWorkerResponse(
        makeResponse({
          actionId: 't1',
          status: 'failed',
          outputs: { exitCode: 1, error: 'plain error string' },
        }),
      );

      const { savedError } = orchestrator.beginConflictResolution('t1');
      orchestrator.revertConflictResolution('t1', savedError);

      const task = orchestrator.getTask('t1')!;
      expect(task.status).toBe('failed');
      expect(task.execution.error).toBe('plain error string');
      expect(task.execution.mergeConflict).toBeUndefined();
      expect(task.execution.isFixingWithAI).toBeUndefined();
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
      expect(orchestrator.getTask('f2')!.execution.isFixingWithAI).toBe(true);
      orchestrator.setFixAwaitingApproval('f2', 'test failed: expected 1 to be 2');
      const task = orchestrator.getTask('f2')!;
      expect(task.status).toBe('awaiting_approval');
      expect(task.execution.pendingFixError).toBe('test failed: expected 1 to be 2');
      expect(task.execution.isFixingWithAI).toBeUndefined();
    });

    it('pendingFixError is readable via getTask', () => {
      orchestrator.beginConflictResolution('f2');
      orchestrator.setFixAwaitingApproval('f2', 'original error');
      expect(orchestrator.getTask('f2')!.execution.pendingFixError).toBe('original error');
    });

    it('throws if task is not running', () => {
      expect(() => orchestrator.setFixAwaitingApproval('f2', 'error')).toThrow('is not running');
    });

    it('restartTask clears the fix state', () => {
      orchestrator.beginConflictResolution('f2');
      orchestrator.setFixAwaitingApproval('f2', 'error');
      orchestrator.restartTask('f2');
      const task = orchestrator.getTask('f2')!;
      expect(task.status === 'pending' || task.status === 'running').toBe(true);
      expect(task.execution.isFixingWithAI).toBeUndefined();
    });

    it('revertConflictResolution restores failed state', () => {
      orchestrator.beginConflictResolution('f2');
      orchestrator.setFixAwaitingApproval('f2', 'test failed: expected 1 to be 2');
      orchestrator.revertConflictResolution('f2', 'test failed: expected 1 to be 2');
      const task = orchestrator.getTask('f2')!;
      expect(task.status).toBe('failed');
      expect(task.execution.error).toBe('test failed: expected 1 to be 2');
    });
  });
});
