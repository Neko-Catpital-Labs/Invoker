import { describe, it, expect, beforeEach } from 'vitest';
import { Orchestrator } from '../orchestrator.js';
import type { PlanDefinition, OrchestratorPersistence, OrchestratorMessageBus } from '../orchestrator.js';
import type { TaskState, TaskDelta } from '../task-types.js';
import type { WorkResponse } from '@invoker/protocol';

// ── In-Memory Persistence Mock ──────────────────────────────

class InMemoryPersistence implements OrchestratorPersistence {
  workflows = new Map<string, { id: string; name: string; status: string }>();
  tasks = new Map<string, { workflowId: string; task: TaskState }>();
  events: Array<{ taskId: string; eventType: string; payload?: unknown }> = [];

  saveWorkflow(workflow: { id: string; name: string; status: string }): void {
    this.workflows.set(workflow.id, workflow);
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

  updateTask(taskId: string, changes: Partial<TaskState>): void {
    const entry = this.tasks.get(taskId);
    if (entry) {
      entry.task = { ...entry.task, ...changes } as TaskState;
    }
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
      expect(tasks).toHaveLength(3);

      const t1 = orchestrator.getTask('t1');
      expect(t1).toBeDefined();
      expect(t1!.dependencies).toEqual([]);
      expect(t1!.status).toBe('pending');

      const t2 = orchestrator.getTask('t2');
      expect(t2).toBeDefined();
      expect(t2!.dependencies).toEqual(['t1']);

      const t3 = orchestrator.getTask('t3');
      expect(t3).toBeDefined();
      expect(t3!.dependencies).toEqual(['t1', 't2']);
    });

    it('loadPlan passes pivot=true to createTask when specified in plan', () => {
      const plan: PlanDefinition = {
        name: 'pivot-test',
        tasks: [
          { id: 't1', description: 'Pivot task', pivot: true },
        ],
      };

      orchestrator.loadPlan(plan);

      const task = orchestrator.getTask('t1');
      expect(task).toBeDefined();
      expect(task!.pivot).toBe(true);
    });

    it('loadPlan passes experimentVariants to createTask when specified', () => {
      const variants = [
        { id: 'v1', description: 'Variant A', prompt: 'Try approach A' },
        { id: 'v2', description: 'Variant B', prompt: 'Try approach B' },
      ];
      const plan: PlanDefinition = {
        name: 'variants-test',
        tasks: [
          { id: 't1', description: 'Experiment task', experimentVariants: variants },
        ],
      };

      orchestrator.loadPlan(plan);

      const task = orchestrator.getTask('t1');
      expect(task).toBeDefined();
      expect(task!.experimentVariants).toEqual(variants);
    });

    it('loadPlan passes requiresManualApproval to createTask', () => {
      const plan: PlanDefinition = {
        name: 'approval-test',
        tasks: [
          { id: 't1', description: 'Approval task', requiresManualApproval: true },
        ],
      };

      orchestrator.loadPlan(plan);

      const task = orchestrator.getTask('t1');
      expect(task).toBeDefined();
      expect(task!.requiresManualApproval).toBe(true);
    });

    it('loadPlan passes familiarType to createTask when specified', () => {
      const plan: PlanDefinition = {
        name: 'familiar-type-test',
        tasks: [
          { id: 't1', description: 'Worktree task', familiarType: 'worktree' },
          { id: 't2', description: 'Default task' },
        ],
      };

      orchestrator.loadPlan(plan);

      const t1 = orchestrator.getTask('t1');
      expect(t1).toBeDefined();
      expect(t1!.familiarType).toBe('worktree');

      const t2 = orchestrator.getTask('t2');
      expect(t2).toBeDefined();
      expect(t2!.familiarType).toBe('worktree'); // defaults to 'worktree' for prompt tasks
    });

    it('loadPlan passes autoFix and maxFixAttempts to createTask', () => {
      const plan: PlanDefinition = {
        name: 'autofix-plan',
        tasks: [
          { id: 't1', description: 'Auto-fix task', autoFix: true, maxFixAttempts: 2 },
        ],
      };

      orchestrator.loadPlan(plan);

      const task = orchestrator.getTask('t1');
      expect(task).toBeDefined();
      expect(task!.autoFix).toBe(true);
      expect(task!.maxFixAttempts).toBe(2);
    });

