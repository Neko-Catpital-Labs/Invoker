/**
 * Full experiment lifecycle integration test.
 *
 * Proves: pivot -> spawn -> experiments complete -> reconciliation -> select -> downstream unblocks.
 * Uses the same InMemoryPersistence and InMemoryBus helpers from orchestrator.test.ts.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { reconciliationNeedsInputWorkResponse } from './reconciliation-needs-input-shim.js';
import { rid, sid } from './scoped-test-helpers.js';
import { Orchestrator } from '../orchestrator.js';
import type { PlanDefinition, OrchestratorPersistence, OrchestratorMessageBus } from '../orchestrator.js';
import type { TaskState, TaskDelta, TaskStateChanges, Attempt } from '../task-types.js';
import type { WorkResponse } from '@invoker/contracts';

// ── In-Memory Persistence Mock ──────────────────────────────

class InMemoryPersistence implements OrchestratorPersistence {
  workflows = new Map<string, { id: string; name: string; status: string; createdAt: string; updatedAt: string }>();
  tasks = new Map<string, { workflowId: string; task: TaskState }>();
  private attempts = new Map<string, Attempt[]>();

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

  loadTasks(workflowId: string): TaskState[] {
    return Array.from(this.tasks.values())
      .filter((e) => e.workflowId === workflowId)
      .map((e) => e.task);
  }

  loadWorkflow(workflowId: string): { repoUrl?: string; baseBranch?: string } | undefined {
    return this.workflows.get(workflowId) as { repoUrl?: string; baseBranch?: string } | undefined;
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
    baseBranch: 'main',
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

    // All 3 user tasks + 1 merge node
    expect(orchestrator.getAllTasks()).toHaveLength(4);

    // Pivot is marked as pivot
    const pivot = orchestrator.getTask('pivot');
    expect(pivot).toBeDefined();
    expect(pivot!.config.pivot).toBe(true);
    expect(pivot!.config.experimentVariants).toHaveLength(2);

    // Downstream depends on pivot
    const downstream = orchestrator.getTask('downstream');
    expect(downstream!.dependencies).toEqual([sid(orchestrator, 0, 'pivot')]);

    const started = orchestrator.startExecution();
    expect(started).toHaveLength(1);
    expect(started[0].id).toBe(sid(orchestrator, 0, 'setup'));
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

    const exp1 = sid(orchestrator, 0, 'pivot-exp-v1');
    const exp2 = sid(orchestrator, 0, 'pivot-exp-v2');
    const expV1 = orchestrator.getTask(exp1);
    const expV2 = orchestrator.getTask(exp2);
    expect(expV1).toBeDefined();
    expect(expV2).toBeDefined();
    expect(expV1!.status).toBe('running');
    expect(expV2!.status).toBe('running');
    const pivotId = sid(orchestrator, 0, 'pivot');
    expect(expV1!.config.parentTask).toBe(pivotId);
    expect(expV2!.config.parentTask).toBe(pivotId);

    const recon = orchestrator.getTask(rid(orchestrator, 0, 'pivot'));
    expect(recon).toBeDefined();
    expect(recon!.config.isReconciliation).toBe(true);
    expect(recon!.dependencies).toContain(exp1);
    expect(recon!.dependencies).toContain(exp2);

    expect(orchestrator.getTask('downstream')!.status).toBe('pending');
    expect(orchestrator.getTask('downstream')!.dependencies).toContain(rid(orchestrator, 0, 'pivot'));
    expect(orchestrator.getTask('downstream')!.dependencies).not.toContain(pivotId);
    expect(orchestrator.getTask('downstream-v2')).toBeUndefined();

    // Pivot itself completed (parent task completes when spawning)
    expect(orchestrator.getTask('pivot')!.status).toBe('completed');
    expect(orchestrator.getTask('pivot')!.execution.branch).toBe('main');
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
    orchestrator.handleWorkerResponse(completedResponse(sid(orchestrator, 0, 'pivot-exp-v1')));
    orchestrator.handleWorkerResponse(completedResponse(sid(orchestrator, 0, 'pivot-exp-v2')));

    orchestrator.handleWorkerResponse(reconciliationNeedsInputWorkResponse(rid(orchestrator, 0, 'pivot')));

    const recon = orchestrator.getTask(rid(orchestrator, 0, 'pivot'));
    expect(recon!.status).toBe('needs_input');
    expect(recon!.execution.experimentResults).toBeDefined();
    expect(recon!.execution.experimentResults).toHaveLength(2);

    const ids = recon!.execution.experimentResults!.map((r) => r.id);
    expect(ids).toContain(sid(orchestrator, 0, 'pivot-exp-v1'));
    expect(ids).toContain(sid(orchestrator, 0, 'pivot-exp-v2'));

    // Downstream is still pending (blocked by recon, which is needs_input)
    expect(orchestrator.getTask('downstream')!.status).toBe('pending');
    expect(orchestrator.getTask('downstream-v2')).toBeUndefined();
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
    orchestrator.handleWorkerResponse(completedResponse(sid(orchestrator, 0, 'pivot-exp-v1')));
    orchestrator.handleWorkerResponse(completedResponse(sid(orchestrator, 0, 'pivot-exp-v2')));

    orchestrator.handleWorkerResponse(reconciliationNeedsInputWorkResponse(rid(orchestrator, 0, 'pivot')));

    publishedDeltas = [];
    orchestrator.selectExperiment(
      rid(orchestrator, 0, 'pivot'),
      sid(orchestrator, 0, 'pivot-exp-v1'),
    );

    const recon = orchestrator.getTask(rid(orchestrator, 0, 'pivot'));
    expect(recon!.status).toBe('completed');
    expect(recon!.execution.selectedExperiment).toBe(sid(orchestrator, 0, 'pivot-exp-v1'));

    // Downstream unblocked and auto-started (remapped in-place, no clone)
    expect(orchestrator.getTask('downstream')!.status).toBe('running');
    expect(orchestrator.getTask('downstream-v2')).toBeUndefined();
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
    orchestrator.handleWorkerResponse(completedResponse(sid(orchestrator, 0, 'pivot-exp-v1')));
    orchestrator.handleWorkerResponse(completedResponse(sid(orchestrator, 0, 'pivot-exp-v2')));
    orchestrator.handleWorkerResponse(reconciliationNeedsInputWorkResponse(rid(orchestrator, 0, 'pivot')));
    orchestrator.selectExperiment(
      rid(orchestrator, 0, 'pivot'),
      sid(orchestrator, 0, 'pivot-exp-v1'),
    );

    orchestrator.handleWorkerResponse(completedResponse('downstream'));

    expect(orchestrator.getTask('downstream')!.status).toBe('completed');
    expect(orchestrator.getTask('downstream-v2')).toBeUndefined();

    // Complete the merge node
    const mergeNode = orchestrator.getAllTasks().find(t => t.config.isMergeNode && t.status === 'running');
    orchestrator.handleWorkerResponse(completedResponse(mergeNode!.id));

    const status = orchestrator.getWorkflowStatus();
    expect(status.completed).toBeGreaterThan(0);
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

    orchestrator.handleWorkerResponse(failedResponse(sid(orchestrator, 0, 'pivot-exp-v1'), 'build failed'));
    orchestrator.handleWorkerResponse(completedResponse(sid(orchestrator, 0, 'pivot-exp-v2')));

    orchestrator.handleWorkerResponse(reconciliationNeedsInputWorkResponse(rid(orchestrator, 0, 'pivot')));

    const recon = orchestrator.getTask(rid(orchestrator, 0, 'pivot'));
    expect(recon!.status).toBe('needs_input');
    expect(recon!.execution.experimentResults).toHaveLength(2);

    // Verify individual statuses
    const results = recon!.execution.experimentResults!;
    const v1Result = results.find((r) => r.id === sid(orchestrator, 0, 'pivot-exp-v1'));
    const v2Result = results.find((r) => r.id === sid(orchestrator, 0, 'pivot-exp-v2'));
    expect(v1Result!.status).toBe('failed');
    expect(v2Result!.status).toBe('completed');

    // Can still select the successful experiment and complete reconciliation
    orchestrator.selectExperiment(
      rid(orchestrator, 0, 'pivot'),
      sid(orchestrator, 0, 'pivot-exp-v2'),
    );
    expect(orchestrator.getTask(rid(orchestrator, 0, 'pivot'))!.status).toBe('completed');

    // Downstream is running (remapped in-place, recon completed after selectExperiment)
    expect(orchestrator.getTask('downstream')!.status).toBe('running');
    expect(orchestrator.getTask('downstream-v2')).toBeUndefined();
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
    orchestrator.handleWorkerResponse(completedResponse(sid(orchestrator, 0, 'pivot-exp-r1v1')));
    orchestrator.handleWorkerResponse(completedResponse(sid(orchestrator, 0, 'pivot-exp-r1v2')));

    orchestrator.handleWorkerResponse(reconciliationNeedsInputWorkResponse(rid(orchestrator, 0, 'pivot')));

    const recon1 = orchestrator.getTask(rid(orchestrator, 0, 'pivot'));
    expect(recon1).toBeDefined();
    expect(recon1!.status).toBe('needs_input');
    expect(recon1!.execution.experimentResults).toHaveLength(2);

    orchestrator.selectExperiment(
      rid(orchestrator, 0, 'pivot'),
      sid(orchestrator, 0, 'pivot-exp-r1v1'),
    );
    expect(orchestrator.getTask(rid(orchestrator, 0, 'pivot'))!.status).toBe('completed');

    // Downstream is remapped in-place and unblocked after recon completes
    expect(orchestrator.getTask('downstream')!.status).toBe('running');
    expect(orchestrator.getTask('downstream-v2')).toBeUndefined();
  });

  // ── 8. All state transitions produce deltas ────────────────

  it('all state transitions produce deltas (no lost deltas)', () => {
    orchestrator.loadPlan(standardPlan);

    // 4 created deltas from loadPlan (3 user tasks + 1 merge node)
    const createdDeltas = publishedDeltas.filter((d) => d.type === 'created');
    expect(createdDeltas).toHaveLength(4);

    publishedDeltas = [];
    orchestrator.startExecution(); // setup -> running

    // 1 delta: setup pending -> running
    const setupStartDelta = publishedDeltas.find(
      (d) => d.type === 'updated' && d.taskId === sid(orchestrator, 0, 'setup'),
    );
    expect(setupStartDelta).toBeDefined();

    publishedDeltas = [];
    orchestrator.handleWorkerResponse(completedResponse('setup'));

    // setup completed + pivot auto-started = at least 2 deltas
    const setupComplete = publishedDeltas.find(
      (d) => d.type === 'updated' && d.taskId === sid(orchestrator, 0, 'setup'),
    );
    const pivotStart = publishedDeltas.find(
      (d) => d.type === 'updated' && d.taskId === sid(orchestrator, 0, 'pivot'),
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
    // - downstream remap (dependency change from pivot to pivot-reconciliation)
    // - pivot completed (source disposition)
    // - exp-v1 created, exp-v2 created, reconciliation created (new nodes)
    // - exp-v1 started, exp-v2 started (auto-start)
    expect(publishedDeltas.length).toBeGreaterThanOrEqual(6);

    // Verify remap delta: downstream dependencies updated
    const downstreamRemap = publishedDeltas.find(
      (d) =>
        d.type === 'updated' &&
        d.taskId === sid(orchestrator, 0, 'downstream') &&
        (d.changes as any).dependencies !== undefined,
    );
    expect(downstreamRemap).toBeDefined();
    expect(orchestrator.getTask('downstream-v2')).toBeUndefined();

    // Verify experiment create deltas exist
    const e1 = sid(orchestrator, 0, 'pivot-exp-v1');
    const e2 = sid(orchestrator, 0, 'pivot-exp-v2');
    const expCreatedDeltas = publishedDeltas.filter(
      (d) => d.type === 'created' && (d.task.id === e1 || d.task.id === e2),
    );
    expect(expCreatedDeltas).toHaveLength(2);

    // Verify reconciliation create delta exists
    const reconCreated = publishedDeltas.filter(
      (d) => d.type === 'created' && d.task.id === rid(orchestrator, 0, 'pivot'),
    );
    expect(reconCreated).toHaveLength(1);

    publishedDeltas = [];
    orchestrator.handleWorkerResponse(completedResponse(e1));

    const v1CompleteDelta = publishedDeltas.find(
      (d) => d.type === 'updated' && d.taskId === e1,
    );
    expect(v1CompleteDelta).toBeDefined();

    publishedDeltas = [];
    orchestrator.handleWorkerResponse(completedResponse(e2));

    orchestrator.handleWorkerResponse(reconciliationNeedsInputWorkResponse(rid(orchestrator, 0, 'pivot')));

    const v2CompleteDelta = publishedDeltas.find(
      (d) => d.type === 'updated' && d.taskId === e2,
    );
    expect(v2CompleteDelta).toBeDefined();

    // Reconciliation trigger delta
    const reconTrigger = publishedDeltas.find(
      (d) => d.type === 'updated' && d.taskId === rid(orchestrator, 0, 'pivot'),
    );
    expect(reconTrigger).toBeDefined();

    publishedDeltas = [];
    orchestrator.selectExperiment(rid(orchestrator, 0, 'pivot'), e1);

    const reconComplete = publishedDeltas.find(
      (d) => d.type === 'updated' && d.taskId === rid(orchestrator, 0, 'pivot'),
    );
    const downstreamStart = publishedDeltas.find(
      (d) => d.type === 'updated' && d.taskId === sid(orchestrator, 0, 'downstream'),
    );
    expect(reconComplete).toBeDefined();
    expect(downstreamStart).toBeDefined();

    publishedDeltas = [];
    orchestrator.handleWorkerResponse(completedResponse('downstream'));

    const downstreamComplete = publishedDeltas.find(
      (d) => d.type === 'updated' && d.taskId === sid(orchestrator, 0, 'downstream'),
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
      const exp = orchestrator.getTask(sid(orchestrator, 0, `pivot-exp-v${i}`));
      expect(exp).toBeDefined();
      expect(exp!.status).toBe('running');
    }

    const recon = orchestrator.getTask(rid(orchestrator, 0, 'pivot'));
    expect(recon).toBeDefined();
    expect(recon!.dependencies).toHaveLength(5);

    // Complete all 5 experiments
    for (let i = 1; i <= 5; i++) {
      orchestrator.handleWorkerResponse(completedResponse(sid(orchestrator, 0, `pivot-exp-v${i}`)));
    }

    orchestrator.handleWorkerResponse(reconciliationNeedsInputWorkResponse(rid(orchestrator, 0, 'pivot')));

    expect(orchestrator.getTask(rid(orchestrator, 0, 'pivot'))!.status).toBe('needs_input');
    expect(orchestrator.getTask(rid(orchestrator, 0, 'pivot'))!.execution.experimentResults).toHaveLength(5);

    orchestrator.selectExperiment(
      rid(orchestrator, 0, 'pivot'),
      sid(orchestrator, 0, 'pivot-exp-v3'),
    );
    expect(orchestrator.getTask(rid(orchestrator, 0, 'pivot'))!.status).toBe('completed');
    expect(orchestrator.getTask(rid(orchestrator, 0, 'pivot'))!.execution.selectedExperiment).toBe(
      sid(orchestrator, 0, 'pivot-exp-v3'),
    );

    // Downstream unblocked (remapped in-place, no clone)
    expect(orchestrator.getTask('downstream')!.status).toBe('running');
    expect(orchestrator.getTask('downstream-v2')).toBeUndefined();

    // Complete downstream
    orchestrator.handleWorkerResponse(completedResponse('downstream'));

    // Complete the merge node
    const mergeNode = orchestrator.getAllTasks().find(t => t.config.isMergeNode && t.status === 'running');
    orchestrator.handleWorkerResponse(completedResponse(mergeNode!.id));

    const status = orchestrator.getWorkflowStatus();
    expect(status.completed).toBeGreaterThan(0);
    expect(status.failed).toBe(0);
    expect(status.running).toBe(0);
    expect(status.pending).toBe(0);
  });

  // ── 10. selectExperiment branch/commit propagation ────────

  describe('selectExperiment branch/commit propagation', () => {
    /** Helper: run lifecycle up to reconciliation needs_input state. */
    function runToReconciliation() {
      orchestrator.loadPlan(standardPlan);
      orchestrator.startExecution();
      orchestrator.handleWorkerResponse(completedResponse('setup'));
      orchestrator.handleWorkerResponse(
        spawnResponse('pivot', [
          { id: 'v1', prompt: 'A' },
          { id: 'v2', prompt: 'B' },
        ]),
      );
      orchestrator.handleWorkerResponse(completedResponse(sid(orchestrator, 0, 'pivot-exp-v1')));
      orchestrator.handleWorkerResponse(completedResponse(sid(orchestrator, 0, 'pivot-exp-v2')));
      orchestrator.handleWorkerResponse(reconciliationNeedsInputWorkResponse(rid(orchestrator, 0, 'pivot')));
      expect(orchestrator.getTask(rid(orchestrator, 0, 'pivot'))!.status).toBe('needs_input');
    }

    it('propagates winner branch and commit to reconciliation task', () => {
      runToReconciliation();

      // Simulate task-executor setting branch/commit on winning experiment
      persistence.updateTask(sid(orchestrator, 0, 'pivot-exp-v1'), {
        execution: {
          branch: 'experiment/pivot-exp-v1-abc12345',
          commit: 'abc123deadbeef',
        },
      });

      orchestrator.selectExperiment(rid(orchestrator, 0, 'pivot'), sid(orchestrator, 0, 'pivot-exp-v1'));

      const recon = orchestrator.getTask(rid(orchestrator, 0, 'pivot'))!;
      expect(recon.status).toBe('completed');
      expect(recon.execution.selectedExperiment).toBe(sid(orchestrator, 0, 'pivot-exp-v1'));
      expect(recon.execution.branch).toBe('experiment/pivot-exp-v1-abc12345');
      expect(recon.execution.commit).toBe('abc123deadbeef');
    });

    it('propagates branch when winner has no commit', () => {
      runToReconciliation();

      persistence.updateTask(sid(orchestrator, 0, 'pivot-exp-v2'), {
        execution: {
          branch: 'experiment/pivot-exp-v2-def45678',
        },
      });

      orchestrator.selectExperiment(rid(orchestrator, 0, 'pivot'), sid(orchestrator, 0, 'pivot-exp-v2'));

      const recon = orchestrator.getTask(rid(orchestrator, 0, 'pivot'))!;
      expect(recon.execution.branch).toBe('experiment/pivot-exp-v2-def45678');
      expect(recon.execution.commit).toBeUndefined();
    });

    it('propagates commit when winner has no branch', () => {
      runToReconciliation();

      persistence.updateTask(sid(orchestrator, 0, 'pivot-exp-v1'), {
        execution: {
          commit: 'deadbeef12345678',
        },
      });

      orchestrator.selectExperiment(rid(orchestrator, 0, 'pivot'), sid(orchestrator, 0, 'pivot-exp-v1'));

      const recon = orchestrator.getTask(rid(orchestrator, 0, 'pivot'))!;
      expect(recon.execution.branch).toBeUndefined();
      expect(recon.execution.commit).toBe('deadbeef12345678');
    });

    it('handles winner with neither branch nor commit', () => {
      runToReconciliation();

      // Don't set branch or commit on winner — default state
      orchestrator.selectExperiment(rid(orchestrator, 0, 'pivot'), sid(orchestrator, 0, 'pivot-exp-v1'));

      const recon = orchestrator.getTask(rid(orchestrator, 0, 'pivot'))!;
      expect(recon.status).toBe('completed');
      expect(recon.execution.branch).toBeUndefined();
      expect(recon.execution.commit).toBeUndefined();
    });

    it('multi-select propagates combined branch and commit', () => {
      runToReconciliation();

      orchestrator.selectExperiments(
        rid(orchestrator, 0, 'pivot'),
        [sid(orchestrator, 0, 'pivot-exp-v1'), sid(orchestrator, 0, 'pivot-exp-v2')],
        'reconciliation/pivot-reconciliation',
        'combined123',
      );

      const recon = orchestrator.getTask(rid(orchestrator, 0, 'pivot'))!;
      expect(recon.status).toBe('completed');
      expect(recon.execution.selectedExperiment).toBe(sid(orchestrator, 0, 'pivot-exp-v1'));
      expect(recon.execution.selectedExperiments).toEqual([
        sid(orchestrator, 0, 'pivot-exp-v1'),
        sid(orchestrator, 0, 'pivot-exp-v2'),
      ]);
      expect(recon.execution.branch).toBe('reconciliation/pivot-reconciliation');
      expect(recon.execution.commit).toBe('combined123');
    });

    it('propagates branch/commit even when winner experiment failed', () => {
      orchestrator.loadPlan(standardPlan);
      orchestrator.startExecution();
      orchestrator.handleWorkerResponse(completedResponse('setup'));
      orchestrator.handleWorkerResponse(
        spawnResponse('pivot', [
          { id: 'v1', prompt: 'A' },
          { id: 'v2', prompt: 'B' },
        ]),
      );

      // Fail v1 (but it still has branch/commit from before failure)
      orchestrator.handleWorkerResponse(failedResponse(sid(orchestrator, 0, 'pivot-exp-v1'), 'build failed'));
      orchestrator.handleWorkerResponse(completedResponse(sid(orchestrator, 0, 'pivot-exp-v2')));

      orchestrator.handleWorkerResponse(reconciliationNeedsInputWorkResponse(rid(orchestrator, 0, 'pivot')));

      persistence.updateTask(sid(orchestrator, 0, 'pivot-exp-v1'), {
        execution: {
          branch: 'experiment/pivot-exp-v1-failed',
          commit: 'failed123',
        },
      });

      orchestrator.selectExperiment(rid(orchestrator, 0, 'pivot'), sid(orchestrator, 0, 'pivot-exp-v1'));

      const recon = orchestrator.getTask(rid(orchestrator, 0, 'pivot'))!;
      expect(recon.status).toBe('completed');
      expect(recon.execution.branch).toBe('experiment/pivot-exp-v1-failed');
      expect(recon.execution.commit).toBe('failed123');
    });
  });

  // ── 11. Multi-select experiment lifecycle ────────────────

  it('multi-select experiment lifecycle: 3 variants, select 2, downstream unblocks', () => {
    const plan: PlanDefinition = {
      name: 'multi-select-lifecycle',
      tasks: [
        { id: 'setup', description: 'Setup' },
        { id: 'pivot', description: 'Pivot', dependencies: ['setup'], pivot: true },
        { id: 'downstream', description: 'Downstream', dependencies: ['pivot'] },
      ],
    };

    orchestrator.loadPlan(plan);
    orchestrator.startExecution();
    orchestrator.handleWorkerResponse(completedResponse('setup'));

    // Spawn 3 variants
    orchestrator.handleWorkerResponse(
      spawnResponse('pivot', [
        { id: 'v1', prompt: 'Approach A' },
        { id: 'v2', prompt: 'Approach B' },
        { id: 'v3', prompt: 'Approach C' },
      ]),
    );

    // All 3 experiments running
    expect(orchestrator.getTask(sid(orchestrator, 0, 'pivot-exp-v1'))!.status).toBe('running');
    expect(orchestrator.getTask(sid(orchestrator, 0, 'pivot-exp-v2'))!.status).toBe('running');
    expect(orchestrator.getTask(sid(orchestrator, 0, 'pivot-exp-v3'))!.status).toBe('running');

    orchestrator.handleWorkerResponse(completedResponse(sid(orchestrator, 0, 'pivot-exp-v1')));
    orchestrator.handleWorkerResponse(completedResponse(sid(orchestrator, 0, 'pivot-exp-v2')));
    orchestrator.handleWorkerResponse(completedResponse(sid(orchestrator, 0, 'pivot-exp-v3')));

    orchestrator.handleWorkerResponse(reconciliationNeedsInputWorkResponse(rid(orchestrator, 0, 'pivot')));

    const recon = orchestrator.getTask(rid(orchestrator, 0, 'pivot'))!;
    expect(recon.status).toBe('needs_input');
    expect(recon.execution.experimentResults).toHaveLength(3);

    // Multi-select: pick v1 and v3
    orchestrator.selectExperiments(
      rid(orchestrator, 0, 'pivot'),
      [sid(orchestrator, 0, 'pivot-exp-v1'), sid(orchestrator, 0, 'pivot-exp-v3')],
      'reconciliation/pivot-reconciliation',
      'merged-abc',
    );

    const reconAfter = orchestrator.getTask(rid(orchestrator, 0, 'pivot'))!;
    expect(reconAfter.status).toBe('completed');
    expect(reconAfter.execution.selectedExperiment).toBe(sid(orchestrator, 0, 'pivot-exp-v1'));
    expect(reconAfter.execution.selectedExperiments).toEqual([
      sid(orchestrator, 0, 'pivot-exp-v1'),
      sid(orchestrator, 0, 'pivot-exp-v3'),
    ]);
    expect(reconAfter.execution.branch).toBe('reconciliation/pivot-reconciliation');
    expect(reconAfter.execution.commit).toBe('merged-abc');

    // Downstream remapped in-place and now running
    expect(orchestrator.getTask('downstream')!.status).toBe('running');
    expect(orchestrator.getTask('downstream-v2')).toBeUndefined();

    // Complete downstream and merge node
    orchestrator.handleWorkerResponse(completedResponse('downstream'));
    const mergeNode = orchestrator.getAllTasks().find(t => t.config.isMergeNode && t.status === 'running');
    orchestrator.handleWorkerResponse(completedResponse(mergeNode!.id));

    const status = orchestrator.getWorkflowStatus();
    expect(status.failed).toBe(0);
    expect(status.running).toBe(0);
    expect(status.pending).toBe(0);
  });
});
