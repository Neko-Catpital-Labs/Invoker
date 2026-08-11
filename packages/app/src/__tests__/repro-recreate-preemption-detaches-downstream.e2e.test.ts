/**
 * Live incident 2026-08-11: recreating "General alert channel (2)" via the
 * GUI's "Recreate Workflow" button (which funnels into the same headless
 * "recreate" command path exercised here) left downstream workflow (3),
 * gated on (2) via externalDependencies, running instead of blocked.
 *
 * packages/workflow-core/src/__tests__/repro-recreate-preemption-detaches-downstream.test.ts
 * reproduces this at the narrow CommandService.cancelWorkflow level. This
 * test exercises the full real production sequence one layer up:
 * preemptWorkflowBeforeMutation -> preemptWorkflowExecution ->
 * CommandService.cancelWorkflow, immediately followed by the real
 * CommandService.recreateWorkflow -- the exact order
 * headlessRecreateWorkflow (packages/app/src/headless-run-resume.ts) runs
 * for every recreate/retry/rebase-recreate/rebase-retry command.
 */
import { describe, it, expect } from 'vitest';
import { makeEnvelope } from '@invoker/contracts';
import { Orchestrator, CommandService } from '@invoker/workflow-core';
import { InMemoryBus, InMemoryPersistence } from '@invoker/test-kit';
import { preemptWorkflowExecution } from '../headless-shared.js';
import { preemptWorkflowBeforeMutation } from '../workflow-preemption.js';
import type { HeadlessDeps } from '../headless.js';

function buildGatedDownstreamChain(orchestrator: Orchestrator) {
  orchestrator.loadPlan({
    name: 'upstream',
    repoUrl: 'memory://test-repo',
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
    name: 'downstream',
    repoUrl: 'memory://test-repo',
    baseBranch: 'feature/upstream',
    featureBranch: 'feature/downstream',
    tasks: [
      {
        id: 'root',
        description: 'downstream root waits for upstream merge gate',
        externalDependencies: [{ workflowId: upstreamWfId, gatePolicy: 'completed' }],
      },
      { id: 'mid', description: 'downstream mid depends on root', dependencies: ['root'] },
    ],
  });
  const downstreamRootId = orchestrator.getAllTasks().find((t) => t.id.endsWith('/root'))!.id;
  const downstreamWfId = downstreamRootId.split('/')[0]!;
  const downstreamMidId = `${downstreamWfId}/mid`;

  orchestrator.startExecution();
  orchestrator.handleWorkerResponse({
    requestId: 'req-upstream-task', actionId: upstreamTaskId, executionGeneration: 0,
    status: 'completed', outputs: { exitCode: 0 },
  });
  orchestrator.handleWorkerResponse({
    requestId: 'req-upstream-merge', actionId: upstreamMergeId, executionGeneration: 0,
    status: 'completed', outputs: { exitCode: 0 },
  });
  expect(orchestrator.getTask(downstreamRootId)!.status).toBe('running');
  orchestrator.handleWorkerResponse({
    requestId: 'req-downstream-root', actionId: downstreamRootId, executionGeneration: 0,
    status: 'completed', outputs: { exitCode: 0 },
  });
  expect(orchestrator.getTask(downstreamMidId)!.status).toBe('running');

  return { upstreamWfId, downstreamWfId, downstreamRootId, downstreamMidId };
}

describe('E2E: recreate command must not detach a live downstream dependency', () => {
  it('preempt-then-recreate on the upstream keeps the downstream gate intact and blocked', async () => {
    const persistence = new InMemoryPersistence();
    const orchestrator = new Orchestrator({
      persistence,
      messageBus: new InMemoryBus(),
      maxConcurrency: 8,
      resolveRepoDefaultBranch: () => 'master',
    } as never);
    const commandService = new CommandService(orchestrator);
    const deps = { commandService } as unknown as HeadlessDeps;

    const ctx = buildGatedDownstreamChain(orchestrator);

    expect(persistence.loadWorkflow(ctx.downstreamWfId)!.externalDependencies).toEqual([
      { workflowId: ctx.upstreamWfId, taskId: '__merge__', requiredStatus: 'completed', gatePolicy: 'completed' },
    ]);

    // Exactly what headlessRecreateWorkflow does, in the same order, for
    // every recreate/retry/rebase-recreate/rebase-retry command:
    await preemptWorkflowBeforeMutation(ctx.upstreamWfId, {
      preemptWorkflowExecution: (id) => preemptWorkflowExecution(id, deps),
      context: 'headless.recreate-workflow',
    });
    const recreateResult = await commandService.recreateWorkflow(
      makeEnvelope('recreate-workflow', 'headless', 'workflow', { workflowId: ctx.upstreamWfId }),
    );
    expect(recreateResult.ok).toBe(true);

    expect(
      persistence.loadWorkflow(ctx.downstreamWfId)!.externalDependencies,
      'downstream must remain gated on the upstream after a recreate command',
    ).toEqual([
      { workflowId: ctx.upstreamWfId, taskId: '__merge__', requiredStatus: 'completed', gatePolicy: 'completed' },
    ]);
    expect(
      orchestrator.getExecutableReadyTasks().map((t) => t.id),
      'downstream root must not become executable while its upstream gate is unsatisfied',
    ).not.toContain(ctx.downstreamRootId);
    expect(orchestrator.getTask(ctx.downstreamMidId)!.status).toBe('pending');
  });
});
