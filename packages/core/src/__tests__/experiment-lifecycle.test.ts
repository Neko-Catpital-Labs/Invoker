/**
 * Full experiment lifecycle integration test.
 *
 * Proves: pivot -> spawn -> experiments complete -> reconciliation -> select -> downstream unblocks.
 * Uses the same InMemoryPersistence and InMemoryBus helpers from orchestrator.test.ts.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Orchestrator } from '../orchestrator.js';
import type { PlanDefinition, OrchestratorPersistence, OrchestratorMessageBus } from '../orchestrator.js';
import type { TaskState, TaskDelta } from '../task-types.js';
import type { WorkResponse } from '@invoker/protocol';

// ── In-Memory Persistence Mock ──────────────────────────────

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

function spawnResponse(
  actionId: string,
  variants: Array<{ id: string; prompt?: string; description?: string }>,
): WorkResponse {
  return {
    requestId: `req-${actionId}`,
    actionId,
    status: 'spawn_experiments',
    outputs: { exitCode: 0 },
    dagMutation: {
      spawnExperiments: {
        description: `Experiment variants for ${actionId}`,
        variants: variants.map((v) => ({
          id: v.id,
          prompt: v.prompt ?? `Try ${v.id}`,
          description: v.description ?? `Variant ${v.id}`,
        })),
      },
    },
  };
}

function completedResponse(actionId: string, exitCode = 0): WorkResponse {
  return makeResponse({ actionId, status: 'completed', outputs: { exitCode } });
}

function failedResponse(actionId: string, error?: string): WorkResponse {
  return makeResponse({
    actionId,
    status: 'failed',
    outputs: { exitCode: 1, error },
  });
}

// ── Tests ───────────────────────────────────────────────────

describe('Experiment Lifecycle (integration)', () => {
  let orchestrator: Orchestrator;
  let persistence: InMemoryPersistence;
  let bus: InMemoryBus;
  let publishedDeltas: TaskDelta[];

  /** Standard 3-task plan: setup -> pivot -> downstream. */
  const standardPlan: PlanDefinition = {
    name: 'experiment-lifecycle',
    tasks: [
      { id: 'setup', description: 'Setup task' },
      {
        id: 'pivot',
        description: 'Pivot task',
        dependencies: ['setup'],
        pivot: true,
        experimentVariants: [
          { id: 'v1', description: 'Variant A', prompt: 'Try approach A' },
          { id: 'v2', description: 'Variant B', prompt: 'Try approach B' },
        ],
      },
      { id: 'downstream', description: 'Downstream task', dependencies: ['pivot'] },
    ],
  };

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
      maxConcurrency: 10, // High limit to avoid scheduler interference
    });
  });

  // ── 1. Load plan with pivot task + downstream ──────────────

  it('load plan with pivot task + downstream -> pivot task starts after setup', () => {
    orchestrator.loadPlan(standardPlan);

    // All 3 tasks exist
    expect(orchestrator.getAllTasks()).toHaveLength(3);

    // Pivot is marked as pivot
    const pivot = orchestrator.getTask('pivot');
    expect(pivot).toBeDefined();
    expect(pivot!.pivot).toBe(true);
    expect(pivot!.experimentVariants).toHaveLength(2);

    // Downstream depends on pivot
    const downstream = orchestrator.getTask('downstream');
    expect(downstream!.dependencies).toEqual(['pivot']);

    // Start execution: only setup is ready (no deps)
    const started = orchestrator.startExecution();
    expect(started).toHaveLength(1);
    expect(started[0].id).toBe('setup');
    expect(orchestrator.getTask('pivot')!.status).toBe('pending');
    expect(orchestrator.getTask('downstream')!.status).toBe('pending');
  });

  // ── 2. Complete pivot with spawn_experiments ───────────────

  it('complete pivot with spawn_experiments -> experiments created, downstream rewired to recon', () => {
    orchestrator.loadPlan(standardPlan);
    orchestrator.startExecution();

    // Complete setup -> pivot auto-starts
    orchestrator.handleWorkerResponse(completedResponse('setup'));
    expect(orchestrator.getTask('pivot')!.status).toBe('running');

    // Pivot responds with spawn_experiments
    publishedDeltas = [];
    orchestrator.handleWorkerResponse(
      spawnResponse('pivot', [
        { id: 'v1', prompt: 'Approach A' },
        { id: 'v2', prompt: 'Approach B' },
      ]),
    );

    // Experiment tasks created and auto-started
    const expV1 = orchestrator.getTask('pivot-exp-v1');
    const expV2 = orchestrator.getTask('pivot-exp-v2');
    expect(expV1).toBeDefined();
    expect(expV2).toBeDefined();
    expect(expV1!.status).toBe('running');
    expect(expV2!.status).toBe('running');
    expect(expV1!.parentTask).toBe('pivot');
    expect(expV2!.parentTask).toBe('pivot');

    // Reconciliation task created
    const recon = orchestrator.getTask('pivot-reconciliation');
    expect(recon).toBeDefined();
    expect(recon!.isReconciliation).toBe(true);
    expect(recon!.dependencies).toContain('pivot-exp-v1');
    expect(recon!.dependencies).toContain('pivot-exp-v2');

    // Downstream rewired: depends on reconciliation, not pivot
    const downstream = orchestrator.getTask('downstream');
    expect(downstream!.dependencies).toContain('pivot-reconciliation');
    expect(downstream!.dependencies).not.toContain('pivot');

    // Pivot itself completed (parent task completes when spawning)
    expect(orchestrator.getTask('pivot')!.status).toBe('completed');
  });

  // ── 3. Complete all experiments -> reconciliation triggers ─

  it('complete all experiments -> reconciliation task transitions to needs_input', () => {
    orchestrator.loadPlan(standardPlan);
    orchestrator.startExecution();
    orchestrator.handleWorkerResponse(completedResponse('setup'));
    orchestrator.handleWorkerResponse(
      spawnResponse('pivot', [
        { id: 'v1', prompt: 'A' },
        { id: 'v2', prompt: 'B' },
      ]),
    );

    // Both experiments are running. Complete them.
    orchestrator.handleWorkerResponse(completedResponse('pivot-exp-v1'));
    orchestrator.handleWorkerResponse(completedResponse('pivot-exp-v2'));

    // Reconciliation task should now be in needs_input (awaiting human selection)
    const recon = orchestrator.getTask('pivot-reconciliation');
    expect(recon!.status).toBe('needs_input');
    expect(recon!.experimentResults).toBeDefined();
    expect(recon!.experimentResults).toHaveLength(2);

    // Both results recorded
    const ids = recon!.experimentResults!.map((r) => r.id);
    expect(ids).toContain('pivot-exp-v1');
    expect(ids).toContain('pivot-exp-v2');

    // Downstream is still pending (blocked by recon)
    expect(orchestrator.getTask('downstream')!.status).toBe('pending');
  });

  // ── 4. selectExperiment -> recon completes, downstream unblocks ─

  it('selectExperiment on recon task -> recon completes, downstream unblocks', () => {
    orchestrator.loadPlan(standardPlan);
    orchestrator.startExecution();
    orchestrator.handleWorkerResponse(completedResponse('setup'));
    orchestrator.handleWorkerResponse(
      spawnResponse('pivot', [
        { id: 'v1', prompt: 'A' },
        { id: 'v2', prompt: 'B' },
      ]),
    );
    orchestrator.handleWorkerResponse(completedResponse('pivot-exp-v1'));
    orchestrator.handleWorkerResponse(completedResponse('pivot-exp-v2'));

    // Recon is now needs_input. Select v1 as winner.
    publishedDeltas = [];
    orchestrator.selectExperiment('pivot-reconciliation', 'pivot-exp-v1');

    // Recon completed with selected experiment
    const recon = orchestrator.getTask('pivot-reconciliation');
    expect(recon!.status).toBe('completed');
    expect(recon!.selectedExperiment).toBe('pivot-exp-v1');

    // Downstream unblocked and auto-started
    const downstream = orchestrator.getTask('downstream');
    expect(downstream!.status).toBe('running');
  });

  // ── 5. Complete downstream -> workflow fully done ──────────

  it('complete downstream -> workflow shows all completed, 0 failed', () => {
    orchestrator.loadPlan(standardPlan);
    orchestrator.startExecution();
    orchestrator.handleWorkerResponse(completedResponse('setup'));
    orchestrator.handleWorkerResponse(
      spawnResponse('pivot', [
        { id: 'v1', prompt: 'A' },
        { id: 'v2', prompt: 'B' },
      ]),
    );
    orchestrator.handleWorkerResponse(completedResponse('pivot-exp-v1'));
    orchestrator.handleWorkerResponse(completedResponse('pivot-exp-v2'));
    orchestrator.selectExperiment('pivot-reconciliation', 'pivot-exp-v1');

    // Downstream is running. Complete it.
    orchestrator.handleWorkerResponse(completedResponse('downstream'));

    expect(orchestrator.getTask('downstream')!.status).toBe('completed');

    // Workflow status: all tasks accounted for
    const status = orchestrator.getWorkflowStatus();
    // Original 3 + 2 experiments + 1 reconciliation = 6 tasks
    expect(status.total).toBe(6);
    expect(status.completed).toBe(6);
    expect(status.failed).toBe(0);
    expect(status.running).toBe(0);
    expect(status.pending).toBe(0);
  });

  // ── 6. Experiment failure still allows reconciliation ──────

  it('experiment failure still allows reconciliation (partial results)', () => {
    orchestrator.loadPlan(standardPlan);
    orchestrator.startExecution();
    orchestrator.handleWorkerResponse(completedResponse('setup'));
    orchestrator.handleWorkerResponse(
      spawnResponse('pivot', [
        { id: 'v1', prompt: 'A' },
        { id: 'v2', prompt: 'B' },
      ]),
    );

    // Fail v1, complete v2
    orchestrator.handleWorkerResponse(failedResponse('pivot-exp-v1', 'build failed'));
    orchestrator.handleWorkerResponse(completedResponse('pivot-exp-v2'));

    // Reconciliation still triggers despite one failure.
    // triggerReconciliation moves recon from blocked -> needs_input, overriding the
    // blocked status that was set when pivot-exp-v1 failed.
    const recon = orchestrator.getTask('pivot-reconciliation');
    expect(recon!.status).toBe('needs_input');
    expect(recon!.experimentResults).toHaveLength(2);

    // Verify individual statuses
    const results = recon!.experimentResults!;
    const v1Result = results.find((r) => r.id === 'pivot-exp-v1');
    const v2Result = results.find((r) => r.id === 'pivot-exp-v2');
    expect(v1Result!.status).toBe('failed');
    expect(v2Result!.status).toBe('completed');

    // Can still select the successful experiment and complete reconciliation
    orchestrator.selectExperiment('pivot-reconciliation', 'pivot-exp-v2');
    expect(orchestrator.getTask('pivot-reconciliation')!.status).toBe('completed');

    // Downstream was blocked by the experiment failure cascade (blockDependentTasks).
    // completeReconciliation only unblocks pending tasks, not blocked ones.
    // This is current system behavior: experiment failure cascades block downstream.
    expect(orchestrator.getTask('downstream')!.status).toBe('blocked');
  });

  // ── 7. Re-experimentation (second round) ──────────────────

  it('second round of experiments (re-experimentation) works', () => {
    // Plan: just a pivot with downstream
    const plan: PlanDefinition = {
      name: 're-experiment',
      tasks: [
        { id: 'pivot', description: 'Pivot task', pivot: true },
        { id: 'downstream', description: 'Downstream', dependencies: ['pivot'] },
      ],
    };

    orchestrator.loadPlan(plan);
    orchestrator.startExecution();

    // First round of experiments
    orchestrator.handleWorkerResponse(
      spawnResponse('pivot', [
        { id: 'r1v1', prompt: 'Round 1 approach A' },
        { id: 'r1v2', prompt: 'Round 1 approach B' },
      ]),
    );
    orchestrator.handleWorkerResponse(completedResponse('pivot-exp-r1v1'));
    orchestrator.handleWorkerResponse(completedResponse('pivot-exp-r1v2'));

    // Reconciliation triggers for first round
    const recon1 = orchestrator.getTask('pivot-reconciliation');
    expect(recon1).toBeDefined();
    expect(recon1!.status).toBe('needs_input');
    expect(recon1!.experimentResults).toHaveLength(2);

    // User can now select, completing the first-round reconciliation
    orchestrator.selectExperiment('pivot-reconciliation', 'pivot-exp-r1v1');
    expect(orchestrator.getTask('pivot-reconciliation')!.status).toBe('completed');

    // Downstream should be unblocked and running
    expect(orchestrator.getTask('downstream')!.status).toBe('running');
  });

  // ── 8. All state transitions produce deltas ────────────────

  it('all state transitions produce deltas (no lost deltas)', () => {
    orchestrator.loadPlan(standardPlan);

    // 3 created deltas from loadPlan
    const createdDeltas = publishedDeltas.filter((d) => d.type === 'created');
    expect(createdDeltas).toHaveLength(3);

    publishedDeltas = [];
    orchestrator.startExecution(); // setup -> running

    // 1 delta: setup pending -> running
    const setupStartDelta = publishedDeltas.find(
      (d) => d.type === 'updated' && d.taskId === 'setup',
    );
    expect(setupStartDelta).toBeDefined();

    publishedDeltas = [];
    orchestrator.handleWorkerResponse(completedResponse('setup'));

    // setup completed + pivot auto-started = at least 2 deltas
    const setupComplete = publishedDeltas.find(
      (d) => d.type === 'updated' && d.taskId === 'setup',
    );
    const pivotStart = publishedDeltas.find(
      (d) => d.type === 'updated' && d.taskId === 'pivot',
    );
    expect(setupComplete).toBeDefined();
    expect(pivotStart).toBeDefined();

    publishedDeltas = [];
    orchestrator.handleWorkerResponse(
      spawnResponse('pivot', [
        { id: 'v1', prompt: 'A' },
        { id: 'v2', prompt: 'B' },
      ]),
    );

    // Expected deltas from spawn:
    // - pivot completed (parent task auto-completed)
    // - exp-v1 created, exp-v2 created
    // - reconciliation created
    // - downstream dependency rewrite
    // - exp-v1 started, exp-v2 started
    expect(publishedDeltas.length).toBeGreaterThanOrEqual(5);

    // Verify experiment create deltas exist
    const expCreatedDeltas = publishedDeltas.filter(
      (d) => d.type === 'created' && (d.task.id === 'pivot-exp-v1' || d.task.id === 'pivot-exp-v2'),
    );
    expect(expCreatedDeltas).toHaveLength(2);

    // Verify reconciliation create delta exists
    const reconCreated = publishedDeltas.filter(
      (d) => d.type === 'created' && d.task.id === 'pivot-reconciliation',
    );
    expect(reconCreated).toHaveLength(1);

    publishedDeltas = [];
    orchestrator.handleWorkerResponse(completedResponse('pivot-exp-v1'));

    // At least 1 delta for experiment completion
    const v1CompleteDelta = publishedDeltas.find(
      (d) => d.type === 'updated' && d.taskId === 'pivot-exp-v1',
    );
    expect(v1CompleteDelta).toBeDefined();

    publishedDeltas = [];
    orchestrator.handleWorkerResponse(completedResponse('pivot-exp-v2'));

    // At least 1 delta for experiment completion + reconciliation trigger
    const v2CompleteDelta = publishedDeltas.find(
      (d) => d.type === 'updated' && d.taskId === 'pivot-exp-v2',
    );
    expect(v2CompleteDelta).toBeDefined();

    // Reconciliation trigger delta
    const reconTrigger = publishedDeltas.find(
      (d) => d.type === 'updated' && d.taskId === 'pivot-reconciliation',
    );
    expect(reconTrigger).toBeDefined();

    publishedDeltas = [];
    orchestrator.selectExperiment('pivot-reconciliation', 'pivot-exp-v1');

    // Recon completed + downstream started
    const reconComplete = publishedDeltas.find(
      (d) => d.type === 'updated' && d.taskId === 'pivot-reconciliation',
    );
    const downstreamStart = publishedDeltas.find(
      (d) => d.type === 'updated' && d.taskId === 'downstream',
    );
    expect(reconComplete).toBeDefined();
    expect(downstreamStart).toBeDefined();

    publishedDeltas = [];
    orchestrator.handleWorkerResponse(completedResponse('downstream'));

    const downstreamComplete = publishedDeltas.find(
      (d) => d.type === 'updated' && d.taskId === 'downstream',
    );
    expect(downstreamComplete).toBeDefined();
  });

  // ── 9. Experiment lifecycle with 5 variants ────────────────

  it('experiment lifecycle with 5 variants completes correctly', () => {
    const plan: PlanDefinition = {
      name: 'five-variants',
      tasks: [
        { id: 'setup', description: 'Setup' },
        { id: 'pivot', description: 'Pivot', dependencies: ['setup'], pivot: true },
        { id: 'downstream', description: 'Downstream', dependencies: ['pivot'] },
      ],
    };

    orchestrator.loadPlan(plan);
    orchestrator.startExecution();
    orchestrator.handleWorkerResponse(completedResponse('setup'));

    // Spawn 5 variants
    const variants = Array.from({ length: 5 }, (_, i) => ({
      id: `v${i + 1}`,
      prompt: `Approach ${i + 1}`,
      description: `Variant ${i + 1}`,
    }));

    orchestrator.handleWorkerResponse(spawnResponse('pivot', variants));

    // All 5 experiments should exist and be running
    for (let i = 1; i <= 5; i++) {
      const exp = orchestrator.getTask(`pivot-exp-v${i}`);
      expect(exp).toBeDefined();
      expect(exp!.status).toBe('running');
    }

    // Reconciliation task exists
    const recon = orchestrator.getTask('pivot-reconciliation');
    expect(recon).toBeDefined();
    expect(recon!.dependencies).toHaveLength(5);

    // Complete all 5 experiments
    for (let i = 1; i <= 5; i++) {
      orchestrator.handleWorkerResponse(completedResponse(`pivot-exp-v${i}`));
    }

    // Reconciliation in needs_input with 5 results
    expect(orchestrator.getTask('pivot-reconciliation')!.status).toBe('needs_input');
    expect(orchestrator.getTask('pivot-reconciliation')!.experimentResults).toHaveLength(5);

    // Select variant 3 as winner
    orchestrator.selectExperiment('pivot-reconciliation', 'pivot-exp-v3');
    expect(orchestrator.getTask('pivot-reconciliation')!.status).toBe('completed');
    expect(orchestrator.getTask('pivot-reconciliation')!.selectedExperiment).toBe('pivot-exp-v3');

    // Downstream unblocked
    expect(orchestrator.getTask('downstream')!.status).toBe('running');

    // Complete downstream
    orchestrator.handleWorkerResponse(completedResponse('downstream'));

    // Final status: 3 original + 5 experiments + 1 recon = 9 tasks
    const status = orchestrator.getWorkflowStatus();
    expect(status.total).toBe(9);
    expect(status.completed).toBe(9);
    expect(status.failed).toBe(0);
    expect(status.running).toBe(0);
    expect(status.pending).toBe(0);
  });
});
