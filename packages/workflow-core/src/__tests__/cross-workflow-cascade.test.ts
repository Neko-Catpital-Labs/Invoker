import { describe, it, expect, beforeEach } from 'vitest';
import {
  Orchestrator,
  type OrchestratorPersistence,
  type OrchestratorMessageBus,
} from '../orchestrator.js';
import {
  applyInvalidation,
  type InvalidationDeps,
  type InvalidationScope,
} from '../invalidation-policy.js';
import type { TaskState, TaskStateChanges, Attempt } from '../task-types.js';
import type { WorkResponse } from '@invoker/contracts';

// ── In-memory fixtures (mirrors cancel-first-invariant.test.ts) ──

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
  }>();
  tasks = new Map<string, { workflowId: string; task: TaskState }>();
  private attempts = new Map<string, Attempt[]>();
  events: Array<{ taskId: string; eventType: string; payload?: unknown }> = [];

  saveWorkflow(workflow: {
    id: string;
    name: string;
    status: string;
    repoUrl?: string;
    baseBranch?: string;
    featureBranch?: string;
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
  loadWorkflow(workflowId: string): { repoUrl?: string; baseBranch?: string; featureBranch?: string } | undefined {
    const wf = this.workflows.get(workflowId);
    return wf
      ? { repoUrl: wf.repoUrl, baseBranch: wf.baseBranch, featureBranch: wf.featureBranch }
      : undefined;
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

function makeOrchestrator(persistence: OrchestratorPersistence): Orchestrator {
  return new Orchestrator({
    persistence,
    messageBus: new InMemoryBus(),
    maxConcurrency: 8,
  });
}

function buildOrchestratorDeps(orchestrator: Orchestrator): InvalidationDeps {
  return {
    cancelInFlight: async (scope, id) => {
      if (scope === 'none') return;
      try {
        if (scope === 'task') {
          orchestrator.cancelTask(id);
          return;
        }
        orchestrator.cancelWorkflow(id);
      } catch (e) {
        // Already-terminal targets have nothing to cancel; the rest
        // of the pipeline still runs.
        const code = (e as { code?: string })?.code;
        if (code === 'TASK_ALREADY_TERMINAL' || code === 'WORKFLOW_ALREADY_TERMINAL') return;
        throw e;
      }
    },
    retryTask: (taskId) => orchestrator.retryTask(taskId),
    recreateTask: (taskId) => orchestrator.recreateTask(taskId),
    retryWorkflow: (workflowId) => orchestrator.retryWorkflow(workflowId),
    recreateWorkflow: (workflowId) => orchestrator.recreateWorkflow(workflowId),
    recreateWorkflowFromFreshBase: (workflowId) =>
      orchestrator.recreateWorkflowFromFreshBase(workflowId, {
        refreshBase: async () => ({ commit: 'fresh-sha' }),
      }),
    workflowFork: (workflowId) => {
      const result = orchestrator.forkWorkflow(workflowId);
      return result.started;
    },
    cascadeDownstream: (scope: InvalidationScope, id: string) => {
      const workflowId =
        scope === 'workflow'
          ? id
          : orchestrator.getTask(id)?.config.workflowId;
      if (!workflowId) return [];
      return orchestrator.cascadeInvalidationToDownstream(workflowId);
    },
  };
}

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

/**
 * Drive a chain of two workflows so the downstream first task has cleared the
 * external merge-gate dependency, runs to completion locally, and a downstream
 * later task is currently `running`. This mirrors the production scenario in
 * `~/.invoker/invoker.db` for WF-INV-113 → WF-INV-55 (see plan reproduction
 * notes) where the upstream merge gate cleared once, the downstream cascaded
 * forward on local deps, and an upstream recreate fails to invalidate
 * downstream work.
 */
function setupChain(orchestrator: Orchestrator): {
  upstreamWfId: string;
  upstreamTaskId: string;
  upstreamMergeId: string;
  downstreamWfId: string;
  downstreamRootId: string;
  downstreamMidId: string;
  downstreamLastId: string;
  downstreamMergeId: string;
} {
  orchestrator.loadPlan({
    name: 'upstream-workflow',
    baseBranch: 'master',
    featureBranch: 'feature/upstream',
    tasks: [{ id: 'verify-upstream', description: 'upstream prerequisite' }],
  });
  const upstreamTaskId = orchestrator.getAllTasks().find(
    (t) => !t.config.isMergeNode && t.id.endsWith('/verify-upstream'),
  )!.id;
  const upstreamWfId = upstreamTaskId.split('/')[0]!;
  const upstreamMergeId = `__merge__${upstreamWfId}`;

  orchestrator.loadPlan({
    name: 'downstream-workflow',
    baseBranch: 'feature/upstream',
    featureBranch: 'feature/downstream',
    tasks: [
      {
        id: 'root',
        description: 'downstream root waits for upstream merge gate',
        externalDependencies: [{ workflowId: upstreamWfId, gatePolicy: 'completed' }],
      },
      {
        id: 'mid',
        description: 'downstream mid depends on root',
        dependencies: ['root'],
      },
      {
        id: 'last',
        description: 'downstream last depends on mid',
        dependencies: ['mid'],
      },
    ],
  });

  const downstreamRootId = orchestrator.getAllTasks().find(
    (t) => t.id.endsWith('/root'),
  )!.id;
  const downstreamWfId = downstreamRootId.split('/')[0]!;
  const downstreamMidId = `${downstreamWfId}/mid`;
  const downstreamLastId = `${downstreamWfId}/last`;
  const downstreamMergeId = `__merge__${downstreamWfId}`;

  // Drive the upstream task and merge gate to `completed` so the
  // downstream root clears the external dependency and runs.
  orchestrator.startExecution();
  orchestrator.handleWorkerResponse(makeResponse({ actionId: upstreamTaskId, status: 'completed' }));
  orchestrator.handleWorkerResponse(makeResponse({ actionId: upstreamMergeId, status: 'completed' }));

  // Downstream root should now be running.
  expect(orchestrator.getTask(downstreamRootId)!.status).toBe('running');

  // Cascade downstream root → mid → last on local deps.
  orchestrator.handleWorkerResponse(makeResponse({ actionId: downstreamRootId, status: 'completed' }));
  orchestrator.handleWorkerResponse(makeResponse({ actionId: downstreamMidId, status: 'completed' }));

  // Downstream `last` is now running locally; merge gate still pending.
  expect(orchestrator.getTask(downstreamLastId)!.status).toBe('running');
  expect(orchestrator.getTask(downstreamMergeId)!.status).toBe('pending');

  return {
    upstreamWfId,
    upstreamTaskId,
    upstreamMergeId,
    downstreamWfId,
    downstreamRootId,
    downstreamMidId,
    downstreamLastId,
    downstreamMergeId,
  };
}

describe('cross-workflow cascade — upstream invalidation propagates downstream', () => {
  let persistence: InMemoryPersistence;
  let orchestrator: Orchestrator;
  let deps: InvalidationDeps;

  beforeEach(() => {
    persistence = new InMemoryPersistence();
    orchestrator = makeOrchestrator(persistence);
    deps = buildOrchestratorDeps(orchestrator);
  });

  it('recreateWorkflow on upstream cancels in-flight downstream and resets every downstream task to pending', async () => {
    const ctx = setupChain(orchestrator);

    await applyInvalidation('workflow', 'recreateWorkflow', ctx.upstreamWfId, deps);

    expect(orchestrator.getTask(ctx.upstreamMergeId)!.status).toBe('pending');

    for (const id of [
      ctx.downstreamRootId,
      ctx.downstreamMidId,
      ctx.downstreamLastId,
      ctx.downstreamMergeId,
    ]) {
      expect(orchestrator.getTask(id)!.status, `${id} should be pending after upstream recreateWorkflow`).toBe('pending');
    }

    const lastEvents = persistence.events.filter((e) => e.taskId === ctx.downstreamLastId);
    const cancelIdx = lastEvents.findIndex((e) => e.eventType === 'task.cancelled');
    const pendingIdx = lastEvents.findIndex((e) => e.eventType === 'task.pending');
    expect(cancelIdx, `expected task.cancelled for ${ctx.downstreamLastId}; got ${lastEvents.map((e) => e.eventType).join(',')}`).toBeGreaterThanOrEqual(0);
    expect(pendingIdx).toBeGreaterThanOrEqual(0);
    expect(cancelIdx).toBeLessThan(pendingIdx);
  });

  it('recreateTask on an upstream task also cascades downstream', async () => {
    const ctx = setupChain(orchestrator);

    await applyInvalidation('task', 'recreateTask', ctx.upstreamTaskId, deps);

    for (const id of [
      ctx.downstreamRootId,
      ctx.downstreamMidId,
      ctx.downstreamLastId,
      ctx.downstreamMergeId,
    ]) {
      expect(orchestrator.getTask(id)!.status, `${id} should be pending after upstream recreateTask`).toBe('pending');
    }
  });

  it('retryWorkflow on upstream cascades downstream', async () => {
    const ctx = setupChain(orchestrator);

    orchestrator.handleWorkerResponse(makeResponse({
      actionId: ctx.upstreamMergeId,
      status: 'failed',
      outputs: { exitCode: 1, error: 'boom' },
    }));
    await applyInvalidation('workflow', 'retryWorkflow', ctx.upstreamWfId, deps);

    for (const id of [
      ctx.downstreamRootId,
      ctx.downstreamMidId,
      ctx.downstreamLastId,
      ctx.downstreamMergeId,
    ]) {
      expect(orchestrator.getTask(id)!.status, `${id} should be pending after upstream retryWorkflow`).toBe('pending');
    }
  });

  it('retryTask on an upstream task cascades downstream', async () => {
    const ctx = setupChain(orchestrator);

    orchestrator.handleWorkerResponse(makeResponse({
      actionId: ctx.upstreamMergeId,
      status: 'failed',
      outputs: { exitCode: 1, error: 'boom' },
    }));
    await applyInvalidation('task', 'retryTask', ctx.upstreamMergeId, deps);

    for (const id of [
      ctx.downstreamRootId,
      ctx.downstreamMidId,
      ctx.downstreamLastId,
      ctx.downstreamMergeId,
    ]) {
      expect(orchestrator.getTask(id)!.status, `${id} should be pending after upstream retryTask`).toBe('pending');
    }
  });

  it('recreateWorkflowFromFreshBase on upstream cascades downstream', async () => {
    const ctx = setupChain(orchestrator);

    await applyInvalidation(
      'workflow',
      'recreateWorkflowFromFreshBase',
      ctx.upstreamWfId,
      deps,
    );

    for (const id of [
      ctx.downstreamRootId,
      ctx.downstreamMidId,
      ctx.downstreamLastId,
      ctx.downstreamMergeId,
    ]) {
      expect(orchestrator.getTask(id)!.status, `${id} should be pending after upstream recreateWorkflowFromFreshBase`).toBe('pending');
    }
  });

  it('cascade is transitive: A → B → C, recreating A pends every task in B and C', async () => {
    // Workflow A
    orchestrator.loadPlan({
      name: 'wf-a',
      baseBranch: 'master',
      featureBranch: 'feature/a',
      tasks: [{ id: 'a-task', description: 'A' }],
    });
    const aTaskId = orchestrator.getAllTasks().find((t) => t.id.endsWith('/a-task'))!.id;
    const aWfId = aTaskId.split('/')[0]!;
    const aMergeId = `__merge__${aWfId}`;

    // Workflow B depends on A
    orchestrator.loadPlan({
      name: 'wf-b',
      baseBranch: 'feature/a',
      featureBranch: 'feature/b',
      tasks: [
        {
          id: 'b-task',
          description: 'B depends on A merge gate',
          externalDependencies: [{ workflowId: aWfId, gatePolicy: 'completed' }],
        },
      ],
    });
    const bTaskId = orchestrator.getAllTasks().find((t) => t.id.endsWith('/b-task'))!.id;
    const bWfId = bTaskId.split('/')[0]!;
    const bMergeId = `__merge__${bWfId}`;

    // Workflow C depends on B
    orchestrator.loadPlan({
      name: 'wf-c',
      baseBranch: 'feature/b',
      featureBranch: 'feature/c',
      tasks: [
        {
          id: 'c-task',
          description: 'C depends on B merge gate',
          externalDependencies: [{ workflowId: bWfId, gatePolicy: 'completed' }],
        },
      ],
    });
    const cTaskId = orchestrator.getAllTasks().find((t) => t.id.endsWith('/c-task'))!.id;
    const cWfId = cTaskId.split('/')[0]!;
    const cMergeId = `__merge__${cWfId}`;

    // Drive A → B → C all to running by chaining merge-gate completions.
    orchestrator.startExecution();
    orchestrator.handleWorkerResponse(makeResponse({ actionId: aTaskId, status: 'completed' }));
    orchestrator.handleWorkerResponse(makeResponse({ actionId: aMergeId, status: 'completed' }));
    orchestrator.handleWorkerResponse(makeResponse({ actionId: bTaskId, status: 'completed' }));
    orchestrator.handleWorkerResponse(makeResponse({ actionId: bMergeId, status: 'completed' }));

    expect(orchestrator.getTask(cTaskId)!.status).toBe('running');

    await applyInvalidation('workflow', 'recreateWorkflow', aWfId, deps);

    for (const id of [bTaskId, bMergeId, cTaskId, cMergeId]) {
      expect(orchestrator.getTask(id)!.status, `${id} should be pending after transitive cascade`).toBe('pending');
    }
  });
});
