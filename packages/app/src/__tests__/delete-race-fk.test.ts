import { afterEach, describe, expect, it } from 'vitest';
import { SQLiteAdapter } from '@invoker/data-store';
import { PersistedWorkflowMutationCoordinator } from '../persisted-workflow-mutation-coordinator.js';
import { enqueueWorkflowMutationOrAcknowledgeDeleted } from '../workflow-mutation-submit.js';

describe('delete race: duplicate owner re-delegates delete after workflow is already gone', () => {
  const adapters: SQLiteAdapter[] = [];

  afterEach(() => {
    for (const adapter of adapters.splice(0)) {
      adapter.close();
    }
  });

  async function setupRacedDelete(): Promise<{
    adapter: SQLiteAdapter;
    coordinator: PersistedWorkflowMutationCoordinator;
  }> {
    const adapter = await SQLiteAdapter.create(':memory:');
    adapters.push(adapter);
    adapter.saveWorkflow({
      id: 'wf-1',
      name: 'wf-1',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const coordinator = new PersistedWorkflowMutationCoordinator(
      adapter,
      'owner-2',
      async () => undefined,
    );

    // Owner A's delete already completed (as it would shortly after the
    // delegating client's 5s delegation timeout fired and it fell back to a
    // second, competing owner that re-ran the same `delete wf-1` command).
    adapter.deleteWorkflow('wf-1');

    return { adapter, coordinator };
  }

  it('raw PersistedWorkflowMutationCoordinator.enqueue() throws the raw FK error (documents the underlying failure)', async () => {
    const { coordinator } = await setupRacedDelete();

    let thrown: unknown;
    try {
      await coordinator.enqueue('wf-1', 'normal', 'headless.exec', [{ args: ['delete', 'wf-1'] }]);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain('FOREIGN KEY constraint failed');
  });

  it('enqueueWorkflowMutationOrAcknowledgeDeleted returns a clean accepted result instead of throwing', async () => {
    const { adapter, coordinator } = await setupRacedDelete();

    const result = await enqueueWorkflowMutationOrAcknowledgeDeleted(
      'wf-1',
      'normal',
      'headless.exec',
      [{ args: ['delete', 'wf-1'] }],
      {
        coordinator,
        workflowExists: (id) => Boolean(adapter.loadWorkflow(id)),
      },
    );

    expect(result).toEqual({
      ok: true,
      accepted: true,
      intentId: 0,
      workflowId: 'wf-1',
      channel: 'headless.exec',
    });
  });

  it('does not swallow FK errors for mutations that are not missing-workflow idempotent', async () => {
    const { coordinator } = await setupRacedDelete();

    let thrown: unknown;
    try {
      await enqueueWorkflowMutationOrAcknowledgeDeleted(
        'wf-1',
        'normal',
        'headless.exec',
        [{ args: ['approve', 'wf-1/task-a'] }],
        {
          coordinator,
          workflowExists: () => false,
        },
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain('FOREIGN KEY constraint failed');
  });
});
