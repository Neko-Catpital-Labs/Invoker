/**
 * Repro: after owner crash, a mutation intent can stay `running` with no live
 * lease. Fixed: `resumePending()` also requeues orphaned running intents.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { SQLiteAdapter } from '@invoker/data-store';
import { PersistedWorkflowMutationCoordinator } from '../persisted-workflow-mutation-coordinator.js';

describe('orphaned workflow mutation intents on resumePending (repro)', () => {
  const adapters: SQLiteAdapter[] = [];

  afterEach(() => {
    for (const adapter of adapters.splice(0)) {
      adapter.close();
    }
  });

  it('fixed: resumePending requeues and drains running intents without a lease', async () => {
    const adapter = await SQLiteAdapter.create(':memory:');
    adapters.push(adapter);
    adapter.saveWorkflow({
      id: 'wf-1',
      name: 'wf-1',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    adapter.enqueueWorkflowMutationIntent('wf-1', 'mut', ['orphan'], 'normal');
    const claimed = adapter.claimNextWorkflowMutationIntent('wf-1', 'dead-owner');
    expect(claimed?.status).toBe('running');

    let drained = 0;
    const owner2 = new PersistedWorkflowMutationCoordinator(
      adapter,
      'owner-2',
      async () => {
        drained += 1;
      },
    );

    await owner2.resumePending();

    expect(drained).toBe(1);
    expect(adapter.listWorkflowMutationIntents('wf-1', ['running', 'queued'])).toHaveLength(0);
    expect(adapter.listWorkflowMutationIntents('wf-1', ['completed'])).toHaveLength(1);
  });
});
