import { describe, it, expect, vi } from 'vitest';
import { Orchestrator } from '../orchestrator.js';
import { InMemoryPersistence, InMemoryBus } from './helpers/cross-workflow-cascade-helpers.js';

describe('getQueueStatus UI poll fast path', () => {
  it('refresh:false skips launch-order snapshot work and caches briefly', () => {
    const persistence = new InMemoryPersistence();
    const loadAttempt = vi.spyOn(persistence, 'loadAttempt');
    const orchestrator = new Orchestrator({
      persistence,
      messageBus: new InMemoryBus(),
      maxConcurrency: 2,
    });

    orchestrator.loadPlan({
      name: 'ui-poll-fast',
      baseBranch: 'master',
      featureBranch: 'feature/ui-poll',
      tasks: [
        { id: 'a', description: 'A'.repeat(400) },
        { id: 'b', description: 'B', dependencies: ['a'] },
        { id: 'c', description: 'C' },
      ],
    });
    orchestrator.startExecution();

    loadAttempt.mockClear();
    const first = orchestrator.getQueueStatus({ refresh: false });
    expect(first.runningCount).toBeGreaterThan(0);
    expect(first.running[0]?.description.length).toBeLessThanOrEqual(160);
    // UI poll must not hit SQLite/attempt storage — that is what froze the GUI.
    expect(loadAttempt).not.toHaveBeenCalled();

    const second = orchestrator.getQueueStatus({ refresh: false });
    expect(second).toBe(first);
    expect(loadAttempt).not.toHaveBeenCalled();
  });
});
