import { describe, it, expect, beforeEach } from 'vitest';
import { CommandService } from '../command-service.js';
import { Orchestrator } from '../orchestrator.js';
import type {
  InvalidationDeps,
  InvalidationScope,
} from '../invalidation-policy.js';
import {
  InMemoryPersistence,
  makeOrchestrator,
  setupChain,
  type ChainContext,
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
        orchestrator.cancelWorkflow(id);
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

describe('cross-workflow cascade — CommandService end-to-end', () => {
  let persistence: InMemoryPersistence;
  let orchestrator: Orchestrator;
  let commandService: CommandService;
  let ctx: ChainContext;

  beforeEach(() => {
    persistence = new InMemoryPersistence();
    orchestrator = makeOrchestrator(persistence);
    commandService = new CommandService(orchestrator, buildOrchestratorDeps(orchestrator));
    ctx = setupChain(orchestrator);
  });

  function expectDownstreamPending(label: string): void {
    for (const id of [
      ctx.downstreamRootId,
      ctx.downstreamMidId,
      ctx.downstreamLastId,
      ctx.downstreamMergeId,
    ]) {
      expect(
        orchestrator.getTask(id)!.status,
        `${id} should be pending after upstream ${label} via CommandService`,
      ).toBe('pending');
    }
  }

  it('CommandService.recreateWorkflow on upstream cancels in-flight downstream and resets every downstream task', async () => {
    expect(orchestrator.getTask(ctx.downstreamLastId)!.status).toBe('running');

    const result = await commandService.recreateWorkflow({
      commandId: 'cmd-recreate-upstream',
      source: 'headless',
      scope: 'workflow',
      idempotencyKey: 'idemp-1',
      payload: { workflowId: ctx.upstreamWfId },
    });

    expect(result.ok).toBe(true);

    expectDownstreamPending('recreateWorkflow');

    const lastEvents = persistence.events.filter((e) => e.taskId === ctx.downstreamLastId);
    const cancelIdx = lastEvents.findIndex((e) => e.eventType === 'task.cancelled');
    const pendingIdx = lastEvents.findIndex((e) => e.eventType === 'task.pending');
    expect(cancelIdx, 'expected task.cancelled event for in-flight downstream task').toBeGreaterThanOrEqual(0);
    expect(pendingIdx, 'expected task.pending event for in-flight downstream task').toBeGreaterThanOrEqual(0);
    expect(cancelIdx, 'cancel must precede pending for the in-flight downstream task').toBeLessThan(pendingIdx);

    const upstreamMarkers = persistence.events.filter(
      (e) => e.eventType === 'task.invalidated_by_upstream',
    );
    expect(upstreamMarkers.length).toBeGreaterThan(0);
  });

  it('CommandService.retryWorkflow on upstream cascades downstream identically', async () => {
    expect(orchestrator.getTask(ctx.downstreamLastId)!.status).toBe('running');

    const result = await commandService.retryWorkflow({
      commandId: 'cmd-retry-upstream',
      source: 'headless',
      scope: 'workflow',
      idempotencyKey: 'idemp-2',
      payload: { workflowId: ctx.upstreamWfId },
    });

    expect(result.ok).toBe(true);
    expectDownstreamPending('retryWorkflow');
  });
});
