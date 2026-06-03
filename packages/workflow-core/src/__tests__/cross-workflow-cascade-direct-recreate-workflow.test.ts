import { describe, it, expect, beforeEach } from 'vitest';
import { Orchestrator } from '../orchestrator.js';
import {
  applyInvalidation,
  buildOrchestratorOnlyInvalidationDeps,
} from '../invalidation-policy.js';
import {
  InMemoryPersistence,
  makeOrchestrator,
  setupChain,
  type ChainContext,
} from './helpers/cross-workflow-cascade-helpers.js';

/**
 * Direct-primitive cross-workflow cascade for workflow-scope recreate.
 *
 * The router (`applyInvalidation` via `CommandService.recreateWorkflow`)
 * has always cascaded across workflows via its `cascadeAcrossWorkflows`
 * stage. Direct callers — `orchestrator.recreateWorkflow(workflowId)`
 * and `orchestrator.recreateWorkflowFromFreshBase(workflowId)` — used
 * to miss the cascade, leaving downstream workflows running against
 * stale upstream output. The fix is a default-on cascade inside the
 * primitive itself with an explicit `{ cascadeDownstream: false }`
 * opt-out for routed callers so the pipeline still owns the cascade.
 */
describe('direct Orchestrator.recreateWorkflow cascades to downstream workflows', () => {
  let persistence: InMemoryPersistence;
  let orchestrator: Orchestrator;
  let ctx: ChainContext;

  beforeEach(() => {
    persistence = new InMemoryPersistence();
    orchestrator = makeOrchestrator(persistence);
    ctx = setupChain(orchestrator);
  });

  function downstreamStatuses() {
    return {
      root: orchestrator.getTask(ctx.downstreamRootId)!.status,
      mid: orchestrator.getTask(ctx.downstreamMidId)!.status,
      last: orchestrator.getTask(ctx.downstreamLastId)!.status,
      merge: orchestrator.getTask(ctx.downstreamMergeId)!.status,
    };
  }

  function downstreamGenerations() {
    return {
      root: orchestrator.getTask(ctx.downstreamRootId)!.execution.generation ?? 0,
      mid: orchestrator.getTask(ctx.downstreamMidId)!.execution.generation ?? 0,
      last: orchestrator.getTask(ctx.downstreamLastId)!.execution.generation ?? 0,
      merge: orchestrator.getTask(ctx.downstreamMergeId)!.execution.generation ?? 0,
    };
  }

  it('direct recreateWorkflow(upstream) resets every downstream task to pending', () => {
    expect(orchestrator.getTask(ctx.downstreamLastId)!.status).toBe('running');

    orchestrator.recreateWorkflow(ctx.upstreamWfId);

    expect(downstreamStatuses()).toEqual({
      root: 'pending',
      mid: 'pending',
      last: 'pending',
      merge: 'pending',
    });

    const upstreamMarkers = persistence.events.filter(
      (e) => e.eventType === 'task.invalidated_by_upstream',
    );
    expect(upstreamMarkers.length).toBeGreaterThan(0);
  });

  it('direct recreateWorkflowFromFreshBase(upstream) resets every downstream task to pending', async () => {
    expect(orchestrator.getTask(ctx.downstreamLastId)!.status).toBe('running');

    await orchestrator.recreateWorkflowFromFreshBase(ctx.upstreamWfId, {
      refreshBase: async () => ({ commit: 'fresh-sha' }),
    });

    expect(downstreamStatuses()).toEqual({
      root: 'pending',
      mid: 'pending',
      last: 'pending',
      merge: 'pending',
    });
  });

  it('direct cascade is transitive (A → B → C)', () => {
    // The setupChain helper already wires upstream → downstream. Add a
    // third workflow that depends on the downstream merge gate and
    // verify direct recreate on A pends every task in B and C.
    orchestrator.loadPlan({
      name: 'wf-c',
      baseBranch: 'feature/downstream',
      featureBranch: 'feature/c',
      tasks: [
        {
          id: 'c-task',
          description: 'C depends on downstream merge gate',
          externalDependencies: [{ workflowId: ctx.downstreamWfId, gatePolicy: 'completed' }],
        },
      ],
    });
    const cTaskId = orchestrator.getAllTasks().find((t) => t.id.endsWith('/c-task'))!.id;
    const cWfId = cTaskId.split('/')[0]!;
    const cMergeId = `__merge__${cWfId}`;

    orchestrator.recreateWorkflow(ctx.upstreamWfId);

    for (const id of [
      ctx.downstreamRootId,
      ctx.downstreamMidId,
      ctx.downstreamLastId,
      ctx.downstreamMergeId,
      cTaskId,
      cMergeId,
    ]) {
      expect(
        orchestrator.getTask(id)!.status,
        `${id} should be pending after transitive direct cascade`,
      ).toBe('pending');
    }
  });

  it('routed applyInvalidation(recreateWorkflow) bumps each downstream execution generation exactly once', async () => {
    const before = downstreamGenerations();

    await applyInvalidation(
      'workflow',
      'recreateWorkflow',
      ctx.upstreamWfId,
      buildOrchestratorOnlyInvalidationDeps(orchestrator),
    );

    expect(downstreamStatuses()).toEqual({
      root: 'pending',
      mid: 'pending',
      last: 'pending',
      merge: 'pending',
    });

    const after = downstreamGenerations();
    expect(after.root - before.root, 'root execution generation delta').toBe(1);
    expect(after.mid - before.mid, 'mid execution generation delta').toBe(1);
    expect(after.last - before.last, 'last execution generation delta').toBe(1);
    expect(after.merge - before.merge, 'merge execution generation delta').toBe(1);
  });

  it('routed applyInvalidation(recreateWorkflowFromFreshBase) bumps each downstream execution generation exactly once', async () => {
    const before = downstreamGenerations();
    const baseDeps = buildOrchestratorOnlyInvalidationDeps(orchestrator);

    await applyInvalidation(
      'workflow',
      'recreateWorkflowFromFreshBase',
      ctx.upstreamWfId,
      {
        ...baseDeps,
        recreateWorkflowFromFreshBase: (id) =>
          orchestrator.recreateWorkflowFromFreshBase(id, {
            refreshBase: async () => ({ commit: 'fresh-sha' }),
            cascadeDownstream: false,
          }),
      },
    );

    const after = downstreamGenerations();
    expect(after.root - before.root).toBe(1);
    expect(after.mid - before.mid).toBe(1);
    expect(after.last - before.last).toBe(1);
    expect(after.merge - before.merge).toBe(1);
  });

  it('direct recreateWorkflow bumps each downstream execution generation exactly once', () => {
    const before = downstreamGenerations();

    orchestrator.recreateWorkflow(ctx.upstreamWfId);

    const after = downstreamGenerations();
    expect(after.root - before.root).toBe(1);
    expect(after.mid - before.mid).toBe(1);
    expect(after.last - before.last).toBe(1);
    expect(after.merge - before.merge).toBe(1);
  });
});
