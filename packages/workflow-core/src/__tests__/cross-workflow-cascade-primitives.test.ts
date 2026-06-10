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
            cascadeDownstream: false,
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

describe('cross-workflow cascade — direct orchestrator primitives', () => {
  let persistence: InMemoryPersistence;
  let orchestrator: Orchestrator;

  beforeEach(() => {
    persistence = new InMemoryPersistence();
    orchestrator = makeOrchestrator(persistence);
  });

  function downstreamIds(ctx: ChainContext): string[] {
    return [
      ctx.downstreamRootId,
      ctx.downstreamMidId,
      ctx.downstreamLastId,
      ctx.downstreamMergeId,
    ];
  }

  // The chain fixture progresses root/mid/last (completed/completed/running)
  // but never starts the downstream merge node, so the cascade's pristine
  // guard must reset only these three.
  function progressedDownstreamIds(ctx: ChainContext): string[] {
    return [ctx.downstreamRootId, ctx.downstreamMidId, ctx.downstreamLastId];
  }

  function upstreamMarkerCount(taskId: string): number {
    return persistence.events.filter(
      (e) => e.taskId === taskId && e.eventType === 'task.invalidated_by_upstream',
    ).length;
  }

  function generationOf(id: string): number {
    return orchestrator.getTask(id)!.execution.generation ?? 0;
  }

  it('direct orchestrator.recreateWorkflow(upstream) cascades to downstream (no routing)', () => {
    const ctx = setupChain(orchestrator);

    // No applyInvalidation, no explicit cascade call — the bare primitive.
    orchestrator.recreateWorkflow(ctx.upstreamWfId);

    for (const id of downstreamIds(ctx)) {
      expect(
        orchestrator.getTask(id)!.status,
        `${id} should be pending after a DIRECT recreateWorkflow`,
      ).toBe('pending');
    }
  });

  it('direct orchestrator.recreateWorkflowFromFreshBase(upstream) cascades to downstream', async () => {
    const ctx = setupChain(orchestrator);

    await orchestrator.recreateWorkflowFromFreshBase(ctx.upstreamWfId, {
      refreshBase: async () => ({ commit: 'fresh-sha' }),
    });

    for (const id of downstreamIds(ctx)) {
      expect(
        orchestrator.getTask(id)!.status,
        `${id} should be pending after a DIRECT recreateWorkflowFromFreshBase`,
      ).toBe('pending');
    }
  });

  it('direct recreateWorkflow cascades each progressed downstream task exactly once (no double-bump)', () => {
    const ctx = setupChain(orchestrator);
    const before = downstreamIds(ctx).map(generationOf);

    orchestrator.recreateWorkflow(ctx.upstreamWfId);

    progressedDownstreamIds(ctx).forEach((id, i) => {
      expect(upstreamMarkerCount(id), `${id} cascaded exactly once`).toBe(1);
      expect(
        generationOf(id),
        `${id} execution generation bumped exactly once`,
      ).toBe(before[i]! + 1);
    });

    const mergeId = ctx.downstreamMergeId;
    expect(upstreamMarkerCount(mergeId), `pristine ${mergeId} emits no cascade event`).toBe(0);
    expect(
      generationOf(mergeId),
      `pristine ${mergeId} keeps its execution generation`,
    ).toBe(before[3]!);
    expect(orchestrator.getTask(mergeId)!.status).toBe('pending');
  });

  it('routed applyInvalidation(recreateWorkflow) does NOT double-cascade downstream', async () => {
    const ctx = setupChain(orchestrator);
    const before = downstreamIds(ctx).map(generationOf);

    await applyInvalidation(
      'workflow',
      'recreateWorkflow',
      ctx.upstreamWfId,
      buildOrchestratorOnlyInvalidationDeps(orchestrator),
    );

    progressedDownstreamIds(ctx).forEach((id, i) => {
      expect(
        upstreamMarkerCount(id),
        `${id} cascaded exactly once via the routed pipeline (the stage owns it; the primitive opts out)`,
      ).toBe(1);
      expect(
        generationOf(id),
        `${id} execution generation bumped exactly once via routed pipeline`,
      ).toBe(before[i]! + 1);
    });

    const mergeId = ctx.downstreamMergeId;
    expect(upstreamMarkerCount(mergeId), `pristine ${mergeId} emits no cascade event`).toBe(0);
    expect(generationOf(mergeId)).toBe(before[3]!);
    expect(orchestrator.getTask(mergeId)!.status).toBe('pending');
  });

  it('routed applyInvalidation(recreateWorkflowFromFreshBase) does NOT double-cascade downstream', async () => {
    const ctx = setupChain(orchestrator);
    const before = downstreamIds(ctx).map(
      (id) => orchestrator.getTask(id)!.execution.generation ?? 0,
    );

    await applyInvalidation(
      'workflow',
      'recreateWorkflowFromFreshBase',
      ctx.upstreamWfId,
      {
        ...buildOrchestratorOnlyInvalidationDeps(orchestrator),
        recreateWorkflowFromFreshBase: (id) =>
          orchestrator.recreateWorkflowFromFreshBase(id, {
            refreshBase: async () => ({ commit: 'fresh-sha' }),
            cascadeDownstream: false,
          }),
      },
    );

    progressedDownstreamIds(ctx).forEach((id, i) => {
      expect(upstreamMarkerCount(id), `${id} cascaded exactly once`).toBe(1);
      expect(
        generationOf(id),
        `${id} execution generation bumped exactly once`,
      ).toBe(before[i]! + 1);
    });

    const mergeId = ctx.downstreamMergeId;
    expect(upstreamMarkerCount(mergeId), `pristine ${mergeId} emits no cascade event`).toBe(0);
    expect(generationOf(mergeId)).toBe(before[3]!);
    expect(orchestrator.getTask(mergeId)!.status).toBe('pending');
  });

  it('repeated cascadeInvalidationToDownstream over an unchanged downstream is a no-op', () => {
    const ctx = setupChain(orchestrator);

    const first = orchestrator.cascadeInvalidationToDownstream(ctx.upstreamWfId);
    expect(first.map((t) => t.id).sort()).toEqual(progressedDownstreamIds(ctx).sort());

    const eventCountAfterFirst = persistence.events.length;
    const generationsAfterFirst = downstreamIds(ctx).map(generationOf);

    const second = orchestrator.cascadeInvalidationToDownstream(ctx.upstreamWfId);

    expect(second, 'second cascade resets nothing').toEqual([]);
    expect(
      persistence.events.length,
      'second cascade emits no events of any kind',
    ).toBe(eventCountAfterFirst);
    downstreamIds(ctx).forEach((id, i) => {
      expect(
        generationOf(id),
        `${id} generation unchanged by the second cascade`,
      ).toBe(generationsAfterFirst[i]!);
      expect(orchestrator.getTask(id)!.status).toBe('pending');
    });
  });

  it('after a cascade, only a re-progressed downstream task is reset by the next cascade', () => {
    const ctx = setupChain(orchestrator);

    orchestrator.cascadeInvalidationToDownstream(ctx.upstreamWfId);

    // Re-progress only the downstream root: the upstream merge gate is
    // still completed, so root is the lone ready task.
    const started = orchestrator.startExecution();
    expect(started.map((t) => t.id)).toEqual([ctx.downstreamRootId]);

    orchestrator.handleWorkerResponse(makeResponse({
      actionId: ctx.downstreamRootId,
      status: 'completed',
      executionGeneration:
        orchestrator.getTask(ctx.downstreamRootId)!.execution.generation ?? 0,
    }));
    expect(orchestrator.getTask(ctx.downstreamRootId)!.status).toBe('completed');

    // Completing root auto-starts mid; defer it so the cascade sees a
    // single re-progressed task among otherwise-pristine siblings.
    expect(orchestrator.getTask(ctx.downstreamMidId)!.status).toBe('running');
    orchestrator.deferTask(ctx.downstreamMidId);
    expect(orchestrator.getTask(ctx.downstreamMidId)!.status).toBe('pending');

    const markerCountsBefore = downstreamIds(ctx).map(upstreamMarkerCount);
    const generationsBefore = downstreamIds(ctx).map(generationOf);

    const reset = orchestrator.cascadeInvalidationToDownstream(ctx.upstreamWfId);

    expect(
      reset.map((t) => t.id),
      'only the re-progressed root is reset',
    ).toEqual([ctx.downstreamRootId]);
    expect(upstreamMarkerCount(ctx.downstreamRootId)).toBe(markerCountsBefore[0]! + 1);
    expect(generationOf(ctx.downstreamRootId)).toBe(generationsBefore[0]! + 1);

    [ctx.downstreamMidId, ctx.downstreamLastId, ctx.downstreamMergeId].forEach((id, i) => {
      expect(
        upstreamMarkerCount(id),
        `pristine sibling ${id} gets no new cascade event`,
      ).toBe(markerCountsBefore[i + 1]!);
      expect(
        generationOf(id),
        `pristine sibling ${id} keeps its generation`,
      ).toBe(generationsBefore[i + 1]!);
      expect(orchestrator.getTask(id)!.status).toBe('pending');
    });
  });
});
