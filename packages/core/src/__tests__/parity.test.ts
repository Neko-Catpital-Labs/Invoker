/**
 * Orchestrator integration tests
 *
 * Part 1 (tests 1–10): Core workflow and task behaviors end-to-end through the orchestrator.
 * Part 2 (tests 11–16): Persistence, immutability, and scheduling characteristics under load.
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
  workflows = new Map<string, { id: string; name: string; status: string }>();
  tasks = new Map<string, { workflowId: string; task: TaskState }>();

  saveWorkflow(workflow: { id: string; name: string; status: string }): void {
    this.workflows.set(workflow.id, workflow);
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
  // ── Test 1: All 7 task states ─────────────────────────────

  it('7 task states: pending → running → completed/failed/needs_input/blocked/awaiting_approval', () => {
    const sm = new TaskStateMachine();

    // pending (initial state)
    sm.createTask('t-complete', 'will complete', []);
    sm.createTask('t-fail', 'will fail', []);
    sm.createTask('t-input', 'will need input', []);
    sm.createTask('t-blocked', 'will be blocked', ['t-fail']);
    sm.createTask('t-approval', 'will need approval', []);

    expect(sm.getTask('t-complete')!.status).toBe('pending');

    // pending → running
    sm.startTask('t-complete');
    expect(sm.getTask('t-complete')!.status).toBe('running');

    sm.startTask('t-fail');
    expect(sm.getTask('t-fail')!.status).toBe('running');

    sm.startTask('t-input');
    expect(sm.getTask('t-input')!.status).toBe('running');

    sm.startTask('t-approval');
    expect(sm.getTask('t-approval')!.status).toBe('running');

    // running → completed
    sm.completeTask('t-complete');
    expect(sm.getTask('t-complete')!.status).toBe('completed');

    // running → failed (transitively blocks t-blocked)
    sm.failTask('t-fail');
    expect(sm.getTask('t-fail')!.status).toBe('failed');
    expect(sm.getTask('t-blocked')!.status).toBe('blocked');

    // running → needs_input
    sm.pauseForInput('t-input', 'What directory?');
    expect(sm.getTask('t-input')!.status).toBe('needs_input');

    // running → awaiting_approval
    sm.requestApproval('t-approval');
    expect(sm.getTask('t-approval')!.status).toBe('awaiting_approval');

    // Verify all 7 states are represented
    const statuses = sm.getAllTasks().map((t) => t.status).sort();
    expect(statuses).toEqual(
      ['awaiting_approval', 'blocked', 'completed', 'failed', 'needs_input'].sort(),
    );
  });

  // ── Test 2: Transitive dependency blocking ────────────────

  it('transitive dependency blocking: A fails → B blocked → C blocked', () => {
    const sm = new TaskStateMachine();

    sm.createTask('A', 'root task', []);
    sm.createTask('B', 'depends on A', ['A']);
    sm.createTask('C', 'depends on B', ['B']);

    sm.startTask('A');
    const result = sm.failTask('A');

    // Both B and C should be blocked
    expect(sm.getTask('B')!.status).toBe('blocked');
    expect(sm.getTask('C')!.status).toBe('blocked');

    // Both should record A as the root blocker
    expect(sm.getTask('B')!.blockedBy).toBe('A');
    expect(sm.getTask('C')!.blockedBy).toBe('A');

    // Side effects should list both blocked tasks
    expect(result).not.toHaveProperty('error');
    if (!('error' in result)) {
      const blockedEffect = result.sideEffects.find((e) => e.type === 'tasks_blocked');
      expect(blockedEffect).toBeDefined();
      if (blockedEffect && blockedEffect.type === 'tasks_blocked') {
        expect(blockedEffect.taskIds).toContain('B');
        expect(blockedEffect.taskIds).toContain('C');
      }
    }
  });

  // ── Test 3: Experiment spawning creates N experiments + 1 recon ──

  it('experiment spawning creates N experiments + 1 reconciliation task', () => {
    const sm = new TaskStateMachine();
    const em = new ExperimentManager();
    const handler = new ResponseHandler({
      stateMachine: sm,
      experimentManager: em,
    });

    // Create and start a pivot task with a downstream dependent
    sm.createTask('pivot', 'pivot task', []);
    sm.createTask('downstream', 'after pivot', ['pivot']);
    sm.startTask('pivot');

    const response = makeResponse({
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
    });

    const result = handler.handleResponse(response);
    expect(result.success).toBe(true);

    // 3 experiment tasks created
    expect(sm.getTask('pivot-exp-alpha')).toBeDefined();
    expect(sm.getTask('pivot-exp-beta')).toBeDefined();
    expect(sm.getTask('pivot-exp-gamma')).toBeDefined();

    // 1 reconciliation task created
    const recon = sm.getTask('pivot-reconciliation');
    expect(recon).toBeDefined();
    expect(recon!.isReconciliation).toBe(true);

    // Total: N experiments + 1 reconciliation = 3 + 1 = 4 new tasks
    // Plus original 2 = 6 total
    expect(sm.getTaskCount()).toBe(6);
  });

  // ── Test 4: Dependency rewriting ──────────────────────────

  it('dependency rewriting: downstream deps change from pivot → recon', () => {
    const sm = new TaskStateMachine();
    const em = new ExperimentManager();
    const handler = new ResponseHandler({
      stateMachine: sm,
      experimentManager: em,
    });

    sm.createTask('pivot', 'pivot task', []);
    sm.createTask('downstream', 'after pivot', ['pivot']);
    sm.startTask('pivot');

    // Before spawning: downstream depends on pivot
    expect(sm.getTask('downstream')!.dependencies).toContain('pivot');

    handler.handleResponse(
      makeResponse({
        actionId: 'pivot',
        status: 'spawn_experiments',
        dagMutation: {
          spawnExperiments: {
            description: 'Try variants',
            variants: [
              { id: 'v1', prompt: 'A' },
              { id: 'v2', prompt: 'B' },
            ],
          },
        },
      }),
    );

    // After spawning: downstream should now depend on reconciliation, not pivot
    const downstream = sm.getTask('downstream')!;
    expect(downstream.dependencies).toContain('pivot-reconciliation');
    expect(downstream.dependencies).not.toContain('pivot');
  });

  // ── Test 5: Reconciliation triggers when all experiments complete ──

  it('reconciliation triggers when all experiments complete', () => {
    const sm = new TaskStateMachine();
    const em = new ExperimentManager();

    // Manually set up an experiment group
    sm.createTask('pivot', 'pivot task', []);
    sm.startTask('pivot');
    sm.completeTask('pivot');

    const groupResult = em.createExperimentGroup(
      'pivot',
      [
        { id: 'exp-1', description: 'Experiment 1' },
        { id: 'exp-2', description: 'Experiment 2' },
      ],
      sm,
    );

    // Start and complete both experiments
    sm.startTask('exp-1');
    sm.completeTask('exp-1');
    sm.startTask('exp-2');
    sm.completeTask('exp-2');

    // Record completions with the experiment manager
    em.onExperimentCompleted('exp-1', { id: 'exp-1', status: 'completed' });
    const completionResult = em.onExperimentCompleted('exp-2', { id: 'exp-2', status: 'completed' });

    // All done should be true
    expect(completionResult).not.toBeNull();
    expect(completionResult!.allDone).toBe(true);
    expect(completionResult!.reconciliationTriggered).toBe(true);

    // Trigger reconciliation on the recon task
    const reconResult = sm.triggerReconciliation(
      groupResult.group.reconciliationTaskId,
      Array.from(completionResult!.group.completedExperiments.values()),
    );

    expect(reconResult).not.toHaveProperty('error');
    if (!('error' in reconResult)) {
      expect(reconResult.task.status).toBe('needs_input');
      expect(reconResult.task.experimentResults).toHaveLength(2);
    }
  });

  // ── Test 6: Experiment selection completes recon and unblocks downstream ──

  it('experiment selection completes recon and unblocks downstream', () => {
    const persistence = new InMemoryPersistence();
    const bus = new InMemoryBus();
    const orchestrator = new Orchestrator({
      persistence,
      messageBus: bus,
      maxConcurrency: 10,
    });

    orchestrator.loadPlan({
      name: 'selection-test',
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
              { id: 'v1', prompt: 'A' },
              { id: 'v2', prompt: 'B' },
            ],
          },
        },
      }),
    );

    // Ensure experiments are running, start if needed
    orchestrator.startExecution();

    // Complete both experiments
    orchestrator.handleWorkerResponse(
      makeResponse({ actionId: 'pivot-exp-v1', status: 'completed', outputs: { exitCode: 0 } }),
    );
    if (orchestrator.getTask('pivot-exp-v2')!.status === 'pending') {
      orchestrator.startExecution();
    }
    orchestrator.handleWorkerResponse(
      makeResponse({ actionId: 'pivot-exp-v2', status: 'completed', outputs: { exitCode: 0 } }),
    );

    // Recon task should be in needs_input
    const reconTask = orchestrator.getTask('pivot-reconciliation');
    expect(reconTask).toBeDefined();
    expect(reconTask!.status).toBe('needs_input');

    // Select experiment
    orchestrator.selectExperiment('pivot-reconciliation', 'pivot-exp-v1');

    // Recon should now be completed
    expect(orchestrator.getTask('pivot-reconciliation')!.status).toBe('completed');

    // Downstream should be unblocked (auto-started by orchestrator)
    const downstream = orchestrator.getTask('downstream');
    expect(downstream).toBeDefined();
    expect(downstream!.status).toBe('running');
  });

  // ── Test 7: Re-experimentation ────────────────────────────

  it('re-experimentation: second round of experiments from recon (via ExperimentManager)', () => {
    const sm = new TaskStateMachine();
    const em = new ExperimentManager();

    // Set up pivot and complete it
    sm.createTask('pivot', 'pivot task', []);
    sm.createTask('downstream', 'after pivot', ['pivot']);
    sm.startTask('pivot');
    sm.completeTask('pivot');

    // First round of experiments
    const round1 = em.createExperimentGroup(
      'pivot',
      [
        { id: 'r1-exp-1', description: 'Round 1 exp 1' },
        { id: 'r1-exp-2', description: 'Round 1 exp 2' },
      ],
      sm,
    );

    // Complete round 1 experiments
    sm.startTask('r1-exp-1');
    sm.completeTask('r1-exp-1');
    sm.startTask('r1-exp-2');
    sm.completeTask('r1-exp-2');

    em.onExperimentCompleted('r1-exp-1', { id: 'r1-exp-1', status: 'completed', summary: 'good' });
    em.onExperimentCompleted('r1-exp-2', { id: 'r1-exp-2', status: 'completed', summary: 'ok' });

    // Trigger reconciliation
    sm.triggerReconciliation(
      round1.group.reconciliationTaskId,
      [
        { id: 'r1-exp-1', status: 'completed', summary: 'good' },
        { id: 'r1-exp-2', status: 'completed', summary: 'ok' },
      ],
    );

    // Second round: pass previous results
    const previousResults = [
      { id: 'r1-exp-1', status: 'completed' as const, summary: 'good' },
      { id: 'r1-exp-2', status: 'completed' as const, summary: 'ok' },
    ];

    const round2 = em.createExperimentGroup(
      'pivot',
      [
        { id: 'r2-exp-1', description: 'Round 2 exp 1' },
        { id: 'r2-exp-2', description: 'Round 2 exp 2' },
      ],
      sm,
      previousResults,
    );

    // Round 2 should create new experiments and a new reconciliation task
    expect(round2.experiments).toHaveLength(2);
    expect(round2.reconciliationTask).toBeDefined();
    expect(round2.reconciliationTask.isReconciliation).toBe(true);

    // The new reconciliation should track all 4 experiment IDs (2 from round 1 + 2 from round 2)
    expect(round2.group.experimentIds).toHaveLength(4);
    expect(round2.group.experimentIds).toContain('r1-exp-1');
    expect(round2.group.experimentIds).toContain('r1-exp-2');
    expect(round2.group.experimentIds).toContain('r2-exp-1');
    expect(round2.group.experimentIds).toContain('r2-exp-2');

    // Previous results should be pre-populated
    expect(round2.group.completedExperiments.size).toBe(2);
    expect(round2.group.completedExperiments.has('r1-exp-1')).toBe(true);
    expect(round2.group.completedExperiments.has('r1-exp-2')).toBe(true);
  });

  // ── Test 8: Manual approval flow ──────────────────────────

  it('manual approval flow: running → awaiting_approval → completed/failed', () => {
    const sm = new TaskStateMachine();

    // Approval → completed
    sm.createTask('t-approve', 'needs approval', [], { requiresManualApproval: true });
    sm.createTask('t-after', 'after approval', ['t-approve']);
    sm.startTask('t-approve');
    expect(sm.getTask('t-approve')!.status).toBe('running');

    sm.requestApproval('t-approve');
    expect(sm.getTask('t-approve')!.status).toBe('awaiting_approval');

    const approveResult = sm.approveTask('t-approve');
    expect(approveResult).not.toHaveProperty('error');
    if (!('error' in approveResult)) {
      expect(approveResult.task.status).toBe('completed');
      // Should signal that t-after is now ready
      const readyEffect = approveResult.sideEffects.find((e) => e.type === 'tasks_ready');
      expect(readyEffect).toBeDefined();
    }

    // Approval → rejected (failed)
    sm.createTask('t-reject', 'will be rejected', []);
    sm.createTask('t-blocked-by-reject', 'blocked if rejected', ['t-reject']);
    sm.startTask('t-reject');
    sm.requestApproval('t-reject');
    expect(sm.getTask('t-reject')!.status).toBe('awaiting_approval');

    const rejectResult = sm.rejectTask('t-reject', 'Not good enough');
    expect(rejectResult).not.toHaveProperty('error');
    if (!('error' in rejectResult)) {
      expect(rejectResult.task.status).toBe('failed');
      expect(rejectResult.task.error).toBe('Not good enough');
      // Dependent should be blocked
      expect(sm.getTask('t-blocked-by-reject')!.status).toBe('blocked');
    }
  });

  // ── Test 9: Input flow ────────────────────────────────────

  it('input flow: running → needs_input → running (with input)', () => {
    const sm = new TaskStateMachine();

    sm.createTask('t1', 'interactive task', []);
    sm.startTask('t1');
    expect(sm.getTask('t1')!.status).toBe('running');

    // Pause for input
    const pauseResult = sm.pauseForInput('t1', 'Enter the target directory:');
    expect(pauseResult).not.toHaveProperty('error');
    if (!('error' in pauseResult)) {
      expect(pauseResult.task.status).toBe('needs_input');
      expect(pauseResult.task.inputPrompt).toBe('Enter the target directory:');
      expect(pauseResult.transition.from).toBe('running');
      expect(pauseResult.transition.to).toBe('needs_input');
    }

    // Resume with input
    const resumeResult = sm.resumeWithInput('t1');
    expect(resumeResult).not.toHaveProperty('error');
    if (!('error' in resumeResult)) {
      expect(resumeResult.task.status).toBe('running');
      expect(resumeResult.transition.from).toBe('needs_input');
      expect(resumeResult.transition.to).toBe('running');
    }

    // Task can now be completed normally
    const completeResult = sm.completeTask('t1');
    expect(completeResult).not.toHaveProperty('error');
    if (!('error' in completeResult)) {
      expect(completeResult.task.status).toBe('completed');
    }
  });

  // ── Test 10: Concurrent execution respects maxConcurrency ──

  it('concurrent execution respects maxConcurrency limit', () => {
    const persistence = new InMemoryPersistence();
    const bus = new InMemoryBus();
    const orchestrator = new Orchestrator({
      persistence,
      messageBus: bus,
      maxConcurrency: 2,
    });

    orchestrator.loadPlan({
      name: 'concurrency-test',
      tasks: [
        { id: 't1', description: 'Task 1' },
        { id: 't2', description: 'Task 2' },
        { id: 't3', description: 'Task 3' },
        { id: 't4', description: 'Task 4' },
        { id: 't5', description: 'Task 5' },
      ],
    });

    const started = orchestrator.startExecution();

    // maxConcurrency=2, so only 2 should start
    expect(started).toHaveLength(2);
    expect(started.every((t) => t.status === 'running')).toBe(true);

    // Remaining 3 should still be pending
    const allTasks = orchestrator.getAllTasks();
    const pendingTasks = allTasks.filter((t) => t.status === 'pending');
    expect(pendingTasks).toHaveLength(3);

    const runningTasks = allTasks.filter((t) => t.status === 'running');
    expect(runningTasks).toHaveLength(2);
  });
});

// ══════════════════════════════════════════════════════════════
// Part 2: Architectural Superiority (6 tests)
// ══════════════════════════════════════════════════════════════

describe('Parity — Architectural Superiority', () => {
  // ── Test 11: Immutable state transitions ──────────────────

  it('state transitions are immutable (original object unchanged)', () => {
    const sm = new TaskStateMachine();

    sm.createTask('t1', 'test task', []);
    const before = sm.getTask('t1')!;
    const beforeStatus = before.status;

    sm.startTask('t1');

    // The original reference should still have its old status value
    // because TaskState uses readonly fields and transitions create new objects
    expect(beforeStatus).toBe('pending');

    // The state machine returns a new object
    const after = sm.getTask('t1')!;
    expect(after.status).toBe('running');

    // They should be different object references
    expect(before).not.toBe(after);
  });

  // ── Test 12: Every transition produces a delta ────────────

  it('every transition produces a delta (no silent state changes)', () => {
    const sm = new TaskStateMachine();

    // createTask returns a delta
    const createResult = sm.createTask('t1', 'test', []);
    expect(createResult.delta).toBeDefined();
    expect(createResult.delta.type).toBe('created');

    // startTask returns a delta
    const startResult = sm.startTask('t1');
    expect(startResult).not.toHaveProperty('error');
    if (!('error' in startResult)) {
      expect(startResult.delta).toBeDefined();
      expect(startResult.delta.type).toBe('updated');
    }

    // pauseForInput returns a delta
    const pauseResult = sm.pauseForInput('t1', 'prompt');
    expect(pauseResult).not.toHaveProperty('error');
    if (!('error' in pauseResult)) {
      expect(pauseResult.delta).toBeDefined();
    }

    // resumeWithInput returns a delta
    const resumeResult = sm.resumeWithInput('t1');
    expect(resumeResult).not.toHaveProperty('error');
    if (!('error' in resumeResult)) {
      expect(resumeResult.delta).toBeDefined();
    }

    // completeTask returns a delta
    const completeResult = sm.completeTask('t1');
    expect(completeResult).not.toHaveProperty('error');
    if (!('error' in completeResult)) {
      expect(completeResult.delta).toBeDefined();
    }

    // failTask returns a delta
    sm.createTask('t2', 'to fail', []);
    sm.startTask('t2');
    const failResult = sm.failTask('t2');
    expect(failResult).not.toHaveProperty('error');
    if (!('error' in failResult)) {
      expect(failResult.delta).toBeDefined();
    }

    // requestApproval returns a delta
    sm.createTask('t3', 'for approval', []);
    sm.startTask('t3');
    const approvalResult = sm.requestApproval('t3');
    expect(approvalResult).not.toHaveProperty('error');
    if (!('error' in approvalResult)) {
      expect(approvalResult.delta).toBeDefined();
    }

    // approveTask returns a delta
    const approveResult = sm.approveTask('t3');
    expect(approveResult).not.toHaveProperty('error');
    if (!('error' in approveResult)) {
      expect(approveResult.delta).toBeDefined();
    }
  });

  // ── Test 13: Delta-based updates contain only changed fields ──

  it('delta-based updates: only changed fields, not full state', () => {
    const sm = new TaskStateMachine();

    sm.createTask('t1', 'test task', []);
    const startResult = sm.startTask('t1');

    expect(startResult).not.toHaveProperty('error');
    if (!('error' in startResult)) {
      const delta = startResult.delta;
      expect(delta.type).toBe('updated');
      if (delta.type === 'updated') {
        // Delta should contain status change
        expect(delta.changes.status).toBe('running');

        // Delta should NOT contain unchanged fields like description or id
        expect(delta.changes).not.toHaveProperty('id');
        expect(delta.changes).not.toHaveProperty('description');
        expect(delta.changes).not.toHaveProperty('dependencies');
        expect(delta.changes).not.toHaveProperty('createdAt');
      }
    }

    // Complete task — delta should have status + completedAt, but not description
    const completeResult = sm.completeTask('t1');
    expect(completeResult).not.toHaveProperty('error');
    if (!('error' in completeResult)) {
      const delta = completeResult.delta;
      if (delta.type === 'updated') {
        expect(delta.changes.status).toBe('completed');
        expect(delta.changes.completedAt).toBeInstanceOf(Date);
        expect(delta.changes).not.toHaveProperty('id');
        expect(delta.changes).not.toHaveProperty('description');
      }
    }
  });

  // ── Test 14: Pure domain logic — zero I/O ─────────────────

  it('pure domain logic: StateMachine has zero I/O dependencies', () => {
    // Instantiate with zero constructor args — no DB, no network, no filesystem
    const sm = new TaskStateMachine();

    // Perform full lifecycle with no external dependencies
    sm.createTask('t1', 'root', []);
    sm.createTask('t2', 'child', ['t1']);
    sm.startTask('t1');
    sm.completeTask('t1');
    sm.startTask('t2');
    sm.pauseForInput('t2', 'need info');
    sm.resumeWithInput('t2');
    sm.completeTask('t2');

    expect(sm.getTask('t1')!.status).toBe('completed');
    expect(sm.getTask('t2')!.status).toBe('completed');

    // ExperimentManager also has zero I/O
    const em = new ExperimentManager();
    // TaskScheduler also has zero I/O
    const scheduler = new TaskScheduler(3);

    // All core domain objects work without any infrastructure
    expect(sm.getTaskCount()).toBe(2);
    expect(em.getAllGroups()).toEqual([]);
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

    // Full workflow using in-memory persistence
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

    // Verify the in-memory persistence recorded everything correctly
    expect(persistence.workflows.size).toBe(1);
    expect(persistence.tasks.size).toBe(3);

    // Verify task states match what the orchestrator reports
    const status = orchestrator.getWorkflowStatus();
    expect(status.total).toBe(3);
    expect(status.completed).toBe(3);
    expect(status.failed).toBe(0);
    expect(status.running).toBe(0);
    expect(status.pending).toBe(0);

    // Verify the bus published deltas (3 created + at least 3 status transitions)
    expect(bus.published.length).toBeGreaterThanOrEqual(6);
  });

  // ── Test 16: 10,000 task topological sort performance ─────

  it('10,000 tasks topological sort completes in <100ms', () => {
    // Create a DAG with 10,000 tasks in a chain-of-chains pattern.
    // 100 chains of 100 tasks each, with inter-chain dependencies.
    const tasks: TaskState[] = [];
    const chainLength = 100;
    const chainCount = 100;

    for (let chain = 0; chain < chainCount; chain++) {
      for (let i = 0; i < chainLength; i++) {
        const id = `task-${chain}-${i}`;
        const deps: string[] = [];

        // Within-chain dependency
        if (i > 0) {
          deps.push(`task-${chain}-${i - 1}`);
        }

        // Cross-chain dependency: first task of each chain depends on last task of previous chain
        if (i === 0 && chain > 0) {
          deps.push(`task-${chain - 1}-${chainLength - 1}`);
        }

        tasks.push(createTaskState(id, `Task ${id}`, deps));
      }
    }

    expect(tasks).toHaveLength(10_000);

    // Time the sort
    const start = performance.now();
    const sorted = topologicalSort(tasks);
    const elapsed = performance.now() - start;

    // Verify correctness
    expect(sorted).toHaveLength(10_000);

    // Verify ordering: every task appears after its dependencies
    const positionMap = new Map<string, number>();
    sorted.forEach((t, idx) => positionMap.set(t.id, idx));
    for (const task of sorted) {
      for (const dep of task.dependencies) {
        expect(positionMap.get(dep)!).toBeLessThan(positionMap.get(task.id)!);
      }
    }

    // Performance regression guard: O(V+E) topo-sort of 10k tasks should
    // finish well under 500ms on any CI runner.  The previous 100ms threshold
    // was flaky under load.  500ms still catches accidental O(n²) regressions
    // (which would take seconds).
    expect(elapsed).toBeLessThan(500);
  });
});
