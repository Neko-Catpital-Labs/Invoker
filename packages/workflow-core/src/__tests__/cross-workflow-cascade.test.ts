import { describe, it, expect, beforeEach } from 'vitest';
import { Orchestrator } from '../orchestrator.js';
import {
  applyInvalidation,
  type InvalidationDeps,
  type InvalidationScope,
} from '../invalidation-policy.js';
import {
  InMemoryPersistence,
  makeOrchestrator,
  makeResponse,
  setupChain,
} from './helpers/cross-workflow-cascade-helpers.js';

/**
 * Build `InvalidationDeps` that mirrors the production wiring in
 * `packages/app/src/workflow-actions.ts::buildInvalidationDeps`,
 * minus the generation-bump wrapper (the orchestrator primitives
 * are sufficient to verify the cascade contract).
 *
 * Crucially this includes the `cascadeDownstream` hook so
 * `applyInvalidation` propagates upstream invalidations to every
 * transitive downstream workflow.
 */
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
        // Already-terminal targets surface `TASK_ALREADY_TERMINAL` /
        // `WORKFLOW_ALREADY_TERMINAL`. Cancel-first is a hard
        // invariant only for active work; an already-terminal target
        // has nothing to cancel and the rest of the invalidation
        // (reset-to-pending + cascade) must still run.
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

    // Upstream merge gate is reset (it depends on a non-finished leaf,
    // so it will not auto-restart). The upstream root task may auto-start
    // again because recreateWorkflow drains ready tasks; we don't assert
    // on that here — the contract under test is the downstream cascade.
    expect(orchestrator.getTask(ctx.upstreamMergeId)!.status).toBe('pending');

    // Every downstream task — including the merge gate — must be `pending`
    // and the previously-`running` `last` task must have been cancelled.
    for (const id of [
      ctx.downstreamRootId,
      ctx.downstreamMidId,
      ctx.downstreamLastId,
      ctx.downstreamMergeId,
    ]) {
      expect(orchestrator.getTask(id)!.status, `${id} should be pending after upstream recreateWorkflow`).toBe('pending');
    }

    // The cancel-before-invalidation marker must be recorded for the
    // active downstream task before its reset event.
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

    // Downstream tasks all pending; running task cancelled.
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

    // Drive upstream merge into a retry-eligible state (failed)
    // so retryWorkflow has work to do, then trigger retry.
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

    // Drive the upstream merge gate into 'failed' so retryTask has
    // a clear semantic and downstream cascade is observable.
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

    // Recreate A through applyInvalidation (production path). Both
    // B and C must reset transitively via cascadeDownstream.
    await applyInvalidation('workflow', 'recreateWorkflow', aWfId, deps);

    for (const id of [bTaskId, bMergeId, cTaskId, cMergeId]) {
      expect(orchestrator.getTask(id)!.status, `${id} should be pending after transitive cascade`).toBe('pending');
    }
  });
});
