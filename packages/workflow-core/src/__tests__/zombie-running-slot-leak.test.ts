import { describe, it, expect } from 'vitest';
import { Orchestrator } from '../orchestrator.js';
import { InMemoryPersistence, InMemoryBus } from './helpers/cross-workflow-cascade-helpers.js';

function makeOrchestratorWith(persistence: InMemoryPersistence, maxConcurrency: number): Orchestrator {
  return new Orchestrator({ persistence, messageBus: new InMemoryBus(), maxConcurrency });
}

/**
 * Repro for bug #1: a task stuck in `running` whose attempt lease has expired
 * (its executor stopped heart-beating and no completion ever arrived) keeps
 * consuming a global concurrency slot forever. With a full slot table, a
 * genuinely ready pending task can never launch even though nothing is really
 * executing.
 */
describe('zombie running task consumes a concurrency slot', () => {
  it('does not count a running task with an expired lease against capacity', () => {
    const persistence = new InMemoryPersistence();
    const orchestrator = makeOrchestratorWith(persistence, 1);

    // Workflow A takes the single slot and starts running.
    orchestrator.loadPlan({
      name: 'zombie-workflow',
      baseBranch: 'master',
      featureBranch: 'feature/zombie',
      tasks: [{ id: 'stuck', description: 'runs then strands' }],
    });
    const zombieId = orchestrator.getAllTasks().find((t) => t.id.endsWith('/stuck'))!.id;
    orchestrator.startExecution();
    expect(orchestrator.getTask(zombieId)!.status).toBe('running');

    // Its executor dies without a completion: the lease lapses far in the past.
    const attemptId = orchestrator.getTask(zombieId)!.execution.selectedAttemptId!;
    const longAgo = new Date(Date.now() - 60 * 60 * 1000);
    (persistence.updateAttempt as (id: string, changes: Record<string, unknown>) => void)(attemptId, {
      leaseExpiresAt: longAgo,
      lastHeartbeatAt: longAgo,
    });

    // Workflow B is ready and only needs the one slot the zombie is squatting.
    orchestrator.loadPlan({
      name: 'blocked-workflow',
      baseBranch: 'master',
      featureBranch: 'feature/blocked',
      tasks: [{ id: 'wants-slot', description: 'ready, waiting for capacity' }],
    });
    const waitingId = orchestrator.getAllTasks().find((t) => t.id.endsWith('/wants-slot'))!.id;

    const started = orchestrator.startExecution();

    expect(started.map((t) => t.id)).toContain(waitingId);
    expect(orchestrator.getTask(waitingId)!.status).toBe('running');
  });

  it('does not count a running task with a missing leaseExpiresAt and stale heartbeat', () => {
    const persistence = new InMemoryPersistence();
    const orchestrator = makeOrchestratorWith(persistence, 1);

    orchestrator.loadPlan({
      name: 'zombie-no-lease-expiry',
      baseBranch: 'master',
      featureBranch: 'feature/zombie-no-lease',
      tasks: [{ id: 'stuck', description: 'runs then strands without lease expiry' }],
    });
    const zombieId = orchestrator.getAllTasks().find((t) => t.id.endsWith('/stuck'))!.id;
    orchestrator.startExecution();
    expect(orchestrator.getTask(zombieId)!.status).toBe('running');

    const attemptId = orchestrator.getTask(zombieId)!.execution.selectedAttemptId!;
    const longAgo = new Date(Date.now() - 60 * 60 * 1000);
    (persistence.updateAttempt as (id: string, changes: Record<string, unknown>) => void)(attemptId, {
      leaseExpiresAt: undefined,
      lastHeartbeatAt: longAgo,
      claimedAt: longAgo,
    });

    orchestrator.loadPlan({
      name: 'blocked-by-stale-heartbeat',
      baseBranch: 'master',
      featureBranch: 'feature/blocked-stale',
      tasks: [{ id: 'wants-slot', description: 'ready, waiting for capacity' }],
    });
    const waitingId = orchestrator.getAllTasks().find((t) => t.id.endsWith('/wants-slot'))!.id;

    const started = orchestrator.startExecution();
    expect(started.map((t) => t.id)).toContain(waitingId);
    expect(orchestrator.getQueueStatus({ refresh: true }).runningCount).toBeLessThanOrEqual(1);
  });
});
