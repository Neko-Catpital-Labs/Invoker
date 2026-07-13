import { describe, it, expect, beforeEach } from 'vitest';
import { Orchestrator } from '../orchestrator.js';
import {
  applyInvalidation,
  buildOrchestratorOnlyInvalidationDeps,
} from '../invalidation-policy.js';
import {
  InMemoryPersistence,
  makeOrchestrator,
  makeResponse,
  setupChain,
  type ChainContext,
} from './helpers/cross-workflow-cascade-helpers.js';

describe('cross-workflow cascade — applyInvalidation pipeline', () => {
  let persistence: InMemoryPersistence;
  let orchestrator: Orchestrator;

  beforeEach(() => {
    persistence = new InMemoryPersistence();
    orchestrator = makeOrchestrator(persistence);
  });

  function deps() {
    return buildOrchestratorOnlyInvalidationDeps(orchestrator);
  }

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

  it('applyInvalidation(recreateWorkflow, upstream) cascades to downstream', async () => {
    const ctx = setupChain(orchestrator);

    await applyInvalidation('workflow', 'recreateWorkflow', ctx.upstreamWfId, deps());

    expectDownstreamPending(ctx, 'recreateWorkflow');

    const lastEvents = persistence.events.filter((e) => e.taskId === ctx.downstreamLastId);
    const cancelIdx = lastEvents.findIndex((e) => e.eventType === 'task.cancelled');
    const pendingIdx = lastEvents.findIndex((e) => e.eventType === 'task.pending');
    expect(cancelIdx).toBeGreaterThanOrEqual(0);
    expect(pendingIdx).toBeGreaterThanOrEqual(0);
    expect(cancelIdx).toBeLessThan(pendingIdx);

    const upstreamMarkers = persistence.events.filter(
      (e) => e.eventType === 'task.invalidated_by_upstream',
    );
    expect(upstreamMarkers.length).toBeGreaterThan(0);
  });

  it('applyInvalidation(retryWorkflow, upstream) cascades to downstream', async () => {
    const ctx = setupChain(orchestrator);

    orchestrator.handleWorkerResponse(makeResponse({
      actionId: ctx.upstreamMergeId,
      status: 'failed',
      outputs: { exitCode: 1, error: 'boom' },
    }));

    await applyInvalidation('workflow', 'retryWorkflow', ctx.upstreamWfId, deps());

    expectDownstreamPending(ctx, 'retryWorkflow');
  });

  it('applyInvalidation(recreateTask, upstream task) cascades to downstream', async () => {
    const ctx = setupChain(orchestrator);

    await applyInvalidation('task', 'recreateTask', ctx.upstreamTaskId, deps());

    expectDownstreamPending(ctx, 'recreateTask');
  });

  it('applyInvalidation(retryTask, upstream merge gate) cascades to downstream', async () => {
    const ctx = setupChain(orchestrator);

    orchestrator.handleWorkerResponse(makeResponse({
      actionId: ctx.upstreamMergeId,
      status: 'failed',
      outputs: { exitCode: 1, error: 'boom' },
    }));

    await applyInvalidation('task', 'retryTask', ctx.upstreamMergeId, deps());

    expectDownstreamPending(ctx, 'retryTask');
  });

  it('applyInvalidation(recreateWorkflowFromFreshBase, upstream) cascades to downstream', async () => {
    const ctx = setupChain(orchestrator);

    await applyInvalidation(
      'workflow',
      'recreateWorkflowFromFreshBase',
      ctx.upstreamWfId,
      {
        ...deps(),
        recreateWorkflowFromFreshBase: (id) =>
          orchestrator.recreateWorkflowFromFreshBase(id, {
            refreshBase: async () => ({ commit: 'fresh-sha' }),
          }),
      },
    );

    expectDownstreamPending(ctx, 'recreateWorkflowFromFreshBase');
  });

  it('forkWorkflow(upstream) cascades to downstream (still primitive — fork keeps Phase-0 cascade)', () => {
    const ctx = setupChain(orchestrator);

    orchestrator.forkWorkflow(ctx.upstreamWfId, { autoStart: false });

    expectDownstreamPending(ctx, 'forkWorkflow');
  });

  it('cascade is transitive: A → B → C via applyInvalidation', async () => {
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

    await applyInvalidation('workflow', 'recreateWorkflow', aWfId, deps());

    for (const id of [bTaskId, bMergeId, cTaskId, cMergeId]) {
      expect(
        orchestrator.getTask(id)!.status,
        `${id} should be pending after transitive applyInvalidation cascade`,
      ).toBe('pending');
    }
  });
});
