import { describe, it, expect, beforeEach } from 'vitest';
import { Orchestrator } from '../orchestrator.js';
import {
  InMemoryPersistence,
  makeOrchestrator,
  makeResponse,
  setupChain,
} from './helpers/cross-workflow-cascade-helpers.js';

describe('repro: deleting a satisfied upstream workflow wipes downstream task state', () => {
  let persistence: InMemoryPersistence;
  let orchestrator: Orchestrator;

  beforeEach(() => {
    persistence = new InMemoryPersistence();
    orchestrator = makeOrchestrator(persistence);
  });

  it('deleteWorkflow on a completed upstream must not reset downstream tasks', () => {
    const ctx = setupChain(orchestrator);

    // Upstream merge gate completed (PR merged) — this is the state the
    // workflow-cleanup worker deletes every five minutes.
    expect(orchestrator.getTask(ctx.upstreamMergeId)!.status).toBe('completed');
    // Downstream is mid-flight: root/mid completed, last running.
    expect(orchestrator.getTask(ctx.downstreamRootId)!.status).toBe('completed');
    expect(orchestrator.getTask(ctx.downstreamMidId)!.status).toBe('completed');
    expect(orchestrator.getTask(ctx.downstreamLastId)!.status).toBe('running');

    orchestrator.deleteWorkflow(ctx.upstreamWfId);

    // The dependency edge should be detached (retarget to default base)...
    const downstream = persistence.loadWorkflow(ctx.downstreamWfId);
    expect(downstream!.externalDependencies ?? []).toHaveLength(0);

    // ...but downstream task state must be untouched: the removed dependency
    // was already satisfied, so nothing downstream is actually stale.
    expect(
      orchestrator.getTask(ctx.downstreamRootId)!.status,
      'completed downstream task was reset to pending by upstream delete',
    ).toBe('completed');
    expect(
      orchestrator.getTask(ctx.downstreamMidId)!.status,
      'completed downstream task was reset to pending by upstream delete',
    ).toBe('completed');
    expect(
      orchestrator.getTask(ctx.downstreamLastId)!.status,
      'running downstream task was reset to pending by upstream delete',
    ).toBe('running');
  });

  it('deleteWorkflow on an unsatisfied upstream still invalidates downstream', () => {
    // Same chain, but the upstream merge gate never completes — the dependent
    // is still gated, so deleting the upstream must keep today's semantics:
    // detach + force-reset the subgraph.
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
      ],
    });
    const downstreamRootId = orchestrator.getAllTasks().find(
      (t) => t.id.endsWith('/root'),
    )!.id;
    const downstreamWfId = downstreamRootId.split('/')[0]!;

    // Upstream task ran but its merge gate is still pending — dep unsatisfied.
    orchestrator.startExecution();
    orchestrator.handleWorkerResponse(makeResponse({ actionId: upstreamTaskId, status: 'completed' }));
    expect(orchestrator.getTask(downstreamRootId)!.status).toBe('pending');

    orchestrator.deleteWorkflow(upstreamWfId);

    const downstream = persistence.loadWorkflow(downstreamWfId);
    expect(downstream!.externalDependencies ?? []).toHaveLength(0);
    expect(
      persistence.events.some((e) => e.eventType === 'task.workflow_detached'),
      'unsatisfied-dep delete must still fire downstream invalidation',
    ).toBe(true);
  });
});
