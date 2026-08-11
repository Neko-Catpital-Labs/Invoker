import { describe, it, expect } from 'vitest';
import { CommandService } from '../command-service.js';
import {
  InMemoryPersistence,
  makeOrchestrator,
  setupChain,
} from './helpers/cross-workflow-cascade-helpers.js';

describe('REPRO: recreate preemption detaches a live downstream dependency', () => {
  it('CommandService.preemptWorkflow must not detach downstream externalDependencies', async () => {
    const persistence = new InMemoryPersistence();
    const orchestrator = makeOrchestrator(persistence);
    const commandService = new CommandService(orchestrator);
    const ctx = setupChain(orchestrator);

    expect(persistence.loadWorkflow(ctx.downstreamWfId)!.externalDependencies).toEqual([
      {
        workflowId: ctx.upstreamWfId,
        taskId: '__merge__',
        requiredStatus: 'completed',
        gatePolicy: 'completed',
      },
    ]);
    expect(orchestrator.getTask(ctx.downstreamLastId)!.status).toBe('running');

    const preemptResult = await commandService.preemptWorkflow({
      commandId: 'cmd-preempt-upstream',
      source: 'headless',
      scope: 'workflow',
      idempotencyKey: 'idemp-preempt-1',
      payload: { workflowId: ctx.upstreamWfId },
    });
    expect(preemptResult.ok).toBe(true);

    expect(
      persistence.loadWorkflow(ctx.downstreamWfId)!.externalDependencies,
      'downstream must remain gated on the upstream while a recreate is in flight',
    ).toEqual([
      {
        workflowId: ctx.upstreamWfId,
        taskId: '__merge__',
        requiredStatus: 'completed',
        gatePolicy: 'completed',
      },
    ]);
  });

  it('CommandService.cancelWorkflow (the real standalone abandon action) must still detach downstream', async () => {
    const persistence = new InMemoryPersistence();
    const orchestrator = makeOrchestrator(persistence);
    const commandService = new CommandService(orchestrator);
    const ctx = setupChain(orchestrator);

    const cancelResult = await commandService.cancelWorkflow({
      commandId: 'cmd-cancel-upstream',
      source: 'ui',
      scope: 'workflow',
      idempotencyKey: 'idemp-cancel-1',
      payload: { workflowId: ctx.upstreamWfId },
    });
    expect(cancelResult.ok).toBe(true);

    expect(
      persistence.loadWorkflow(ctx.downstreamWfId)!.externalDependencies,
      'a genuinely abandoned upstream must still detach its downstream dependents',
    ).toBeUndefined();
  });
});
