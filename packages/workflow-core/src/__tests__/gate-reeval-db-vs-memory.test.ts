import { describe, it, expect } from 'vitest';
import { Orchestrator } from '../orchestrator.js';
import {
  InMemoryPersistence,
  InMemoryBus,
  makeResponse,
} from './helpers/cross-workflow-cascade-helpers.js';

/**
 * A persistence double that surfaces `externalDependencies` from
 * `loadWorkflow`, matching what the real SQLite adapter returns. The shared
 * `InMemoryPersistence.loadWorkflow` drops the field, which would hide the gate
 * bug this repro targets.
 */
class GatePersistence extends InMemoryPersistence {
  loadWorkflow(workflowId: string): {
    repoUrl?: string;
    baseBranch?: string;
    featureBranch?: string;
    externalDependencies?: unknown;
  } | undefined {
    const wf = this.workflows.get(workflowId) as
      | { repoUrl?: string; baseBranch?: string; featureBranch?: string; externalDependencies?: unknown }
      | undefined;
    if (!wf) return undefined;
    return {
      repoUrl: wf.repoUrl,
      baseBranch: wf.baseBranch,
      featureBranch: wf.featureBranch,
      externalDependencies: wf.externalDependencies,
    };
  }
}

function makeOrchestratorWith(persistence: InMemoryPersistence): Orchestrator {
  return new Orchestrator({
    persistence,
    messageBus: new InMemoryBus(),
    maxConcurrency: 8,
  });
}

/**
 * Repro for bug #2: a downstream workflow gated on an upstream merge stays
 * blocked after the upstream merge has completed, when the upstream is not
 * currently hydrated into the in-memory graph.
 *
 * Production shape: an owner process re-hydrates workflows into memory
 * incrementally. A long-completed upstream can be absent from the in-memory
 * graph while its downstream is present and pending. The external-dependency
 * gate resolves the upstream merge node from the in-memory graph only
 * (`getMergeNode`), so the absent upstream reads as a missing prerequisite even
 * though the database says it merged — and the downstream never launches.
 */
describe('external-dependency gate re-evaluation (DB vs memory)', () => {
  it('starts the downstream when the completed upstream is NOT hydrated in memory', () => {
    const persistence = new GatePersistence();
    const orchestrator = makeOrchestratorWith(persistence);

    orchestrator.loadPlan({
      name: 'upstream-workflow',
      baseBranch: 'master',
      featureBranch: 'feature/upstream',
      tasks: [{ id: 'verify-upstream', description: 'upstream prerequisite' }],
    });
    const upstreamTaskId = orchestrator
      .getAllTasks()
      .find((t) => !t.config.isMergeNode && t.id.endsWith('/verify-upstream'))!.id;
    const upstreamWfId = upstreamTaskId.split('/')[0]!;
    const upstreamMergeId = `__merge__${upstreamWfId}`;

    // Drive the upstream to a completed merge before the downstream is even
    // submitted.
    orchestrator.startExecution();
    orchestrator.handleWorkerResponse(makeResponse({ actionId: upstreamTaskId, status: 'completed' }));
    orchestrator.handleWorkerResponse(makeResponse({ actionId: upstreamMergeId, status: 'completed' }));
    expect(persistence.loadTasks(upstreamWfId).find((t) => t.config.isMergeNode)!.status).toBe(
      'completed',
    );

    orchestrator.loadPlan({
      name: 'downstream-workflow',
      baseBranch: 'feature/upstream',
      featureBranch: 'feature/downstream',
      tasks: [
        {
          id: 'root',
          description: 'downstream root waits for the upstream merge gate',
          externalDependencies: [{ workflowId: upstreamWfId, gatePolicy: 'completed' }],
        },
      ],
    });
    const downstreamRootId = orchestrator.getAllTasks().find((t) => t.id.endsWith('/root'))!.id;
    const downstreamWfId = downstreamRootId.split('/')[0]!;
    expect(orchestrator.getTask(downstreamRootId)!.status).toBe('pending');

    // Simulate an owner that lost in-memory state and re-hydrated ONLY the
    // downstream — the long-completed upstream is left out of the graph.
    orchestrator.removeAllWorkflows();
    orchestrator.hydrateWorkflowFromDb(downstreamWfId);
    expect(orchestrator.getAllTasks().every((t) => t.config.workflowId === downstreamWfId)).toBe(
      true,
    );

    // The gate must clear from durable state: the upstream merge is completed
    // in the DB even though it is not in memory.
    const readiness = orchestrator.getTaskLaunchReadiness(downstreamRootId);
    expect(readiness.reason ?? '').not.toMatch(/prerequisite|waiting on/i);
    expect(readiness.ready).toBe(true);

    const started = orchestrator.startExecution();
    expect(started.map((t) => t.id)).toContain(downstreamRootId);
    expect(orchestrator.getTask(downstreamRootId)!.status).toBe('running');
  });
});
