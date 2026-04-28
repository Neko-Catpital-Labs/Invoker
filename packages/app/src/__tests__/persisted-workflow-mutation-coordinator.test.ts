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

  it('evicts older queued workflow intents when a headless recreate fence starts', async () => {
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
        const payload = args[0] as { args?: string[] } | undefined;
        const command = payload?.args?.join(' ') ?? 'unknown';
        order.push(command);
        if (command.includes('hold-work')) {
          await gate.promise;
        }
      },
    );

    const running = coordinator.enqueue<void>('wf-1', 'normal', 'headless.exec', [{ args: ['set', 'command', 'wf-1/task-0', 'hold-work'] }]);
    void running.catch(() => {});
    const olderQueued = coordinator.enqueue<void>('wf-1', 'normal', 'headless.exec', [{ args: ['set', 'agent', 'wf-1/task-1', 'codex'] }]);
    void olderQueued.catch(() => {});
    const recreateFence = coordinator.enqueue<void>('wf-1', 'high', 'headless.exec', [{ args: ['recreate', 'wf-1'] }]);
    const newerQueued = coordinator.enqueue<void>('wf-1', 'normal', 'headless.exec', [{ args: ['set', 'agent', 'wf-1/task-2', 'claude'] }]);

    await Promise.resolve();
    await recreateFence;
    await newerQueued;
    await expect(running).rejects.toThrow(/superseded by recreate intent/i);
    await expect(olderQueued).rejects.toThrow(/evicted/i);

    expect(order).toEqual([
      'set command wf-1/task-0 hold-work',
      'recreate wf-1',
      'set agent wf-1/task-2 claude',
    ]);
    const intents = adapter.listWorkflowMutationIntents('wf-1');
    const evictedIntent = intents.find((intent) => Array.isArray(intent.args) && JSON.stringify(intent.args).includes('wf-1/task-1'));
    const invalidatedIntent = intents.find((intent) => intent.id === 1);
    expect(invalidatedIntent?.status).toBe('failed');
    expect(invalidatedIntent?.error).toContain('Superseded by recreate intent #3');
    expect(evictedIntent?.status).toBe('failed');
    expect(evictedIntent?.error).toContain('queue fence');
    gate.resolve();
  });

  it('invalidates an older running workflow intent when recreate is enqueued', async () => {
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
        const payload = args[0] as { args?: string[] } | undefined;
        const command = payload?.args?.join(' ') ?? String(args[0]);
        order.push(command);
        if (command.includes('hold-work')) {
          await gate.promise;
        }
      },
    );

    const olderRunning = coordinator.enqueue<void>(
      'wf-1',
      'normal',
      'headless.exec',
      [{ args: ['set', 'command', 'wf-1/task-0', 'hold-work'] }],
    );
    void olderRunning.catch(() => {});
    await waitFor(() => adapter.listWorkflowMutationIntents('wf-1', ['running']).length === 1);

    const recreate = coordinator.enqueue<void>(
      'wf-1',
      'high',
      'headless.exec',
      [{ args: ['recreate', 'wf-1'] }],
    );
    const newerQueued = coordinator.enqueue<void>(
      'wf-1',
      'normal',
      'headless.exec',
      [{ args: ['set', 'agent', 'wf-1/task-2', 'claude'] }],
    );

    await recreate;
    await newerQueued;
    await expect(olderRunning).rejects.toThrow(/superseded by recreate intent/i);

    const intents = adapter.listWorkflowMutationIntents('wf-1');
    expect(intents.find((intent) => intent.id === 1)?.status).toBe('failed');
    expect(intents.find((intent) => intent.id === 1)?.error).toContain('Superseded by recreate intent #2');
    expect(order).toEqual([
      'set command wf-1/task-0 hold-work',
      'recreate wf-1',
      'set agent wf-1/task-2 claude',
    ]);

    gate.resolve();
  });

  it('invalidates an older running workflow intent when GUI recreate-task is enqueued', async () => {
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
      async (channel, args) => {
        order.push(`${channel}:${String(args[0])}`);
        if (channel === 'invoker:fix-with-agent') {
          await gate.promise;
        }
      },
    );

    const olderRunning = coordinator.enqueue<void>(
      'wf-1',
      'normal',
      'invoker:fix-with-agent',
      ['wf-1/blocker-task', null],
    );
    await waitFor(() => adapter.listWorkflowMutationIntents('wf-1', ['running']).length === 1);

    const recreateTask = coordinator.enqueue<void>(
      'wf-1',
      'high',
      'invoker:recreate-task',
      ['wf-1/target-task'],
    );
    await recreateTask;
    await expect(olderRunning).rejects.toThrow(/superseded by recreate intent/i);

    const intentsAfterRecreate = adapter.listWorkflowMutationIntents('wf-1');
    expect(intentsAfterRecreate.find((intent) => intent.id === 1)?.status).toBe('failed');
    expect(intentsAfterRecreate.find((intent) => intent.id === 1)?.error).toContain('Superseded by recreate intent #2');
    expect(intentsAfterRecreate.find((intent) => intent.id === 2)?.status).toBe('completed');
    expect(order).toEqual([
      'invoker:fix-with-agent:wf-1/blocker-task',
      'invoker:recreate-task:wf-1/target-task',
    ]);
  });

  it('invalidates an older running workflow intent when headless recreate-task is enqueued', async () => {
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
        const payload = args[0] as { args?: string[] } | undefined;
        const command = payload?.args?.join(' ') ?? 'unknown';
        order.push(command);
        if (command.includes('hold-work')) {
          await gate.promise;
        }
      },
    );

    const olderRunning = coordinator.enqueue<void>(
      'wf-1',
      'normal',
      'headless.exec',
      [{ args: ['set', 'command', 'wf-1/blocker-task', 'hold-work'] }],
    );
    await waitFor(() => adapter.listWorkflowMutationIntents('wf-1', ['running']).length === 1);

    const recreateTask = coordinator.enqueue<void>(
      'wf-1',
      'high',
      'headless.exec',
      [{ args: ['recreate-task', 'wf-1/target-task'] }],
    );
    await recreateTask;
    await expect(olderRunning).rejects.toThrow(/superseded by recreate intent/i);

    const intentsAfterRecreate = adapter.listWorkflowMutationIntents('wf-1');
    expect(intentsAfterRecreate.find((intent) => intent.id === 1)?.status).toBe('failed');
    expect(intentsAfterRecreate.find((intent) => intent.id === 1)?.error).toContain('Superseded by recreate intent #2');
    expect(intentsAfterRecreate.find((intent) => intent.id === 2)?.status).toBe('completed');
    expect(order).toEqual([
      'set command wf-1/blocker-task hold-work',
      'recreate-task wf-1/target-task',
    ]);
  });

  it('evicts older queued workflow intents when GUI recreate-task fence starts', async () => {
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
      async (channel, args) => {
        order.push(`${channel}:${String(args[0])}`);
        if (channel === 'invoker:fix-with-agent') {
          await gate.promise;
        }
      },
    );

    const running = coordinator.enqueue<void>('wf-1', 'normal', 'invoker:fix-with-agent', ['wf-1/blocker-task', null]);
    void running.catch(() => {});
    const olderQueued = coordinator.enqueue<void>('wf-1', 'normal', 'invoker:edit-task-agent', ['old-queued']);
    void olderQueued.catch(() => {});
    const recreateTask = coordinator.enqueue<void>('wf-1', 'high', 'invoker:recreate-task', ['wf-1/target-task']);
    const newerQueued = coordinator.enqueue<void>('wf-1', 'normal', 'invoker:edit-task-agent', ['new-queued']);

    await recreateTask;
    await newerQueued;
    await expect(running).rejects.toThrow(/superseded by recreate intent/i);
    await expect(olderQueued).rejects.toThrow(/evicted/i);

    expect(order).toEqual([
      'invoker:fix-with-agent:wf-1/blocker-task',
      'invoker:recreate-task:wf-1/target-task',
      'invoker:edit-task-agent:new-queued',
    ]);
  });

  it('evicts older queued workflow intents when retry-workflow fence starts', async () => {
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
      async (channel, args) => {
        const label = `${channel}:${String(args[0])}`;
        order.push(label);
        if (label.includes('hold-work')) {
          await gate.promise;
        }
      },
    );

    const running = coordinator.enqueue<void>('wf-1', 'normal', 'invoker:edit-task-command', ['hold-work']);
    const olderQueued = coordinator.enqueue<void>('wf-1', 'normal', 'invoker:edit-task-agent', ['old-queued']);
    void olderQueued.catch(() => {});
    const retryFence = coordinator.enqueue<void>('wf-1', 'high', 'invoker:retry-workflow', ['wf-1']);
    const newerQueued = coordinator.enqueue<void>('wf-1', 'normal', 'invoker:edit-task-agent', ['new-queued']);

    await Promise.resolve();
    gate.resolve();
    await running;
    await retryFence;
    await newerQueued;
    await expect(olderQueued).rejects.toThrow(/evicted/i);

    expect(order).toEqual([
      'invoker:edit-task-command:hold-work',
      'invoker:retry-workflow:wf-1',
      'invoker:edit-task-agent:new-queued',
    ]);
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

  it('requeues interrupted fix-with-agent workflow mutations on restart', async () => {
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
      async (channel, args) => {
        owner1Order.push(`${channel}:${String(args[0])}`);
        await firstGate.promise;
      },
    );

    void owner1.enqueue<void>('wf-1', 'normal', 'invoker:fix-with-agent', ['wf-1/task-fail', 'claude']);
    await waitFor(() => adapter.listWorkflowMutationIntents('wf-1', ['running']).length === 1);

    const owner2Order: string[] = [];
    const owner2 = new PersistedWorkflowMutationCoordinator(
      adapter,
      'owner-2',
      async (channel, args) => {
        owner2Order.push(`${channel}:${String(args[0])}`);
      },
    );

    adapter.requeueExpiredWorkflowMutationLeases(new Date(Date.now() + 60_000));
    await owner2.resumePending();

    expect(owner1Order).toEqual(['invoker:fix-with-agent:wf-1/task-fail']);
    expect(owner2Order).toEqual(['invoker:fix-with-agent:wf-1/task-fail']);
    expect(adapter.listWorkflowMutationIntents('wf-1', ['queued', 'running'])).toEqual([]);
    expect(adapter.listWorkflowMutationIntents('wf-1', ['completed'])).toHaveLength(1);
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

  it('bounds concurrent workflow drains across workflows during resume and burst submission', async () => {
    const adapter = await SQLiteAdapter.create(':memory:');
    adapters.push(adapter);
    for (let index = 1; index <= 4; index += 1) {
      adapter.saveWorkflow({
        id: `wf-${index}`,
        name: `wf-${index}`,
        status: 'running',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      adapter.enqueueWorkflowMutationIntent(`wf-${index}`, 'mut', [`job-${index}`], 'normal');
    }

    const gates = new Map<string, ReturnType<typeof deferred>>();
    const started: string[] = [];
    let active = 0;
    let maxActive = 0;
    const coordinator = new PersistedWorkflowMutationCoordinator(
      adapter,
      'owner-1',
      async (_channel, args) => {
        const id = String(args[0]);
        started.push(id);
        active += 1;
        maxActive = Math.max(maxActive, active);
        const gate = deferred();
        gates.set(id, gate);
        await gate.promise;
        active -= 1;
      },
      { maxConcurrentWorkflowDrains: 2 },
    );

    const resumePromise = coordinator.resumePending();
    await waitFor(() => started.length === 2);
    expect(maxActive).toBe(2);

    gates.get('job-1')?.resolve();
    await waitFor(() => started.length === 3);
    expect(maxActive).toBe(2);

    gates.get('job-2')?.resolve();
    await waitFor(() => started.length === 4);
    expect(maxActive).toBe(2);

    gates.get('job-3')?.resolve();
    gates.get('job-4')?.resolve();
    await resumePromise;

    expect(adapter.listWorkflowMutationIntents(undefined, ['completed'])).toHaveLength(4);
    expect(maxActive).toBe(2);
  });
});
