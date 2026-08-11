import { describe, it, expect } from 'vitest';
import { Orchestrator } from '../orchestrator.js';
import {
  InMemoryPersistence,
  makeOrchestrator,
  setupChain,
} from './helpers/cross-workflow-cascade-helpers.js';

function loadLoneWorkflow(
  orchestrator: Orchestrator,
  name: string,
  repoUrl: string,
): string {
  const before = new Set(orchestrator.getAllTasks().map((t) => t.config.workflowId));
  orchestrator.loadPlan({
    name,
    repoUrl,
    baseBranch: 'master',
    featureBranch: `feature/${name}`,
    tasks: [{ id: 't', description: 't' }],
  });
  return orchestrator.getAllTasks().find(
    (t) => !t.config.isMergeNode && !before.has(t.config.workflowId),
  )!.config.workflowId!;
}

describe('Orchestrator.attachWorkflow', () => {
  it('re-attaches a previously-detached pair and clears the Detached provenance', () => {
    const persistence = new InMemoryPersistence();
    const orchestrator = makeOrchestrator(persistence);
    const ctx = setupChain(orchestrator);

    orchestrator.detachWorkflow(ctx.downstreamWfId, ctx.upstreamWfId);
    expect(persistence.loadWorkflow(ctx.downstreamWfId)!.externalDependencies).toBeUndefined();
    expect(persistence.loadWorkflow(ctx.downstreamWfId)!.detachedExternalDependencies).toEqual([
      expect.objectContaining({ workflowId: ctx.upstreamWfId }),
    ]);

    orchestrator.attachWorkflow(ctx.downstreamWfId, ctx.upstreamWfId);

    expect(persistence.loadWorkflow(ctx.downstreamWfId)!.externalDependencies).toEqual([
      { workflowId: ctx.upstreamWfId, taskId: '__merge__', requiredStatus: 'completed', gatePolicy: 'completed' },
    ]);
    expect(
      persistence.loadWorkflow(ctx.downstreamWfId)!.detachedExternalDependencies,
      'Detached provenance for this upstream must be cleared once re-attached',
    ).toBeUndefined();
  });

  it('attaches two workflows that were never previously linked', () => {
    const persistence = new InMemoryPersistence();
    const orchestrator = makeOrchestrator(persistence);
    const aId = loadLoneWorkflow(orchestrator, 'lone-a', 'memory://test-repo');
    const bId = loadLoneWorkflow(orchestrator, 'lone-b', 'memory://test-repo');

    expect(persistence.loadWorkflow(bId)!.externalDependencies).toBeUndefined();
    orchestrator.attachWorkflow(bId, aId);
    expect(persistence.loadWorkflow(bId)!.externalDependencies).toEqual([
      { workflowId: aId, taskId: '__merge__', requiredStatus: 'completed', gatePolicy: 'completed' },
    ]);
  });

  it('rejects self-attach', () => {
    const persistence = new InMemoryPersistence();
    const orchestrator = makeOrchestrator(persistence);
    const ctx = setupChain(orchestrator);
    expect(() => orchestrator.attachWorkflow(ctx.upstreamWfId, ctx.upstreamWfId)).toThrow(/itself/);
  });

  it('rejects a cycle (attaching the upstream back onto its own downstream)', () => {
    const persistence = new InMemoryPersistence();
    const orchestrator = makeOrchestrator(persistence);
    const ctx = setupChain(orchestrator);
    expect(() => orchestrator.attachWorkflow(ctx.upstreamWfId, ctx.downstreamWfId)).toThrow(/cycle/);
  });

  it('rejects cross-repo attach unless forced', () => {
    const persistence = new InMemoryPersistence();
    const orchestrator = makeOrchestrator(persistence);
    const aId = loadLoneWorkflow(orchestrator, 'repo-a', 'memory://repo-a');
    const bId = loadLoneWorkflow(orchestrator, 'repo-b', 'memory://repo-b');

    expect(() => orchestrator.attachWorkflow(bId, aId)).toThrow(/different repos/);
    expect(() => orchestrator.attachWorkflow(bId, aId, { force: true })).not.toThrow();
  });

  it('rejects attaching a new dependency onto an already-completed downstream unless forced', () => {
    const persistence = new InMemoryPersistence();
    const orchestrator = makeOrchestrator(persistence);
    const aId = loadLoneWorkflow(orchestrator, 'lone-a2', 'memory://test-repo');
    const bId = loadLoneWorkflow(orchestrator, 'lone-b2', 'memory://test-repo');
    const bTaskId = orchestrator.getAllTasks().find(
      (t) => t.config.workflowId === bId && !t.config.isMergeNode,
    )!.id;
    const bMergeId = `__merge__${bId}`;

    orchestrator.startExecution();
    orchestrator.handleWorkerResponse({
      requestId: 'r1', actionId: bTaskId, executionGeneration: 0,
      status: 'completed', outputs: { exitCode: 0 },
    });
    orchestrator.handleWorkerResponse({
      requestId: 'r2', actionId: bMergeId, executionGeneration: 0,
      status: 'completed', outputs: { exitCode: 0 },
    });

    expect(() => orchestrator.attachWorkflow(bId, aId)).toThrow(/already completed/);
    expect(() => orchestrator.attachWorkflow(bId, aId, { force: true })).not.toThrow();
  });

  it('is forward-only: does not touch a downstream task that already ran ahead', () => {
    const persistence = new InMemoryPersistence();
    const orchestrator = makeOrchestrator(persistence);
    const aId = loadLoneWorkflow(orchestrator, 'lone-a3', 'memory://test-repo');
    const bId = loadLoneWorkflow(orchestrator, 'lone-b3', 'memory://test-repo');
    const bTaskId = orchestrator.getAllTasks().find(
      (t) => t.config.workflowId === bId && !t.config.isMergeNode,
    )!.id;

    orchestrator.startExecution();
    orchestrator.handleWorkerResponse({
      requestId: 'r1', actionId: bTaskId, executionGeneration: 0,
      status: 'completed', outputs: { exitCode: 0 },
    });
    expect(orchestrator.getTask(bTaskId)!.status).toBe('completed');

    orchestrator.attachWorkflow(bId, aId, { force: true });

    expect(
      orchestrator.getTask(bTaskId)!.status,
      'attach must not reset a task that already ran ahead',
    ).toBe('completed');
  });
});
