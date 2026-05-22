import { describe, it, expect, beforeEach } from 'vitest';
import { Orchestrator } from '../orchestrator.js';
import {
  InMemoryPersistence,
  makeOrchestrator,
  makeResponse,
  setupChain,
  type ChainContext,
} from './helpers/cross-workflow-cascade-helpers.js';

/**
 * Phase 0 of the invalidation pipeline cleanup
 * (`docs/invalidation-pipeline-cleanup-plan.md`): production callers
 * (`CommandService.executeCommand`, `packages/app/src/workflow-actions.ts`
 * action wrappers) reach the orchestrator's invalidating primitives
 * directly, bypassing `applyInvalidation`'s `cascadeDownstream` hook.
 *
 * This suite proves the cross-workflow cascade fires when the
 * primitives are invoked directly — i.e. matches what production
 * actually does today, not just what the (test-only)
 * `applyInvalidation` path does.
 *
 * Phase 2 of the cleanup will route production through
 * `applyInvalidation` (the long-deferred Step 17). When that lands
 * the in-primitive cascade calls become idempotent no-ops; this
 * suite still passes because the cascade contract is unchanged.
 */
describe('cross-workflow cascade — primitives invoked directly (no applyInvalidation)', () => {
  let persistence: InMemoryPersistence;
  let orchestrator: Orchestrator;

  beforeEach(() => {
    persistence = new InMemoryPersistence();
    orchestrator = makeOrchestrator(persistence);
  });

  function expectDownstreamPending(ctx: ChainContext, label: string): void {
    for (const id of [
      ctx.downstreamRootId,
      ctx.downstreamMidId,
      ctx.downstreamLastId,
      ctx.downstreamMergeId,
    ]) {
      expect(
        orchestrator.getTask(id)!.status,
        `${id} should be pending after upstream ${label}`,
      ).toBe('pending');
    }
  }

  it('orchestrator.recreateWorkflow(upstream) cascades to downstream', () => {
    const ctx = setupChain(orchestrator);

    orchestrator.recreateWorkflow(ctx.upstreamWfId);

    expectDownstreamPending(ctx, 'recreateWorkflow');

    // Cancel-before-reset event ordering must be preserved on the
    // formerly-running downstream task.
    const lastEvents = persistence.events.filter((e) => e.taskId === ctx.downstreamLastId);
    const cancelIdx = lastEvents.findIndex((e) => e.eventType === 'task.cancelled');
    const pendingIdx = lastEvents.findIndex((e) => e.eventType === 'task.pending');
    expect(cancelIdx).toBeGreaterThanOrEqual(0);
    expect(pendingIdx).toBeGreaterThanOrEqual(0);
    expect(cancelIdx).toBeLessThan(pendingIdx);

    // The cascade itself must log `task.invalidated_by_upstream` for
    // every downstream task it touches.
    const upstreamMarkers = persistence.events.filter(
      (e) => e.eventType === 'task.invalidated_by_upstream',
    );
    expect(upstreamMarkers.length).toBeGreaterThan(0);
  });

  it('orchestrator.retryWorkflow(upstream) cascades to downstream', () => {
    const ctx = setupChain(orchestrator);

    // Drive upstream merge to `failed` so retryWorkflow has eligible
    // tasks to reset.
    orchestrator.handleWorkerResponse(makeResponse({
      actionId: ctx.upstreamMergeId,
      status: 'failed',
      outputs: { exitCode: 1, error: 'boom' },
    }));

    orchestrator.retryWorkflow(ctx.upstreamWfId);

    expectDownstreamPending(ctx, 'retryWorkflow');
  });

  it('orchestrator.recreateTask(upstream task) cascades to downstream', () => {
    const ctx = setupChain(orchestrator);

    orchestrator.recreateTask(ctx.upstreamTaskId);

    expectDownstreamPending(ctx, 'recreateTask');
  });

  it('orchestrator.retryTask(upstream merge gate) cascades to downstream', () => {
    const ctx = setupChain(orchestrator);

    // Drive upstream merge to `failed` so retryTask on it has a
    // clear semantic.
    orchestrator.handleWorkerResponse(makeResponse({
      actionId: ctx.upstreamMergeId,
      status: 'failed',
      outputs: { exitCode: 1, error: 'boom' },
    }));

    orchestrator.retryTask(ctx.upstreamMergeId);

    expectDownstreamPending(ctx, 'retryTask');
  });

  it('orchestrator.recreateWorkflowFromFreshBase(upstream) cascades to downstream', async () => {
    const ctx = setupChain(orchestrator);

    await orchestrator.recreateWorkflowFromFreshBase(ctx.upstreamWfId, {
      refreshBase: async () => ({ commit: 'fresh-sha' }),
    });

    expectDownstreamPending(ctx, 'recreateWorkflowFromFreshBase');
  });

  it('orchestrator.forkWorkflow(upstream) cascades to downstream', () => {
    const ctx = setupChain(orchestrator);

    orchestrator.forkWorkflow(ctx.upstreamWfId, { autoStart: false });

    // Forking the upstream invalidates downstream consumers of the
    // source workflow's externalDependencies.
    expectDownstreamPending(ctx, 'forkWorkflow');
  });

  it('cascade is transitive when invoked directly: A → B → C, primitives only', () => {
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

    orchestrator.startExecution();
    orchestrator.handleWorkerResponse(makeResponse({ actionId: aTaskId, status: 'completed' }));
    orchestrator.handleWorkerResponse(makeResponse({ actionId: aMergeId, status: 'completed' }));
    orchestrator.handleWorkerResponse(makeResponse({ actionId: bTaskId, status: 'completed' }));
    orchestrator.handleWorkerResponse(makeResponse({ actionId: bMergeId, status: 'completed' }));

    expect(orchestrator.getTask(cTaskId)!.status).toBe('running');

    // Recreate A by primitive only — no applyInvalidation.
    orchestrator.recreateWorkflow(aWfId);

    for (const id of [bTaskId, bMergeId, cTaskId, cMergeId]) {
      expect(
        orchestrator.getTask(id)!.status,
        `${id} should be pending after transitive primitive-only cascade`,
      ).toBe('pending');
    }
  });
});