    it('publishes created deltas for each task', () => {
      const plan: PlanDefinition = {
        name: 'test-plan',
        tasks: [
          { id: 't1', description: 'First' },
          { id: 't2', description: 'Second', dependencies: ['t1'] },
        ],
      };

      orchestrator.loadPlan(plan);

      expect(publishedDeltas).toHaveLength(2);
      expect(publishedDeltas[0].type).toBe('created');
      expect(publishedDeltas[1].type).toBe('created');

      const d0 = publishedDeltas[0] as { type: 'created'; task: TaskState };
      const d1 = publishedDeltas[1] as { type: 'created'; task: TaskState };
      expect(d0.task.id).toBe('t1');
      expect(d1.task.id).toBe('t2');
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

      // maxConcurrency is 3, so only 3 of 4 should start
      expect(started).toHaveLength(3);
      expect(started.every((t) => t.status === 'running')).toBe(true);

      // The 4th task should remain pending
      const allTasks = orchestrator.getAllTasks();
      const pendingTasks = allTasks.filter((t) => t.status === 'pending');
      expect(pendingTasks).toHaveLength(1);
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

      // Only t1 is ready (no deps); t2 and t3 have unmet deps
      expect(started).toHaveLength(1);
      expect(started[0].id).toBe('t1');
      expect(orchestrator.getTask('t2')!.status).toBe('pending');
      expect(orchestrator.getTask('t3')!.status).toBe('pending');
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
      // t2 and t3 should now be running (auto-started)
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
      expect(task!.inputPrompt).toBe('What directory?');
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

      // Pause via needs_input response
      orchestrator.handleWorkerResponse(
        makeResponse({
          actionId: 't1',
          status: 'needs_input',
          outputs: { summary: 'Enter path' },
        }),
      );
      expect(orchestrator.getTask('t1')!.status).toBe('needs_input');

      // Resume
      orchestrator.provideInput('t1', '/some/path');
      expect(orchestrator.getTask('t1')!.status).toBe('running');
    });
  });

  // ── approve / reject ───────────────────────────────────

  describe('approve', () => {
    it('completes task, unblocks dependents', () => {
      orchestrator.loadPlan({
        name: 'approval-test',
        tasks: [
          { id: 'a1', description: 'Approval task' },
          { id: 'a2', description: 'After approval', dependencies: ['a1'] },
        ],
      });
      orchestrator.startExecution();

      // Move a1 to awaiting_approval via the internal state machine
      const sm = (orchestrator as any).stateMachine;
      sm.requestApproval('a1');
      expect(orchestrator.getTask('a1')!.status).toBe('awaiting_approval');

      publishedDeltas = [];
      orchestrator.approve('a1');

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
      const sm = (orchestrator as any).stateMachine;
      sm.requestApproval('t1');
      expect(orchestrator.getTask('t1')!.status).toBe('awaiting_approval');

      orchestrator.reject('t1', 'Not good enough');

      expect(orchestrator.getTask('t1')!.status).toBe('failed');
      expect(orchestrator.getTask('t2')!.status).toBe('blocked');
    });
  });

  // ── Experiment Completion Wiring ────────────────────────

  describe('experiment completion wiring', () => {
    it('handleWorkerResponse for experiment task calls onExperimentCompleted', () => {
      // Set up a pivot task with a downstream dependent
      orchestrator.loadPlan({
        name: 'experiment-test',
        tasks: [
          { id: 'pivot', description: 'Pivot task' },
          { id: 'downstream', description: 'After pivot', dependencies: ['pivot'] },
        ],
      });
      orchestrator.startExecution();

      // Spawn experiments from the pivot task
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

      // Experiments should exist and be auto-started by handleWorkerResponse
      expect(orchestrator.getTask('pivot-exp-v1')).toBeDefined();
      expect(orchestrator.getTask('pivot-exp-v2')).toBeDefined();

      // Experiments are auto-started via readyTasks in handleWorkerResponse
      expect(orchestrator.getTask('pivot-exp-v1')!.status).toBe('running');
      expect(orchestrator.getTask('pivot-exp-v2')!.status).toBe('running');

      // Complete one experiment — the experiment manager should track it
      orchestrator.handleWorkerResponse(
        makeResponse({
          actionId: 'pivot-exp-v1',
          status: 'completed',
          outputs: { exitCode: 0 },
        }),
      );

      // The experiment manager should have recorded this completion
      const em = (orchestrator as any).experimentManager;
      const groups = em.getAllGroups();
      expect(groups.length).toBe(1);
      expect(groups[0].completedExperiments.has('pivot-exp-v1')).toBe(true);
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

      // Spawn experiments
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

      // Start and complete both experiments
      orchestrator.startExecution();

      orchestrator.handleWorkerResponse(
        makeResponse({
          actionId: 'pivot-exp-v1',
          status: 'completed',
          outputs: { exitCode: 0 },
        }),
      );

      // Start v2 if not already running (scheduler may have started it)
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

      // Reconciliation task should now be in needs_input state
      const reconTask = orchestrator.getTask('pivot-reconciliation');
      expect(reconTask).toBeDefined();
      expect(reconTask!.status).toBe('needs_input');
      expect(reconTask!.experimentResults).toBeDefined();
      expect(reconTask!.experimentResults!.length).toBe(2);
    });

    it('failed experiment still counts toward completion tracking', () => {
      orchestrator.loadPlan({
        name: 'fail-test',
        tasks: [
          { id: 'pivot', description: 'Pivot task' },
        ],
      });
      orchestrator.startExecution();

      // Spawn experiments
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

      // Start experiments
      orchestrator.startExecution();

      // Fail experiment v1
      orchestrator.handleWorkerResponse(
        makeResponse({
          actionId: 'pivot-exp-v1',
          status: 'failed',
          outputs: { exitCode: 1, error: 'build failed' },
        }),
      );

      // Start v2 if blocked by scheduler
      if (orchestrator.getTask('pivot-exp-v2')!.status === 'pending') {
        orchestrator.startExecution();
      }

      // Complete experiment v2
      orchestrator.handleWorkerResponse(
        makeResponse({
          actionId: 'pivot-exp-v2',
          status: 'completed',
          outputs: { exitCode: 0 },
        }),
      );

      // Reconciliation should still trigger despite one failure
      const reconTask = orchestrator.getTask('pivot-reconciliation');
      expect(reconTask).toBeDefined();
      expect(reconTask!.status).toBe('needs_input');
      expect(reconTask!.experimentResults).toBeDefined();

      // Verify both results are recorded (one completed, one failed)
      const results = reconTask!.experimentResults!;
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
        tasks: [
          { id: 't1', description: 'Normal task' },
        ],
      });
      orchestrator.startExecution();

      // Complete a regular (non-experiment) task — should not throw
      expect(() => {
        orchestrator.handleWorkerResponse(
          makeResponse({
            actionId: 't1',
            status: 'completed',
            outputs: { exitCode: 0 },
          }),
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
          completedAt: new Date(),
          exitCode: 0,
        },
        {
          id: 't2',
          description: 'Pending task with completed dep',
          status: 'pending',
          dependencies: ['t1'],
          createdAt: new Date(),
        },
      ];
      hydratePersistence.loadTasks = (_workflowId: string) => storedTasks;

      const hydrateOrchestrator = new Orchestrator({
        persistence: hydratePersistence,
        messageBus: bus,
        maxConcurrency: 3,
      });

      hydrateOrchestrator.syncFromDb('wf-hydrate');

      expect(hydrateOrchestrator.getAllTasks()).toHaveLength(2);
      expect(hydrateOrchestrator.getTask('t1')!.status).toBe('completed');
      // Key difference from resumeWorkflow: t2 stays pending, not auto-started
      expect(hydrateOrchestrator.getTask('t2')!.status).toBe('pending');
    });

    it('preserves running task status from DB', () => {
      const hydratePersistence = new InMemoryPersistence();
      const startedAt = new Date();
      const storedTasks: TaskState[] = [
        {
          id: 't1',
          description: 'Currently running task',
          status: 'running',
          dependencies: [],
          createdAt: new Date(),
          startedAt,
        },
      ];
      hydratePersistence.loadTasks = (_workflowId: string) => storedTasks;

      const hydrateOrchestrator = new Orchestrator({
        persistence: hydratePersistence,
        messageBus: bus,
        maxConcurrency: 3,
      });

      hydrateOrchestrator.syncFromDb('wf-hydrate');

      const task = hydrateOrchestrator.getTask('t1')!;
      expect(task.status).toBe('running');
      expect(task.startedAt).toBe(startedAt);
    });

    it('restartTask recovers a stuck running task after syncFromDb', () => {
      const hydratePersistence = new InMemoryPersistence();
      const storedTasks: TaskState[] = [
        {
          id: 't1',
          description: 'Stuck running task from a crash',
          status: 'running',
          dependencies: [],
          createdAt: new Date(),
          startedAt: new Date(),
        },
      ];
      hydratePersistence.loadTasks = (_workflowId: string) => storedTasks;

      const hydrateBus = new InMemoryBus();
      const hydrateOrchestrator = new Orchestrator({
        persistence: hydratePersistence,
        messageBus: hydrateBus,
        maxConcurrency: 3,
      });

      hydrateOrchestrator.syncFromDb('wf-hydrate');
      const started = hydrateOrchestrator.restartTask('t1');

      expect(started).toHaveLength(1);
      expect(started[0].status).toBe('running');
    });

    it('restartTask works on failed tasks after syncFromDb', () => {
      const hydratePersistence = new InMemoryPersistence();
      const storedTasks: TaskState[] = [
        {
          id: 't1',
          description: 'Failed task',
          status: 'failed',
          dependencies: [],
          createdAt: new Date(),
          error: 'something broke',
        },
      ];
      hydratePersistence.loadTasks = (_workflowId: string) => storedTasks;

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

      // Task should be restarted (no deps, so auto-started to running)
      expect(started).toHaveLength(1);
      expect(started[0].status).toBe('running');
      // Delta should have been published
      expect(deltas.length).toBeGreaterThan(0);
    });

    it('re-syncing with a different workflow replaces state machine contents', () => {
      const hydratePersistence = new InMemoryPersistence();
      const workflowATasks: TaskState[] = [
        {
          id: 'a1',
          description: 'Task from workflow A',
          status: 'completed',
          dependencies: [],
          createdAt: new Date(),
        },
      ];
      const workflowBTasks: TaskState[] = [
        {
          id: 'b1',
          description: 'Failed task from workflow B',
          status: 'failed',
          dependencies: [],
          createdAt: new Date(),
          error: 'something broke',
        },
      ];

      const hydrateBus = new InMemoryBus();
      const hydrateOrchestrator = new Orchestrator({
        persistence: hydratePersistence,
        messageBus: hydrateBus,
        maxConcurrency: 3,
      });

      // Sync with workflow A
      hydratePersistence.loadTasks = () => workflowATasks;
      hydrateOrchestrator.syncFromDb('wf-a');
      expect(hydrateOrchestrator.getTask('a1')!.status).toBe('completed');

      // Re-sync with workflow B (simulates DB poll detecting external workflow)
      hydratePersistence.loadTasks = () => workflowBTasks;
      hydrateOrchestrator.syncFromDb('wf-b');

      // restartTask should work on the new workflow's tasks
      const started = hydrateOrchestrator.restartTask('b1');
      expect(started).toHaveLength(1);
      expect(started[0].status).toBe('running');
      expect(hydrateOrchestrator.getTask('b1')).toBeDefined();
    });

    it('approve works after syncFromDb', () => {
      const hydratePersistence = new InMemoryPersistence();
      const storedTasks: TaskState[] = [
        {
          id: 't1',
          description: 'Awaiting approval',
          status: 'awaiting_approval',
          dependencies: [],
          createdAt: new Date(),
        },
      ];
      hydratePersistence.loadTasks = (_workflowId: string) => storedTasks;

      const hydrateOrchestrator = new Orchestrator({
        persistence: hydratePersistence,
        messageBus: bus,
        maxConcurrency: 3,
      });

      hydrateOrchestrator.syncFromDb('wf-hydrate');
      hydrateOrchestrator.approve('t1');

      expect(hydrateOrchestrator.getTask('t1')!.status).toBe('completed');
    });

    it('throws when persistence does not support loadTasks', () => {
      expect(() => orchestrator.syncFromDb('wf-1')).toThrow(
        'Persistence adapter does not support loading tasks',
      );
    });
  });

  // ── resumeWorkflow ──────────────────────────────────────

  describe('resumeWorkflow', () => {
    it('restores task state from persistence', () => {
      // Create a persistence mock that supports loadTasks
      const resumePersistence = new InMemoryPersistence();
      const storedTasks: TaskState[] = [
        {
          id: 't1',
          description: 'Completed task',
          status: 'completed',
          dependencies: [],
          createdAt: new Date(),
          completedAt: new Date(),
          exitCode: 0,
        },
        {
          id: 't2',
          description: 'Pending task',
          status: 'pending',
          dependencies: ['t1'],
          createdAt: new Date(),
        },
      ];
      resumePersistence.loadTasks = (_workflowId: string) => storedTasks;

      const resumeOrchestrator = new Orchestrator({
        persistence: resumePersistence,
        messageBus: bus,
        maxConcurrency: 3,
      });

      resumeOrchestrator.resumeWorkflow('wf-resume');

      // Both tasks should be restored
      expect(resumeOrchestrator.getAllTasks()).toHaveLength(2);
      expect(resumeOrchestrator.getTask('t1')!.status).toBe('completed');
      // t2 was pending with completed deps, so startExecution should start it
      expect(resumeOrchestrator.getTask('t2')!.status).toBe('running');
    });

    it('resumed workflow can continue executing pending tasks', () => {
      const resumePersistence = new InMemoryPersistence();
      const storedTasks: TaskState[] = [
        {
          id: 't1',
          description: 'Already done',
          status: 'completed',
          dependencies: [],
          createdAt: new Date(),
          completedAt: new Date(),
        },
        {
          id: 't2',
          description: 'Ready to run',
          status: 'pending',
          dependencies: ['t1'],
          createdAt: new Date(),
        },
        {
          id: 't3',
          description: 'Blocked by t2',
          status: 'pending',
          dependencies: ['t2'],
          createdAt: new Date(),
        },
      ];
      resumePersistence.loadTasks = (_workflowId: string) => storedTasks;

      const resumeOrchestrator = new Orchestrator({
        persistence: resumePersistence,
        messageBus: bus,
        maxConcurrency: 3,
      });

      const started = resumeOrchestrator.resumeWorkflow('wf-resume');

      // t2 should have been started (its dep t1 is completed)
      expect(started).toHaveLength(1);
      expect(started[0].id).toBe('t2');
      expect(started[0].status).toBe('running');

      // t3 should remain pending (t2 not yet completed)
      expect(resumeOrchestrator.getTask('t3')!.status).toBe('pending');

      // Complete t2, t3 should auto-start
      resumeOrchestrator.handleWorkerResponse(
        makeResponse({ actionId: 't2', status: 'completed', outputs: { exitCode: 0 } }),
      );
      expect(resumeOrchestrator.getTask('t3')!.status).toBe('running');
    });

    it('preserves running tasks and only starts pending ones', () => {
      const resumePersistence = new InMemoryPersistence();
      const storedTasks: TaskState[] = [
        {
          id: 't1',
          description: 'Was running when process died',
          status: 'running',
          dependencies: [],
          createdAt: new Date(),
          startedAt: new Date(),
        },
      ];
      resumePersistence.loadTasks = (_workflowId: string) => storedTasks;

      const resumeOrchestrator = new Orchestrator({
        persistence: resumePersistence,
        messageBus: bus,
        maxConcurrency: 3,
      });

      const started = resumeOrchestrator.resumeWorkflow('wf-resume');

      // The task stays running (startExecution only picks up pending tasks).
      // User can manually restart stuck tasks via restartTask.
      expect(started).toHaveLength(0);
      expect(resumeOrchestrator.getTask('t1')!.status).toBe('running');
    });

    it('throws when persistence does not support loadTasks', () => {
      // The default InMemoryPersistence has no loadTasks method
      expect(() => orchestrator.resumeWorkflow('wf-1')).toThrow(
        'Persistence adapter does not support loading tasks',
      );
    });
  });

  // ── Auto-Fix (Option C) ────────────────────────────────

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

      // Fail the autoFix task
      const started = orchestrator.handleWorkerResponse(
        makeResponse({
          actionId: 't1',
          status: 'failed',
          outputs: { exitCode: 1, error: 'compilation error' },
        }),
      );

      // Should NOT be in failed state — it got transformed to spawn_experiments
      const t1 = orchestrator.getTask('t1');
      expect(t1!.status).toBe('completed'); // completed so experiments can depend on it

      // Fix experiments should exist
      const fixConservative = orchestrator.getTask('t1-exp-fix-conservative');
      const fixRefactor = orchestrator.getTask('t1-exp-fix-refactor');
      expect(fixConservative).toBeDefined();
      expect(fixRefactor).toBeDefined();

      // maxFixAttempts=2 so only 2 variants
      const fixAlternative = orchestrator.getTask('t1-exp-fix-alternative');
      expect(fixAlternative).toBeUndefined();

      // Experiments should be auto-started
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

      // Fail → spawns experiments
      orchestrator.handleWorkerResponse(
        makeResponse({
          actionId: 't1',
          status: 'failed',
          outputs: { exitCode: 1, error: 'type error' },
        }),
      );

      // Complete both fix experiments
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

      // Reconciliation task should be in needs_input
      const reconTask = orchestrator.getTask('t1-reconciliation');
      expect(reconTask).toBeDefined();
      expect(reconTask!.status).toBe('needs_input');
      expect(reconTask!.experimentResults).toHaveLength(2);

      // Select the conservative fix
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
        makeResponse({
          actionId: 't1',
          status: 'failed',
          outputs: { exitCode: 1, error: 'broke' },
        }),
      );

      expect(orchestrator.getTask('t1')!.status).toBe('failed');
      expect(orchestrator.getTask('t2')!.status).toBe('blocked');
    });

    it('fix experiment prompts include original error message', () => {
      orchestrator.loadPlan({
        name: 'autofix-prompt-test',
        tasks: [
          { id: 't1', description: 'Build widgets', autoFix: true, prompt: 'npm run build' },
        ],
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
      expect(fixTask!.prompt).toContain('ModuleNotFoundError: xyz');
      expect(fixTask!.prompt).toContain('Build widgets');
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

      // Start: only t1 is ready
      const started = orchestrator.startExecution();
      expect(started).toHaveLength(1);
      expect(started[0].id).toBe('t1');

      // Complete t1: t2 should auto-start
      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 't1', status: 'completed', outputs: { exitCode: 0 } }),
      );
      expect(orchestrator.getTask('t1')!.status).toBe('completed');
      expect(orchestrator.getTask('t2')!.status).toBe('running');

      // Complete t2: t3 should auto-start
      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 't2', status: 'completed', outputs: { exitCode: 0 } }),
      );
      expect(orchestrator.getTask('t2')!.status).toBe('completed');
      expect(orchestrator.getTask('t3')!.status).toBe('running');

      // Complete t3: workflow done
      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 't3', status: 'completed', outputs: { exitCode: 0 } }),
      );
      expect(orchestrator.getTask('t3')!.status).toBe('completed');

      const status = orchestrator.getWorkflowStatus();
      expect(status.total).toBe(3);
      expect(status.completed).toBe(3);
      expect(status.failed).toBe(0);
      expect(status.running).toBe(0);
      expect(status.pending).toBe(0);
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

    it('logs workflow.completed event', () => {
      orchestrator.loadPlan({
        name: 'event-test',
        tasks: [{ id: 't1', description: 'Task 1' }],
      });
      orchestrator.startExecution();

      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 't1', status: 'completed', outputs: { exitCode: 0 } }),
      );

      const wfEvents = persistence.events.filter((e) => e.eventType === 'workflow.completed');
      expect(wfEvents).toHaveLength(1);
      expect(wfEvents[0].taskId).toBe('__workflow__');
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

  // (Hydration Timestamp Clearing tests removed — syncFromDb no longer resets running tasks)

  // ── editTaskCommand ────────────────────────────────────

  describe('editTaskCommand', () => {
    it('updates command, restarts the task, and publishes deltas', () => {
      const plan: PlanDefinition = {
        name: 'edit-cmd-test',
        tasks: [
          { id: 't1', description: 'Task 1', command: 'echo old' },
        ],
      };
      orchestrator.loadPlan(plan);
      orchestrator.startExecution();

      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 't1', status: 'failed', outputs: { exitCode: 1, error: 'fail' } }),
      );
      expect(orchestrator.getTask('t1')?.status).toBe('failed');

      const started = orchestrator.editTaskCommand('t1', 'echo new');
      const task = orchestrator.getTask('t1');
      expect(task?.command).toBe('echo new');
      expect(task?.status).toBe('running');
      expect(started).toHaveLength(1);
      expect(started[0].id).toBe('t1');
    });

    it('forks dirty subtree when editing a completed task with dependents', () => {
      const plan: PlanDefinition = {
        name: 'edit-fork-test',
        tasks: [
          { id: 'parent', description: 'Parent', command: 'echo parent' },
          { id: 'child', description: 'Child', command: 'echo child', dependencies: ['parent'] },
        ],
      };
      orchestrator.loadPlan(plan);
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

      expect(orchestrator.getTask('parent')?.command).toBe('echo updated');
      expect(orchestrator.getTask('parent')?.status).toBe('running');

      expect(orchestrator.getTask('child')?.status).toBe('stale');

      const allTasks = orchestrator.getAllTasks();
      const forkedChild = allTasks.find(t => t.id !== 'child' && t.description === 'Child');
      expect(forkedChild).toBeDefined();
      expect(forkedChild?.status).toBe('pending');
    });

    it('throws when trying to edit a running task', () => {
      const plan: PlanDefinition = {
        name: 'edit-running-test',
        tasks: [
          { id: 't1', description: 'Task 1', command: 'sleep 100' },
        ],
      };
      orchestrator.loadPlan(plan);
      orchestrator.startExecution();

      expect(() => orchestrator.editTaskCommand('t1', 'echo new')).toThrow();
    });

    it('persists the updated command', () => {
      const plan: PlanDefinition = {
        name: 'edit-persist-test',
        tasks: [
          { id: 't1', description: 'Task 1', command: 'echo old' },
        ],
      };
      orchestrator.loadPlan(plan);
      orchestrator.startExecution();

      orchestrator.handleWorkerResponse(
        makeResponse({ actionId: 't1', status: 'failed', outputs: { exitCode: 1, error: 'oops' } }),
      );

      orchestrator.editTaskCommand('t1', 'echo fixed');

      const persisted = persistence.tasks.get('t1');
      expect(persisted).toBeDefined();
      expect(persisted?.task.command).toBe('echo fixed');
    });
  });

  // ── Scheduler queue drain ──────────────────────────────

  describe('scheduler queue drain', () => {
    it('starts queued tasks when a slot opens even if no new tasks become ready', () => {
      const plan: PlanDefinition = {
        name: 'drain-test',
        tasks: [
          { id: 'a', description: 'Task A' },
          { id: 'b', description: 'Task B' },
          { id: 'c', description: 'Task C' },
          { id: 'd', description: 'Task D' },
          { id: 'e', description: 'Task E' },
        ],
      };

      orchestrator.loadPlan(plan);

      // maxConcurrency=3, so only 3 of 5 ready tasks should start
      const started = orchestrator.startExecution();
      expect(started).toHaveLength(3);

      const running = orchestrator.getAllTasks().filter((t) => t.status === 'running');
      const pending = orchestrator.getAllTasks().filter((t) => t.status === 'pending');
      expect(running).toHaveLength(3);
      expect(pending).toHaveLength(2);

      // Complete one task — no new dependencies are unblocked, but queued tasks should drain
      const firstRunning = running[0];
      const newlyStarted = orchestrator.handleWorkerResponse(
        makeResponse({ actionId: firstRunning.id, status: 'completed', outputs: { exitCode: 0 } }),
      );

      expect(newlyStarted).toHaveLength(1);
      expect(orchestrator.getAllTasks().filter((t) => t.status === 'running')).toHaveLength(3);
      expect(orchestrator.getAllTasks().filter((t) => t.status === 'pending')).toHaveLength(1);

      // Complete another — last queued task should start
      const secondRunning = orchestrator.getAllTasks().filter((t) => t.status === 'running')[0];
      const lastStarted = orchestrator.handleWorkerResponse(
        makeResponse({ actionId: secondRunning.id, status: 'completed', outputs: { exitCode: 0 } }),
      );

      expect(lastStarted).toHaveLength(1);
      expect(orchestrator.getAllTasks().filter((t) => t.status === 'pending')).toHaveLength(0);
    });
  });
});
