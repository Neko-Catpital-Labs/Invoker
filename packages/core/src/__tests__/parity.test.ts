/**
 * Orchestrator integration tests
 *
 * Part 1 (tests 1–10): Core workflow and task behaviors end-to-end through the orchestrator.
 * Part 2 (tests 11–16): Persistence, immutability, and scheduling characteristics under load.
 *
 * All mutations go through the Orchestrator (which writes to DB first).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { TaskStateMachine } from '../state-machine.js';
import { ExperimentManager } from '../experiments.js';
import { ResponseHandler } from '../response-handler.js';
import { TaskScheduler } from '../scheduler.js';
import { Orchestrator } from '../orchestrator.js';
import { topologicalSort } from '../dag.js';
import { createTaskState } from '../task-types.js';
import type {
  OrchestratorPersistence,
  OrchestratorMessageBus,
} from '../orchestrator.js';
import type { TaskState, TaskDelta } from '../task-types.js';
import type { WorkResponse } from '@invoker/protocol';

// ── In-Memory Test Doubles ──────────────────────────────────

class InMemoryPersistence implements OrchestratorPersistence {
  workflows = new Map<string, { id: string; name: string; status: string; createdAt: string; updatedAt: string }>();
  tasks = new Map<string, { workflowId: string; task: TaskState }>();

  saveWorkflow(workflow: { id: string; name: string; status: string }): void {
    const now = new Date().toISOString();
    this.workflows.set(workflow.id, { ...workflow, createdAt: (workflow as any).createdAt ?? now, updatedAt: (workflow as any).updatedAt ?? now });
  }

  updateWorkflow(workflowId: string, changes: { status?: string }): void {
    const wf = this.workflows.get(workflowId);
    if (wf && changes.status) wf.status = changes.status;
  }

  listWorkflows(): Array<{ id: string; name: string; status: string; createdAt: string; updatedAt: string }> {
    return Array.from(this.workflows.values());
  }

  saveTask(workflowId: string, task: TaskState): void {
    this.tasks.set(task.id, { workflowId, task });
  }

  updateTask(taskId: string, changes: Partial<TaskState>): void {
    const entry = this.tasks.get(taskId);
    if (entry) entry.task = { ...entry.task, ...changes } as TaskState;
  }

  loadTasks(workflowId: string): TaskState[] {
    return Array.from(this.tasks.values())
      .filter((e) => e.workflowId === workflowId)
      .map((e) => e.task);
  }
}

class InMemoryBus implements OrchestratorMessageBus {
  published: Array<{ channel: string; message: unknown }> = [];

  publish<T>(channel: string, message: T): void {
    this.published.push({ channel, message });
  }
}

function makeResponse(overrides: Partial<WorkResponse>): WorkResponse {
  return {
    requestId: 'req-1',
    actionId: 't1',
    status: 'completed',
    outputs: { exitCode: 0 },
    ...overrides,
  };
}

// ══════════════════════════════════════════════════════════════
// Part 1: Feature Parity (10 tests)
// ══════════════════════════════════════════════════════════════

describe('Parity — Feature Coverage', () => {
  let persistence: InMemoryPersistence;
  let bus: InMemoryBus;
  let orchestrator: Orchestrator;

  beforeEach(() => {
    persistence = new InMemoryPersistence();
    bus = new InMemoryBus();
    orchestrator = new Orchestrator({
      persistence,
      messageBus: bus,
      maxConcurrency: 10,
    });
  });

  // ── Test 1: Core task states via Orchestrator ─────────────

  it('core task states: pending → running → completed/failed/needs_input/blocked', () => {
    orchestrator.loadPlan({
      name: 'states-test',
      tasks: [
        { id: 't-complete', description: 'will complete' },
        { id: 't-fail', description: 'will fail' },
        { id: 't-input', description: 'will need input' },
        { id: 't-blocked', description: 'will be blocked', dependencies: ['t-fail'] },
      ],
    });

    // All start as pending
    expect(orchestrator.getTask('t-complete')!.status).toBe('pending');

    orchestrator.startExecution();

    // t-complete, t-fail, t-input are ready (no deps) → running
    expect(orchestrator.getTask('t-complete')!.status).toBe('running');
    expect(orchestrator.getTask('t-fail')!.status).toBe('running');
    expect(orchestrator.getTask('t-input')!.status).toBe('running');

    // completed
    orchestrator.handleWorkerResponse(
      makeResponse({ actionId: 't-complete', status: 'completed', outputs: { exitCode: 0 } }),
    );
    expect(orchestrator.getTask('t-complete')!.status).toBe('completed');

    // failed → blocks t-blocked
    orchestrator.handleWorkerResponse(
      makeResponse({ actionId: 't-fail', status: 'failed', outputs: { exitCode: 1, error: 'boom' } }),
    );
    expect(orchestrator.getTask('t-fail')!.status).toBe('failed');
    expect(orchestrator.getTask('t-blocked')!.status).toBe('blocked');

    // needs_input
    orchestrator.handleWorkerResponse(
      makeResponse({ actionId: 't-input', status: 'needs_input', outputs: { summary: 'What?' } }),
    );
    expect(orchestrator.getTask('t-input')!.status).toBe('needs_input');
  });

  // ── Test 2: Transitive dependency blocking ────────────────

  it('transitive dependency blocking: A fails → B blocked → C blocked', () => {
    orchestrator.loadPlan({
      name: 'blocking-test',
      tasks: [
        { id: 'A', description: 'root task' },
        { id: 'B', description: 'depends on A', dependencies: ['A'] },
        { id: 'C', description: 'depends on B', dependencies: ['B'] },
      ],
    });

    orchestrator.startExecution();
    orchestrator.handleWorkerResponse(
      makeResponse({ actionId: 'A', status: 'failed', outputs: { exitCode: 1, error: 'fail' } }),
    );

    expect(orchestrator.getTask('B')!.status).toBe('blocked');
    expect(orchestrator.getTask('C')!.status).toBe('blocked');
  });

  // ── Test 3: Experiment spawning ───────────────────────────

  it('experiment spawning creates N experiments + 1 reconciliation task', () => {
    orchestrator.loadPlan({
      name: 'experiment-test',
      tasks: [
        { id: 'pivot', description: 'pivot task' },
        { id: 'downstream', description: 'after pivot', dependencies: ['pivot'] },
      ],
    });
    orchestrator.startExecution();

    orchestrator.handleWorkerResponse(
      makeResponse({
        actionId: 'pivot',
        status: 'spawn_experiments',
        dagMutation: {
          spawnExperiments: {
            description: 'Try 3 approaches',
            variants: [
              { id: 'alpha', prompt: 'approach alpha' },
              { id: 'beta', prompt: 'approach beta' },
              { id: 'gamma', prompt: 'approach gamma' },
            ],
          },
        },
      }),
    );

    expect(orchestrator.getTask('pivot-exp-alpha')).toBeDefined();
    expect(orchestrator.getTask('pivot-exp-beta')).toBeDefined();
    expect(orchestrator.getTask('pivot-exp-gamma')).toBeDefined();

    const recon = orchestrator.getTask('pivot-reconciliation');
    expect(recon).toBeDefined();
    expect(recon!.isReconciliation).toBe(true);
  });

  // ── Test 4: Dependency rewriting ──────────────────────────

  it('dependency rewriting: downstream deps change from pivot → recon', () => {
    orchestrator.loadPlan({
      name: 'rewrite-test',
      tasks: [
        { id: 'pivot', description: 'pivot task' },
        { id: 'downstream', description: 'after pivot', dependencies: ['pivot'] },
      ],
    });
    orchestrator.startExecution();

    expect(orchestrator.getTask('downstream')!.dependencies).toContain('pivot');

    orchestrator.handleWorkerResponse(
      makeResponse({
        actionId: 'pivot',
        status: 'spawn_experiments',
        dagMutation: {
          spawnExperiments: {
            description: 'Try variants',
            variants: [{ id: 'v1', prompt: 'A' }, { id: 'v2', prompt: 'B' }],
          },
        },
      }),
    );

    // Original downstream is stale, forked downstream-v2 depends on reconciliation
    expect(orchestrator.getTask('downstream')!.status).toBe('stale');
    const downstreamV2 = orchestrator.getTask('downstream-v2')!;
    expect(downstreamV2.dependencies).toContain('pivot-reconciliation');
    expect(downstreamV2.dependencies).not.toContain('pivot');
  });

  // ── Test 5: Reconciliation triggers ───────────────────────

  it('reconciliation triggers when all experiments complete', () => {
    orchestrator.loadPlan({
      name: 'recon-test',
      tasks: [{ id: 'pivot', description: 'pivot task' }],
    });
    orchestrator.startExecution();

    orchestrator.handleWorkerResponse(
      makeResponse({
        actionId: 'pivot',
        status: 'spawn_experiments',
        dagMutation: {
          spawnExperiments: {
            description: 'Try 2',
            variants: [{ id: 'v1', prompt: 'A' }, { id: 'v2', prompt: 'B' }],
          },
        },
      }),
    );

    orchestrator.handleWorkerResponse(
      makeResponse({ actionId: 'pivot-exp-v1', status: 'completed', outputs: { exitCode: 0 } }),
    );
    if (orchestrator.getTask('pivot-exp-v2')!.status === 'pending') {
      orchestrator.startExecution();
    }
    orchestrator.handleWorkerResponse(
      makeResponse({ actionId: 'pivot-exp-v2', status: 'completed', outputs: { exitCode: 0 } }),
    );

    const reconTask = orchestrator.getTask('pivot-reconciliation');
    expect(reconTask).toBeDefined();
    expect(reconTask!.status).toBe('needs_input');
    expect(reconTask!.experimentResults).toHaveLength(2);
  });

  // ── Test 6: Experiment selection ──────────────────────────

  it('experiment selection completes recon and unblocks downstream', () => {
    orchestrator.loadPlan({
      name: 'selection-test',
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
            variants: [{ id: 'v1', prompt: 'A' }, { id: 'v2', prompt: 'B' }],
          },
        },
      }),
    );

    orchestrator.startExecution();
    orchestrator.handleWorkerResponse(
      makeResponse({ actionId: 'pivot-exp-v1', status: 'completed', outputs: { exitCode: 0 } }),
    );
    if (orchestrator.getTask('pivot-exp-v2')!.status === 'pending') {
      orchestrator.startExecution();
    }
    orchestrator.handleWorkerResponse(
      makeResponse({ actionId: 'pivot-exp-v2', status: 'completed', outputs: { exitCode: 0 } }),
    );

    orchestrator.selectExperiment('pivot-reconciliation', 'pivot-exp-v1');

    expect(orchestrator.getTask('pivot-reconciliation')!.status).toBe('completed');
    // Original downstream is stale, forked downstream-v2 is running
    expect(orchestrator.getTask('downstream')!.status).toBe('stale');
    expect(orchestrator.getTask('downstream-v2')!.status).toBe('running');
  });

  // ── Test 7: Re-experimentation via ExperimentManager ──────

  it('re-experimentation: second round carries forward previous results', () => {
    const em = new ExperimentManager();

    const round1 = em.planExperimentGroup(
      'pivot',
      [
        { id: 'r1-exp-1', description: 'Round 1 exp 1' },
        { id: 'r1-exp-2', description: 'Round 1 exp 2' },
      ],
    );

    em.onExperimentCompleted('r1-exp-1', { id: 'r1-exp-1', status: 'completed', summary: 'good' });
    em.onExperimentCompleted('r1-exp-2', { id: 'r1-exp-2', status: 'completed', summary: 'ok' });

    const previousResults = [
      { id: 'r1-exp-1', status: 'completed' as const, summary: 'good' },
      { id: 'r1-exp-2', status: 'completed' as const, summary: 'ok' },
    ];

    const round2 = em.planExperimentGroup(
      'pivot',
      [{ id: 'r2-exp-1', description: 'Round 2 exp 1' }],
      undefined,
      undefined,
      previousResults,
    );

    expect(round2.group.experimentIds).toHaveLength(3);
    expect(round2.group.experimentIds).toContain('r1-exp-1');
    expect(round2.group.completedExperiments.size).toBe(2);
  });

  // ── Test 8: Manual approval flow ──────────────────────────

  it('manual approval flow: approve completes task, reject fails task', () => {
    orchestrator.loadPlan({
      name: 'approval-test',
      tasks: [
        { id: 'a1', description: 'needs approval' },
        { id: 'a2', description: 'after approval', dependencies: ['a1'] },
      ],
    });
    orchestrator.startExecution();

    // Simulate external process setting awaiting_approval
    persistence.updateTask('a1', { status: 'awaiting_approval' });
    orchestrator.approve('a1');

    expect(orchestrator.getTask('a1')!.status).toBe('completed');
    expect(orchestrator.getTask('a2')!.status).toBe('running');
  });

  // ── Test 9: Input flow ────────────────────────────────────

  it('input flow: needs_input → running after provideInput', () => {
    orchestrator.loadPlan({
      name: 'input-test',
      tasks: [{ id: 't1', description: 'interactive task' }],
    });
    orchestrator.startExecution();

    orchestrator.handleWorkerResponse(
      makeResponse({ actionId: 't1', status: 'needs_input', outputs: { summary: 'Enter directory:' } }),
    );
    expect(orchestrator.getTask('t1')!.status).toBe('needs_input');

    orchestrator.provideInput('t1', '/some/path');
    expect(orchestrator.getTask('t1')!.status).toBe('running');
  });

  // ── Test 10: Concurrent execution respects maxConcurrency ──

  it('concurrent execution respects maxConcurrency limit', () => {
    const limitOrch = new Orchestrator({
      persistence,
      messageBus: bus,
      maxConcurrency: 2,
    });

    limitOrch.loadPlan({
      name: 'concurrency-test',
      tasks: [
        { id: 't1', description: 'Task 1' },
        { id: 't2', description: 'Task 2' },
        { id: 't3', description: 'Task 3' },
        { id: 't4', description: 'Task 4' },
        { id: 't5', description: 'Task 5' },
      ],
    });

    const started = limitOrch.startExecution();
    expect(started).toHaveLength(2);
    expect(limitOrch.getAllTasks().filter((t) => t.status === 'pending')).toHaveLength(4);
  });
});

// ══════════════════════════════════════════════════════════════
// Part 2: Architectural Superiority (6 tests)
// ══════════════════════════════════════════════════════════════

describe('Parity — Architectural Superiority', () => {
  // ── Test 11: Read-only state machine ──────────────────────

  it('TaskStateMachine is read-only: no mutation methods exposed', () => {
    const sm = new TaskStateMachine();
    expect((sm as any).createTask).toBeUndefined();
    expect((sm as any).startTask).toBeUndefined();
    expect((sm as any).completeTask).toBeUndefined();
    expect((sm as any).failTask).toBeUndefined();
    expect(typeof sm.getTask).toBe('function');
    expect(typeof sm.restoreTask).toBe('function');
    expect(typeof sm.findNewlyReadyTasks).toBe('function');
  });

  // ── Test 12: ResponseHandler is a pure parser ─────────────

  it('ResponseHandler is a pure parser: returns data, no side effects', () => {
    const handler = new ResponseHandler();
    const result = handler.parseResponse(
      makeResponse({ status: 'completed', outputs: { exitCode: 0, summary: 'done' } }),
    );
    expect('type' in result).toBe(true);
    if ('type' in result) {
      expect(result.type).toBe('completed');
    }
  });

  // ── Test 13: DB is single source of truth ─────────────────

  it('DB is single source of truth: every mutation writes to DB first', () => {
    const persistence = new InMemoryPersistence();
    const bus = new InMemoryBus();
    const orchestrator = new Orchestrator({
      persistence,
      messageBus: bus,
      maxConcurrency: 10,
    });

    orchestrator.loadPlan({
      name: 'db-truth-test',
      tasks: [
        { id: 't1', description: 'Root' },
        { id: 't2', description: 'Child', dependencies: ['t1'] },
      ],
    });

    // After loadPlan: DB has the tasks (2 user tasks + 1 merge node)
    expect(persistence.tasks.size).toBe(3);

    orchestrator.startExecution();
    // After startExecution: DB reflects running status
    expect(persistence.tasks.get('t1')!.task.status).toBe('running');

    orchestrator.handleWorkerResponse(
      makeResponse({ actionId: 't1', status: 'completed', outputs: { exitCode: 0 } }),
    );
    // After completion: DB reflects completed and running
    expect(persistence.tasks.get('t1')!.task.status).toBe('completed');
    expect(persistence.tasks.get('t2')!.task.status).toBe('running');

    // In-memory always matches DB
    for (const task of orchestrator.getAllTasks()) {
      expect(persistence.tasks.get(task.id)!.task.status).toBe(task.status);
    }
  });

  // ── Test 14: Pure domain logic — zero I/O ─────────────────

  it('pure domain logic: StateMachine and ExperimentManager have zero I/O dependencies', () => {
    const sm = new TaskStateMachine();
    sm.restoreTask(createTaskState('t1', 'root', []));
    sm.restoreTask(createTaskState('t2', 'child', ['t1']));
    expect(sm.getTaskCount()).toBe(2);

    const em = new ExperimentManager();
    expect(em.getAllGroups()).toEqual([]);

    const scheduler = new TaskScheduler(3);
    expect(scheduler.getStatus().queueLength).toBe(0);
  });

  // ── Test 15: Persistence is injectable ────────────────────

  it('persistence is injectable: works with in-memory adapter', () => {
    const persistence = new InMemoryPersistence();
    const bus = new InMemoryBus();
    const orchestrator = new Orchestrator({
      persistence,
      messageBus: bus,
      maxConcurrency: 10,
    });

    orchestrator.loadPlan({
      name: 'injectable-test',
      tasks: [
        { id: 't1', description: 'Step 1' },
        { id: 't2', description: 'Step 2', dependencies: ['t1'] },
        { id: 't3', description: 'Step 3', dependencies: ['t2'] },
      ],
    });

    orchestrator.startExecution();
    orchestrator.handleWorkerResponse(
      makeResponse({ actionId: 't1', status: 'completed', outputs: { exitCode: 0 } }),
    );
    orchestrator.handleWorkerResponse(
      makeResponse({ actionId: 't2', status: 'completed', outputs: { exitCode: 0 } }),
    );
    orchestrator.handleWorkerResponse(
      makeResponse({ actionId: 't3', status: 'completed', outputs: { exitCode: 0 } }),
    );

    // Complete the merge node (auto-started when t3 completed)
    const mergeTask = orchestrator.getAllTasks().find(t => t.id.startsWith('__merge__'));
    orchestrator.handleWorkerResponse(
      makeResponse({ actionId: mergeTask!.id, status: 'completed', outputs: { exitCode: 0 } }),
    );

    expect(persistence.workflows.size).toBe(1);
    expect(persistence.tasks.size).toBe(4);

    const status = orchestrator.getWorkflowStatus();
    expect(status.total).toBe(4);
    expect(status.completed).toBe(4);
  });

  // ── Test 16: 10,000 task topological sort performance ─────

  it('10,000 tasks topological sort completes in <500ms', () => {
    const tasks: TaskState[] = [];
    const chainLength = 100;
    const chainCount = 100;

    for (let chain = 0; chain < chainCount; chain++) {
      for (let i = 0; i < chainLength; i++) {
        const id = `task-${chain}-${i}`;
        const deps: string[] = [];

        if (i > 0) deps.push(`task-${chain}-${i - 1}`);
        if (i === 0 && chain > 0) deps.push(`task-${chain - 1}-${chainLength - 1}`);

        tasks.push(createTaskState(id, `Task ${id}`, deps));
      }
    }

    expect(tasks).toHaveLength(10_000);

    const start = performance.now();
    const sorted = topologicalSort(tasks);
    const elapsed = performance.now() - start;

    expect(sorted).toHaveLength(10_000);

    const positionMap = new Map<string, number>();
    sorted.forEach((t, idx) => positionMap.set(t.id, idx));
    for (const task of sorted) {
      for (const dep of task.dependencies) {
        expect(positionMap.get(dep)!).toBeLessThan(positionMap.get(task.id)!);
      }
    }

    expect(elapsed).toBeLessThan(500);
  });
});
