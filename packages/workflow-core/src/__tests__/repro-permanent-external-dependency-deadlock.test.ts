import { describe, it, expect } from 'vitest';
import { Orchestrator } from '../orchestrator.js';
import {
  applyInvalidation,
  type InvalidationDeps,
} from '../invalidation-policy.js';
import {
  InMemoryPersistence,
  makeOrchestrator,
  makeResponse,
  setupChain,
} from './helpers/cross-workflow-cascade-helpers.js';

function buildOrchestratorDeps(orchestrator: Orchestrator): InvalidationDeps {
  return {
    cancelInFlight: async (scope, id) => {
      if (scope === 'none') return;
      try {
        if (scope === 'task') {
          orchestrator.cancelTask(id);
          return;
        }
        orchestrator.cancelWorkflow(id, { detachDependents: false });
      } catch (e) {
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
    cascadeDownstream: (scope, id) => {
      const workflowId = scope === 'workflow' ? id : orchestrator.getTask(id)?.config.workflowId;
      if (!workflowId) return [];
      return orchestrator.cascadeInvalidationToDownstream(workflowId);
    },
  };
}

// Incident 2026-08-06: 45 real Invoker workflows sat `pending` for 2+ days
// with free execution capacity because their upstream prerequisite
// (wf-1785491638881-15) was invalidated and never re-completed. start-ready
// ran repeatedly in that window and correctly dispatched unrelated work, but
// silently skipped all 45 forever via getExecutableReadyTasks's
// externalDependencies gate. The only thing that ever unblocked them was an
// unrelated manual `detachWorkflow` call two days later.
describe('REPRO: an invalidated-and-abandoned upstream permanently deadlocks its downstream', () => {
  it('detaches downstream from an invalidated upstream when that upstream is cancelled and abandoned', async () => {
    const persistence = new InMemoryPersistence();
    const orchestrator = makeOrchestrator(persistence);
    const deps = buildOrchestratorDeps(orchestrator);
    const ctx = setupChain(orchestrator);

    // Upstream is invalidated (mirrors recreateTask/retryTask/recreateWorkflow
    // in production — any of MUTATION_POLICIES' invalidating actions cascade
    // the same way). Downstream root correctly resets to pending.
    await applyInvalidation('workflow', 'recreateWorkflow', ctx.upstreamWfId, deps);
    expect(orchestrator.getTask(ctx.upstreamMergeId)!.status).toBe('pending');
    expect(orchestrator.getTask(ctx.downstreamRootId)!.status).toBe('pending');

    for (let i = 0; i < 5; i += 1) {
      const ready = orchestrator.getExecutableReadyTasks().map((t) => t.id);
      expect(ready, `poll ${i}: downstream root must still be blocked while upstream can rerun`)
        .not.toContain(ctx.downstreamRootId);
    }

    // The upstream workflow is now abandoned for good — exactly what
    // happened to wf-1785491638881-15 (superseded by other work, never
    // going to be retried to completion again).
    orchestrator.cancelWorkflow(ctx.upstreamWfId);

    expect(persistence.loadWorkflow(ctx.downstreamWfId)!.externalDependencies).toBeUndefined();
    expect(orchestrator.getExecutableReadyTasks().map((t) => t.id))
      .toContain(ctx.downstreamRootId);
  });

  it('keeps a genuinely-still-invalid upstream gate blocking its downstream', async () => {
    const persistence = new InMemoryPersistence();
    const orchestrator = makeOrchestrator(persistence);
    const deps = buildOrchestratorDeps(orchestrator);
    const ctx = setupChain(orchestrator);

    await applyInvalidation('workflow', 'recreateWorkflow', ctx.upstreamWfId, deps);
    expect(orchestrator.getTask(ctx.upstreamMergeId)!.status).toBe('pending');
    expect(orchestrator.getTask(ctx.downstreamRootId)!.status).toBe('pending');

    for (let i = 0; i < 5; i += 1) {
      const ready = orchestrator.getExecutableReadyTasks().map((t) => t.id);
      expect(ready, `poll ${i}: downstream root must still be blocked by invalid upstream`)
        .not.toContain(ctx.downstreamRootId);
    }
    expect(persistence.loadWorkflow(ctx.downstreamWfId)!.externalDependencies).toEqual([
      {
        workflowId: ctx.upstreamWfId,
        taskId: '__merge__',
        requiredStatus: 'completed',
        gatePolicy: 'completed',
      },
    ]);
  });
});
