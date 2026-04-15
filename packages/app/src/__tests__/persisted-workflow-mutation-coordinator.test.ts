import { afterEach, describe, expect, it } from 'vitest';
import { SQLiteAdapter } from '@invoker/data-store';
import { PersistedWorkflowMutationCoordinator } from '../persisted-workflow-mutation-coordinator.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

async function waitFor(condition: () => boolean, attempts: number = 20): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    if (condition()) return;
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe('PersistedWorkflowMutationCoordinator', () => {
  const adapters: SQLiteAdapter[] = [];

  afterEach(() => {
    for (const adapter of adapters.splice(0)) {
      adapter.close();
    }
  });

  it('high-priority queued work runs before queued normal work for the same workflow', async () => {
    const adapter = await SQLiteAdapter.create(':memory:');
    adapters.push(adapter);
    adapter.saveWorkflow({
      id: 'wf-1',
      name: 'wf-1',
      status: 'running',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const order: string[] = [];
    const gate = deferred();
    const coordinator = new PersistedWorkflowMutationCoordinator(
      adapter,
      'owner-1',
      async (channel, args) => {
        order.push(`${channel}:${String(args[0])}`);
        if (args[0] === 'running-normal') {
          await gate.promise;
        }
      },
    );

    const running = coordinator.enqueue<void>('wf-1', 'normal', 'mut', ['running-normal']);
    const queuedNormal = coordinator.enqueue<void>('wf-1', 'normal', 'mut', ['queued-normal']);
    const queuedHigh = coordinator.enqueue<void>('wf-1', 'high', 'mut', ['queued-high']);

    await Promise.resolve();
    gate.resolve();
    await running;
    await queuedHigh;
    await queuedNormal;

    expect(order).toEqual(['mut:running-normal', 'mut:queued-high', 'mut:queued-normal']);
  });

  it('requeues interrupted running workflow mutations on restart and drains persisted queued work', async () => {
    const adapter = await SQLiteAdapter.create(':memory:');
    adapters.push(adapter);
    adapter.saveWorkflow({
      id: 'wf-1',
      name: 'wf-1',
      status: 'running',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const firstGate = deferred();
    const owner1Order: string[] = [];
    const owner1 = new PersistedWorkflowMutationCoordinator(
      adapter,
      'owner-1',
      async (_channel, args) => {
        owner1Order.push(String(args[0]));
        await firstGate.promise;
      },
    );

    void owner1.enqueue<void>('wf-1', 'normal', 'mut', ['first']);
    await Promise.resolve();
    const queuedSecond = adapter.enqueueWorkflowMutationIntent('wf-1', 'mut', ['second'], 'normal');
    expect(adapter.listWorkflowMutationIntents('wf-1').map((intent) => intent.id)).toContain(queuedSecond);

    const owner2Order: string[] = [];
    const owner2 = new PersistedWorkflowMutationCoordinator(
      adapter,
      'owner-2',
      async (_channel, args) => {
        owner2Order.push(String(args[0]));
      },
    );

    adapter.requeueExpiredWorkflowMutationLeases(new Date(Date.now() + 60_000));
    await owner2.resumePending();

    expect(owner1Order).toEqual(['first']);
    expect(owner2Order).toEqual(['first', 'second']);
    expect(adapter.listWorkflowMutationIntents('wf-1', ['queued', 'running'])).toEqual([]);
    expect(adapter.listWorkflowMutationIntents('wf-1', ['completed'])).toHaveLength(2);
  });

  it('does not let another owner steal a live workflow lease', async () => {
    const adapter = await SQLiteAdapter.create(':memory:');
    adapters.push(adapter);
    adapter.saveWorkflow({
      id: 'wf-1',
      name: 'wf-1',
      status: 'running',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const gate = deferred();
    const owner1Order: string[] = [];
    const owner1 = new PersistedWorkflowMutationCoordinator(
      adapter,
      'owner-1',
      async (_channel, args) => {
        owner1Order.push(String(args[0]));
        if (args[0] === 'first') {
          await gate.promise;
        }
      },
    );

    void owner1.enqueue<void>('wf-1', 'normal', 'mut', ['first']);
    await Promise.resolve();
    adapter.enqueueWorkflowMutationIntent('wf-1', 'mut', ['second'], 'normal');
    const owner2Order: string[] = [];
    const owner2 = new PersistedWorkflowMutationCoordinator(
      adapter,
      'owner-2',
      async (_channel, args) => {
        owner2Order.push(String(args[0]));
      },
    );
    await Promise.resolve();
    await owner2.resumePending();

    expect(owner1Order).toEqual(['first']);
    expect(owner2Order).toEqual([]);
    expect(adapter.listWorkflowMutationLeases()).toHaveLength(1);

    gate.resolve();
    await waitFor(() => owner1Order.length === 2);

    expect(owner1Order).toEqual(['first', 'second']);
    expect(owner2Order).toEqual([]);
    expect(adapter.listWorkflowMutationLeases()).toHaveLength(0);
  });

  it('submit returns immediately while persisted work drains in the background', async () => {
    const adapter = await SQLiteAdapter.create(':memory:');
    adapters.push(adapter);
    adapter.saveWorkflow({
      id: 'wf-1',
      name: 'wf-1',
      status: 'running',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const gate = deferred();
    const order: string[] = [];
    const coordinator = new PersistedWorkflowMutationCoordinator(
      adapter,
      'owner-1',
      async (_channel, args) => {
        order.push(String(args[0]));
        await gate.promise;
      },
    );

    const intentId = coordinator.submit('wf-1', 'high', 'mut', ['burst']);
    expect(intentId).toBeGreaterThan(0);
    expect(adapter.listWorkflowMutationIntents('wf-1')[0]?.status).toMatch(/queued|running/);

    await waitFor(() => order.length === 1);
    expect(order).toEqual(['burst']);

    gate.resolve();
    await waitFor(() => adapter.listWorkflowMutationIntents('wf-1', ['completed']).length === 1);
  });
});
