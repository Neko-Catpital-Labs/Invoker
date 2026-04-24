import { describe, it, expect, vi } from 'vitest';
import {
  applyInvalidation,
  MUTATION_POLICIES,
  type InvalidationAction,
  type InvalidationDeps,
  type InvalidationScope,
  type MutationKey,
} from '../invalidation-policy.js';
import {
  Orchestrator,
  type OrchestratorPersistence,
  type OrchestratorMessageBus,
} from '../orchestrator.js';
import type { TaskState, TaskStateChanges, Attempt } from '../task-types.js';

// ── In-memory fixtures (focused, mirrors orchestrator.test.ts) ──

class InMemoryPersistence implements OrchestratorPersistence {
  workflows = new Map<string, {
    id: string;
    name: string;
    status: string;
    createdAt: string;
    updatedAt: string;
    repoUrl?: string;
    mergeMode?: 'manual' | 'automatic' | 'external_review';
  }>();
  tasks = new Map<string, { workflowId: string; task: TaskState }>();
  private attempts = new Map<string, Attempt[]>();
  events: Array<{ taskId: string; eventType: string; payload?: unknown }> = [];

  saveWorkflow(workflow: {
    id: string;
    name: string;
    status: string;
    repoUrl?: string;
    mergeMode?: 'manual' | 'automatic' | 'external_review';
  }): void {
    const now = new Date().toISOString();
    this.workflows.set(workflow.id, {
      ...workflow,
      repoUrl: workflow.repoUrl ?? 'memory://test-repo',
      createdAt: (workflow as { createdAt?: string }).createdAt ?? now,
      updatedAt: (workflow as { updatedAt?: string }).updatedAt ?? now,
    });
  }
  updateWorkflow(): void {}
  loadWorkflow(workflowId: string): { repoUrl?: string } | undefined {
    const wf = this.workflows.get(workflowId);
    return wf ? { repoUrl: wf.repoUrl } : undefined;
  }
  saveTask(workflowId: string, task: TaskState): void {
    this.tasks.set(task.id, { workflowId, task });
  }
  getTaskEntry(taskId: string): { workflowId: string; task: TaskState } | undefined {
    return this.tasks.get(taskId);
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
  listWorkflows() { return Array.from(this.workflows.values()); }
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
  loadAttempts(nodeId: string): Attempt[] { return this.attempts.get(nodeId) ?? []; }
  loadAttempt(attemptId: string): Attempt | undefined {
    for (const list of this.attempts.values()) {
      const found = list.find((a) => a.id === attemptId);
      if (found) return found;
    }
    return undefined;
  }
  updateAttempt(
    attemptId: string,
    changes: Partial<Pick<Attempt,
      | 'status' | 'startedAt' | 'completedAt' | 'exitCode' | 'error'
      | 'lastHeartbeatAt' | 'branch' | 'commit' | 'summary'
      | 'workspacePath' | 'agentSessionId' | 'containerId' | 'mergeConflict'>>,
  ): void {
    for (const list of this.attempts.values()) {
      const idx = list.findIndex((a) => a.id === attemptId);
      if (idx !== -1) {
        list[idx] = { ...list[idx], ...changes } as Attempt;
        return;
      }
    }
  }
  deleteWorkflow(workflowId: string): void {
    this.workflows.delete(workflowId);
    for (const [id, entry] of this.tasks) {
      if (entry.workflowId === workflowId) this.tasks.delete(id);
    }
  }
  deleteAllWorkflows(): void { this.workflows.clear(); this.tasks.clear(); }
}

class InMemoryBus implements OrchestratorMessageBus {
  publish<T>(_channel: string, _message: T): void {}
  subscribe(_channel: string, _handler: (msg: unknown) => void): () => void {
    return () => undefined;
  }
}

// ── Sub-suite 1: applyInvalidation routing per MUTATION_POLICIES ──

interface SpyDeps {
  deps: InvalidationDeps;
  callOrder: string[];
  spies: {
    cancelInFlight: ReturnType<typeof vi.fn>;
    retryTask: ReturnType<typeof vi.fn>;
    recreateTask: ReturnType<typeof vi.fn>;
    retryWorkflow: ReturnType<typeof vi.fn>;
    recreateWorkflow: ReturnType<typeof vi.fn>;
    recreateWorkflowFromFreshBase: ReturnType<typeof vi.fn>;
    workflowFork: ReturnType<typeof vi.fn>;
    scheduleOnly: ReturnType<typeof vi.fn>;
    fixApprove: ReturnType<typeof vi.fn>;
    fixReject: ReturnType<typeof vi.fn>;
  };
}

function buildSpyDeps(): SpyDeps {
  const callOrder: string[] = [];
  const tag = (name: string) => async (...args: unknown[]) => {
    callOrder.push(`${name}:${args.join(':')}`);
    return [] as TaskState[];
  };
  const cancelInFlight = vi.fn(tag('cancelInFlight'));
  const retryTask = vi.fn(tag('retryTask'));
  const recreateTask = vi.fn(tag('recreateTask'));
  const retryWorkflow = vi.fn(tag('retryWorkflow'));
  const recreateWorkflow = vi.fn(tag('recreateWorkflow'));
  const recreateWorkflowFromFreshBase = vi.fn(tag('recreateWorkflowFromFreshBase'));
  const workflowFork = vi.fn(tag('workflowFork'));
  const scheduleOnly = vi.fn(tag('scheduleOnly'));
  const fixApprove = vi.fn(tag('fixApprove'));
  const fixReject = vi.fn(tag('fixReject'));
  return {
    deps: {
      cancelInFlight,
      retryTask,
      recreateTask,
      retryWorkflow,
      recreateWorkflow,
      recreateWorkflowFromFreshBase,
      workflowFork,
      scheduleOnly,
      fixApprove,
      fixReject,
    },
    callOrder,
    spies: {
      cancelInFlight,
      retryTask,
      recreateTask,
      retryWorkflow,
      recreateWorkflow,
      recreateWorkflowFromFreshBase,
      workflowFork,
      scheduleOnly,
      fixApprove,
      fixReject,
    },
  };
}

const TASK_SCOPED_ACTIONS = new Set<InvalidationAction>([
  'retryTask',
  'recreateTask',
]);
const WORKFLOW_SCOPED_ACTIONS = new Set<InvalidationAction>([
  'retryWorkflow',
  'recreateWorkflow',
  'recreateWorkflowFromFreshBase',
  'workflowFork',
]);
const NON_INVALIDATING_ACTIONS = new Set<InvalidationAction>([
  'scheduleOnly',
  'fixApprove',
  'fixReject',
  'none',
]);

function classify(action: InvalidationAction): {
  invalidating: boolean;
  scope: InvalidationScope;
  expectedDep: keyof SpyDeps['spies'] | null;
} {
  if (action === 'none') return { invalidating: false, scope: 'none', expectedDep: null };
  if (NON_INVALIDATING_ACTIONS.has(action)) {
    return {
      invalidating: false,
      scope: 'task',
      expectedDep: action as keyof SpyDeps['spies'],
    };
  }
  if (TASK_SCOPED_ACTIONS.has(action)) {
    return { invalidating: true, scope: 'task', expectedDep: action as keyof SpyDeps['spies'] };
  }
  if (WORKFLOW_SCOPED_ACTIONS.has(action)) {
    return { invalidating: true, scope: 'workflow', expectedDep: action as keyof SpyDeps['spies'] };
  }
  throw new Error(`Unclassified action: ${action}`);
}

describe('cancel-first invariant — policy-table iteration', () => {
  // Walk every entry in MUTATION_POLICIES so any future policy
  // addition is forced to classify itself per the chart.
  const allEntries = Object.entries(MUTATION_POLICIES) as Array<[
    MutationKey,
    typeof MUTATION_POLICIES[MutationKey],
  ]>;

  it('covers every MUTATION_POLICIES entry (no gaps in the audit)', () => {
    expect(allEntries.length).toBeGreaterThan(0);
    for (const [key, policy] of allEntries) {
      expect(policy.action, `MUTATION_POLICIES.${key} missing action`).toBeTruthy();
    }
  });

  for (const [key, policy] of allEntries) {
    const { invalidating, scope, expectedDep } = classify(policy.action);
    const id = scope === 'workflow' ? `wf-${key}` : `t-${key}`;

    it(`MUTATION_POLICIES.${key} (action=${policy.action}) → ${
      invalidating ? 'cancelInFlight BEFORE' : 'NO cancelInFlight then'
    } deps.${expectedDep ?? '(none)'}`, async () => {
      const { deps, spies, callOrder } = buildSpyDeps();

      await applyInvalidation(scope, policy.action, id, deps);

      if (invalidating) {
        expect(spies.cancelInFlight, `expected cancelInFlight for ${policy.action}`).toHaveBeenCalledTimes(1);
        expect(spies.cancelInFlight).toHaveBeenCalledWith(scope, id);
        expect(expectedDep).not.toBeNull();
        const depSpy = spies[expectedDep as keyof SpyDeps['spies']];
        expect(depSpy).toHaveBeenCalledWith(id);

        const cancelIdx = callOrder.findIndex((e) => e.startsWith('cancelInFlight:'));
        const lifecycleIdx = callOrder.findIndex((e) => e.startsWith(`${expectedDep}:`));
        expect(cancelIdx, `cancelInFlight missing from call order: ${callOrder.join(' -> ')}`).toBeGreaterThanOrEqual(0);
        expect(lifecycleIdx).toBeGreaterThanOrEqual(0);
        expect(
          cancelIdx,
          `cancel-first invariant violated for ${policy.action}: order=${callOrder.join(' -> ')}`,
        ).toBeLessThan(lifecycleIdx);
      } else {
        // Non-invalidating outliers (scheduleOnly / fixApprove /
        // fixReject) MUST NOT cancel; that is the chart's
        // intentional carve-out (Steps 15 + 16).
        expect(
          spies.cancelInFlight,
          `cancel-first leak: ${policy.action} should NOT call cancelInFlight`,
        ).not.toHaveBeenCalled();
        if (expectedDep) {
          const depSpy = spies[expectedDep as keyof SpyDeps['spies']];
          expect(depSpy).toHaveBeenCalledWith(id);
        }
      }
    });
  }

  it('aborts BEFORE the lifecycle dep when cancelInFlight rejects (cross-action lock-in)', async () => {
    // A failed cancel MUST NOT leave a lifecycle dep called —
    // this is the same lock-in lifecycle-matrix.test.ts asserts
    // for the canonical 5-cell matrix; here we re-check a sample
    // invalidating action to keep the cross-cutting guarantee
    // self-contained.
    const { deps, spies } = buildSpyDeps();
    spies.cancelInFlight.mockRejectedValueOnce(new Error('boom-cancel-first'));

    await expect(
      applyInvalidation('task', 'recreateTask', 't-rejected', deps),
    ).rejects.toThrow('boom-cancel-first');

    expect(spies.recreateTask).not.toHaveBeenCalled();
  });
});

// ── Sub-suite 2: direct primitive calls bypass applyInvalidation ──

function seedActiveTask(p: InMemoryPersistence, wfId: string, taskId: string): void {
  p.saveWorkflow({ id: wfId, name: 'fixture', status: 'running' });
  p.saveTask(wfId, {
    id: taskId,
    description: 'Active task',
    status: 'running',
    dependencies: [],
    createdAt: new Date(),
    config: { workflowId: wfId },
    execution: { startedAt: new Date(), selectedAttemptId: `${taskId}-att-0` },
  });
  p.saveTask(wfId, {
    id: `__merge__${wfId}`,
    description: 'Workflow gate',
    status: 'pending',
    dependencies: [taskId],
    createdAt: new Date(),
    config: { workflowId: wfId, isMergeNode: true, executorType: 'merge' },
    execution: {},
  });
}

function makeOrchestrator(p: InMemoryPersistence): Orchestrator {
  // Disable scheduling drains so the test observes the post-reset
  // state without auto-restart side effects (some primitives
  // auto-start ready tasks which would re-launch the cancelled
  // task into 'running' on the same tick — irrelevant to the
  // cancel-first invariant being asserted here).
  return new Orchestrator({
    persistence: p,
    messageBus: new InMemoryBus(),
    maxConcurrency: 0,
  });
}

describe('cancel-first invariant — direct primitive calls bypass applyInvalidation', () => {
  // Every direct caller (CommandService.retryTask /
  // CommandService.recreateTask /
  // CommandService.retryWorkflow /
  // CommandService.recreateWorkflow /
  // CommandService.recreateWorkflowFromFreshBase, plus
  // forkWorkflow's existing internal cancel) MUST emit a
  // `task.cancelled` event for the active task BEFORE any
  // task.pending / task.forked reset event for that task.

  function expectCancelBeforeReset(
    p: InMemoryPersistence,
    taskId: string,
    resetEventTypes: readonly string[],
  ): void {
    const cancelIdx = p.events.findIndex(
      (e) => e.taskId === taskId && e.eventType === 'task.cancelled',
    );
    expect(
      cancelIdx,
      `expected task.cancelled for ${taskId}, got events: ${p.events
        .filter((e) => e.taskId === taskId)
        .map((e) => e.eventType)
        .join(',')}`,
    ).toBeGreaterThanOrEqual(0);
    for (const evType of resetEventTypes) {
      const resetIdx = p.events.findIndex(
        (e) => e.taskId === taskId && e.eventType === evType,
      );
      if (resetIdx === -1) continue;
      expect(
        cancelIdx,
        `cancel-first violated for ${taskId}: ${evType} (idx=${resetIdx}) must come AFTER task.cancelled (idx=${cancelIdx})`,
      ).toBeLessThan(resetIdx);
    }
  }

  it('retryTask cancels the active task BEFORE resetting it', () => {
    const p = new InMemoryPersistence();
    const wfId = 'wf-direct-retry-task';
    seedActiveTask(p, wfId, 't1');
    const o = makeOrchestrator(p);
    o.syncFromDb(wfId);

    o.retryTask('t1');

    expectCancelBeforeReset(p, 't1', ['task.pending']);
  });

  it('recreateTask cancels the active task BEFORE resetting it', () => {
    const p = new InMemoryPersistence();
    const wfId = 'wf-direct-recreate-task';
    seedActiveTask(p, wfId, 't1');
    const o = makeOrchestrator(p);
    o.syncFromDb(wfId);

    o.recreateTask('t1');

    expectCancelBeforeReset(p, 't1', ['task.pending']);
  });

  it('retryWorkflow cancels the active task BEFORE resetting it', () => {
    const p = new InMemoryPersistence();
    const wfId = 'wf-direct-retry-wf';
    seedActiveTask(p, wfId, 't1');
    const o = makeOrchestrator(p);
    o.syncFromDb(wfId);

    o.retryWorkflow(wfId);

    expectCancelBeforeReset(p, 't1', ['task.pending']);
  });

  it('recreateWorkflow cancels the active task BEFORE resetting it', () => {
    const p = new InMemoryPersistence();
    const wfId = 'wf-direct-recreate-wf';
    seedActiveTask(p, wfId, 't1');
    const o = makeOrchestrator(p);
    o.syncFromDb(wfId);

    o.recreateWorkflow(wfId);

    expectCancelBeforeReset(p, 't1', ['task.pending']);
  });

  it('recreateWorkflowFromFreshBase cancels the active task BEFORE resetting it', async () => {
    const p = new InMemoryPersistence();
    const wfId = 'wf-direct-fresh-base';
    seedActiveTask(p, wfId, 't1');
    const o = makeOrchestrator(p);
    o.syncFromDb(wfId);

    await o.recreateWorkflowFromFreshBase(wfId, {
      refreshBase: async () => ({ commit: 'fresh-sha' }),
    });

    expectCancelBeforeReset(p, 't1', ['task.pending']);
  });

  it('forkWorkflow cancels the source workflow BEFORE forking (Step 14 invariant, re-checked here)', () => {
    const p = new InMemoryPersistence();
    const wfId = 'wf-direct-fork';
    seedActiveTask(p, wfId, 't1');
    const o = makeOrchestrator(p);
    o.syncFromDb(wfId);

    o.forkWorkflow(wfId, { autoStart: false });

    // forkWorkflow is the one primitive that already wired its
    // own cancel-first call (Step 14). This test is a regression
    // guard that the cancel still runs and is recorded as a
    // task.cancelled event for the active task on the source
    // workflow, BEFORE any task.forked_from event for the
    // forked successor.
    const cancelIdx = p.events.findIndex(
      (e) => e.taskId === 't1' && e.eventType === 'task.cancelled',
    );
    expect(cancelIdx).toBeGreaterThanOrEqual(0);

    const forkedFromIdx = p.events.findIndex(
      (e) => e.eventType === 'task.forked_from',
    );
    if (forkedFromIdx !== -1) {
      expect(cancelIdx).toBeLessThan(forkedFromIdx);
    }
  });

  it('the cancel marker on the cancelled task is the explicit step-18 cancel-before-invalidation error', () => {
    // Anchor the marker string so future audits / log scrapers
    // can grep for cancel-first interventions on retry-class /
    // recreate-class paths.
    const p = new InMemoryPersistence();
    const wfId = 'wf-direct-marker';
    seedActiveTask(p, wfId, 't1');
    const o = makeOrchestrator(p);
    o.syncFromDb(wfId);

    o.recreateTask('t1');

    const cancelEvent = p.events.find(
      (e) => e.taskId === 't1' && e.eventType === 'task.cancelled',
    );
    expect(cancelEvent).toBeDefined();
    const payload = cancelEvent!.payload as TaskStateChanges | undefined;
    expect(payload?.execution?.error).toMatch(/Cancelled before .*invalidation/);
  });
});
