import { afterEach, describe, expect, it } from 'vitest';
import type { WorkflowMutationFailedEvent } from '@invoker/contracts';
import { SQLiteAdapter } from '@invoker/data-store';
import type { TaskState } from '@invoker/workflow-core';
import {
  PersistedWorkflowMutationCoordinator,
  type WorkflowMutationContext,
} from '../persisted-workflow-mutation-coordinator.js';
import { dispatchStartedTasksWithGlobalTopup } from '../global-topup.js';

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

function makeTask(id: string, workflowId: string = 'wf-1'): TaskState {
  return {
    id,
    description: id,
    status: 'pending',
    dependencies: [],
    createdAt: new Date(),
    config: { workflowId },
    execution: {},
    taskStateVersion: 1,
  };
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
    adapter.saveWorkflow({ id: 'wf-1',
    name: 'wf-1', createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(), });

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

  it('releases a workflow lease after fire-and-forget task launch acceptance', async () => {
    const adapter = await SQLiteAdapter.create(':memory:');
    adapters.push(adapter);
    adapter.saveWorkflow({ id: 'wf-1',
    name: 'wf-1', createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(), });

    const startedTask = {
      id: 'task-a',
      description: 'task-a',
      status: 'running',
      dependencies: [],
      createdAt: new Date(),
      config: { workflowId: 'wf-1' },
      execution: { selectedAttemptId: 'attempt-a' },
    };
    const order: string[] = [];
    const taskExecutor = {
      executeTasks: async () => new Promise<void>(() => {}),
    };
    const coordinator = new PersistedWorkflowMutationCoordinator(
      adapter,
      'owner-1',
      async (channel) => {
        order.push(channel);
        if (channel === 'first') {
          await dispatchStartedTasksWithGlobalTopup({
            orchestrator: { startExecution: () => [] } as any,
            taskExecutor: taskExecutor as any,
            context: 'test.workflow-mutation-lease',
            started: [startedTask as any],
            dispatchMode: 'fire-and-forget',
          });
        }
      },
    );

    const first = coordinator.enqueue<void>('wf-1', 'normal', 'first', []);
    await waitFor(() => adapter.listWorkflowMutationIntents('wf-1', ['completed']).length === 1);
    const second = coordinator.enqueue<void>('wf-1', 'normal', 'second', []);

    await first;
    await second;

    expect(order).toEqual(['first', 'second']);
    expect(adapter.listWorkflowMutationLeases()).toHaveLength(0);
  });

  it('emits taskId for task-targeted headless.exec failures', async () => {
    const adapter = await SQLiteAdapter.create(':memory:');
    adapters.push(adapter);
    adapter.saveWorkflow({
      id: 'wf-1',
      name: 'wf-1',
      status: 'running',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    adapter.saveTask('wf-1', makeTask('wf-1/task-a'));

    const failedEvents: WorkflowMutationFailedEvent[] = [];
    const coordinator = new PersistedWorkflowMutationCoordinator(
      adapter,
      'owner-1',
      async () => {
        throw new Error('task mutation failed');
      },
      { onIntentFailed: (event) => failedEvents.push(event) },
    );

    await expect(coordinator.enqueue<void>(
      'wf-1',
      'normal',
      'headless.exec',
      [{ args: ['set', 'command', 'wf-1/task-a', 'echo hi'] }],
    )).rejects.toThrow('task mutation failed');

    expect(failedEvents).toHaveLength(1);
    expect(failedEvents[0]).toMatchObject({
      workflowId: 'wf-1',
      channel: 'headless.exec',
      taskId: 'wf-1/task-a',
    });
    const failureAuditEvents = adapter.getEvents('wf-1/task-a')
      .filter((event) => event.eventType === 'workflow.mutation.failed');
    expect(failureAuditEvents).toHaveLength(1);
    expect(JSON.parse(failureAuditEvents[0]!.payload ?? '{}')).toMatchObject({
      channel: 'headless.exec',
      taskId: 'wf-1/task-a',
    });
  });

  it('does not emit taskId for workflow-targeted headless.exec failures', async () => {
    const adapter = await SQLiteAdapter.create(':memory:');
    adapters.push(adapter);
    adapter.saveWorkflow({
      id: 'wf-1',
      name: 'wf-1',
      status: 'running',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    adapter.saveTask('wf-1', makeTask('wf-1/task-a'));

    const failedEvents: WorkflowMutationFailedEvent[] = [];
    const coordinator = new PersistedWorkflowMutationCoordinator(
      adapter,
      'owner-1',
      async () => {
        throw new Error('workflow mutation failed');
      },
      { onIntentFailed: (event) => failedEvents.push(event) },
    );

    await expect(coordinator.enqueue<void>(
      'wf-1',
      'normal',
      'headless.exec',
      [{ args: ['recreate', 'wf-1'] }],
    )).rejects.toThrow('workflow mutation failed');

    expect(failedEvents).toHaveLength(1);
    expect(failedEvents[0]).toMatchObject({
      workflowId: 'wf-1',
      channel: 'headless.exec',
    });
    expect(failedEvents[0]).not.toHaveProperty('taskId');
    expect(adapter.getEvents('wf-1/task-a')
      .filter((event) => event.eventType === 'workflow.mutation.failed')).toEqual([]);
  });

  it('keeps invoker channel failure taskId behavior unchanged', async () => {
    const adapter = await SQLiteAdapter.create(':memory:');
    adapters.push(adapter);
    adapter.saveWorkflow({
      id: 'wf-1',
      name: 'wf-1',
      status: 'running',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    adapter.saveTask('wf-1', makeTask('wf-1/task-a'));

    const failedEvents: WorkflowMutationFailedEvent[] = [];
    const coordinator = new PersistedWorkflowMutationCoordinator(
      adapter,
      'owner-1',
      async () => {
        throw new Error('invoker mutation failed');
      },
      { onIntentFailed: (event) => failedEvents.push(event) },
    );

    await expect(coordinator.enqueue<void>(
      'wf-1',
      'normal',
      'invoker:fix-with-agent',
      ['wf-1/task-a', 'codex'],
    )).rejects.toThrow('invoker mutation failed');

    expect(failedEvents).toHaveLength(1);
    expect(failedEvents[0]).toMatchObject({
      workflowId: 'wf-1',
      channel: 'invoker:fix-with-agent',
      taskId: 'wf-1/task-a',
    });
    const failureAuditEvents = adapter.getEvents('wf-1/task-a')
      .filter((event) => event.eventType === 'workflow.mutation.failed');
    expect(failureAuditEvents).toHaveLength(1);
    expect(JSON.parse(failureAuditEvents[0]!.payload ?? '{}')).toMatchObject({
      channel: 'invoker:fix-with-agent',
      taskId: 'wf-1/task-a',
    });
  });

  it('evicts older queued workflow intents when a delegated recreate fence starts', async () => {
    const adapter = await SQLiteAdapter.create(':memory:');
    adapters.push(adapter);
    adapter.saveWorkflow({ id: 'wf-1',
    name: 'wf-1', createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(), });

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
    adapter.saveWorkflow({ id: 'wf-1',
    name: 'wf-1', createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(), });

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

  it('invalidates an older running workflow intent when internal recreate-task is enqueued', async () => {
    const adapter = await SQLiteAdapter.create(':memory:');
    adapters.push(adapter);
    adapter.saveWorkflow({ id: 'wf-1',
    name: 'wf-1', createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(), });

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
    adapter.saveWorkflow({ id: 'wf-1',
    name: 'wf-1', createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(), });

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

  it('evicts older queued workflow intents when internal recreate-task fence starts', async () => {
    const adapter = await SQLiteAdapter.create(':memory:');
    adapters.push(adapter);
    adapter.saveWorkflow({ id: 'wf-1',
    name: 'wf-1', createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(), });

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

  it('evicts older queued workflow intents when rebase-recreate fence starts', async () => {
    const adapter = await SQLiteAdapter.create(':memory:');
    adapters.push(adapter);
    adapter.saveWorkflow({ id: 'wf-1',
    name: 'wf-1', createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(), });

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
    const rebaseRecreate = coordinator.enqueue<void>('wf-1', 'high', 'invoker:rebase-recreate', ['wf-1']);
    const newerQueued = coordinator.enqueue<void>('wf-1', 'normal', 'invoker:edit-task-agent', ['new-queued']);

    await rebaseRecreate;
    await newerQueued;
    await expect(running).rejects.toThrow(/superseded by recreate intent/i);
    await expect(olderQueued).rejects.toThrow(/evicted/i);

    expect(order).toEqual([
      'invoker:fix-with-agent:wf-1/blocker-task',
      'invoker:rebase-recreate:wf-1',
      'invoker:edit-task-agent:new-queued',
    ]);
  });

  it('invalidates an older running workflow intent when rebase-recreate is enqueued', async () => {
    const adapter = await SQLiteAdapter.create(':memory:');
    adapters.push(adapter);
    adapter.saveWorkflow({ id: 'wf-1',
    name: 'wf-1', createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(), });

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
    void olderRunning.catch(() => {});
    await waitFor(() => adapter.listWorkflowMutationIntents('wf-1', ['running']).length === 1);

    const rebaseRecreate = coordinator.enqueue<void>(
      'wf-1',
      'high',
      'invoker:rebase-recreate',
      ['wf-1'],
    );
    await rebaseRecreate;
    await expect(olderRunning).rejects.toThrow(/superseded by recreate intent/i);

    const intentsAfterRecreate = adapter.listWorkflowMutationIntents('wf-1');
    expect(intentsAfterRecreate.find((intent) => intent.id === 1)?.status).toBe('failed');
    expect(intentsAfterRecreate.find((intent) => intent.id === 1)?.error).toContain('Superseded by recreate intent #2');
    expect(intentsAfterRecreate.find((intent) => intent.id === 2)?.status).toBe('completed');
    expect(order).toEqual([
      'invoker:fix-with-agent:wf-1/blocker-task',
      'invoker:rebase-recreate:wf-1',
    ]);
  });

  it('treats headless rebase-recreate as a recreate fence', async () => {
    const adapter = await SQLiteAdapter.create(':memory:');
    adapters.push(adapter);
    adapter.saveWorkflow({ id: 'wf-1',
    name: 'wf-1', createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(), });

    const gate = deferred();
    const order: string[] = [];
    const coordinator = new PersistedWorkflowMutationCoordinator(
      adapter,
      'owner-1',
      async (channel, args) => {
        const payload = args[0] as { args?: unknown[] } | undefined;
        order.push(`${channel}:${Array.isArray(payload?.args) ? payload.args.join(' ') : String(args[0])}`);
        if (channel === 'invoker:fix-with-agent') {
          await gate.promise;
        }
      },
    );

    const running = coordinator.enqueue<void>('wf-1', 'normal', 'invoker:fix-with-agent', ['wf-1/blocker-task', null]);
    void running.catch(() => {});
    const olderQueued = coordinator.enqueue<void>('wf-1', 'normal', 'invoker:edit-task-agent', ['old-queued']);
    void olderQueued.catch(() => {});
    const rebaseRecreate = coordinator.enqueue<void>(
      'wf-1',
      'high',
      'headless.exec',
      [{ args: ['rebase-recreate', 'wf-1'], noTrack: true }],
    );
    const newerQueued = coordinator.enqueue<void>('wf-1', 'normal', 'invoker:edit-task-agent', ['new-queued']);

    await rebaseRecreate;
    await newerQueued;
    await expect(running).rejects.toThrow(/superseded by recreate intent/i);
    await expect(olderQueued).rejects.toThrow(/evicted/i);

    expect(order).toEqual([
      'invoker:fix-with-agent:wf-1/blocker-task',
      'headless.exec:rebase-recreate wf-1',
      'invoker:edit-task-agent:new-queued',
    ]);
  });

  it('evicts older queued workflow intents when retry-workflow fence starts', async () => {
    const adapter = await SQLiteAdapter.create(':memory:');
    adapters.push(adapter);
    adapter.saveWorkflow({ id: 'wf-1',
    name: 'wf-1', createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(), });

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

  it('coalesces duplicate fire-and-forget headless workflow retries while queued or running', async () => {
    const adapter = await SQLiteAdapter.create(':memory:');
    adapters.push(adapter);
    adapter.saveWorkflow({ id: 'wf-1',
    name: 'wf-1', createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(), });
    adapter.saveWorkflow({ id: 'wf-2',
    name: 'wf-2', createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(), });

    const runningGate = deferred();
    const order: string[] = [];
    const coordinator = new PersistedWorkflowMutationCoordinator(
      adapter,
      'owner-1',
      async (_channel, args) => {
        const payload = args[0] as { args?: string[] } | undefined;
        const command = payload?.args?.join(' ') ?? String(args[0]);
        order.push(command);
        if (command === 'retry wf-2') {
          await runningGate.promise;
        }
      },
    );

    const firstQueued = coordinator.submit(
      'wf-1',
      'high',
      'headless.exec',
      [{ args: ['retry', 'wf-1'], noTrack: true }],
      { deferDrain: true },
    );
    const queuedDuplicates = Array.from({ length: 25 }, () =>
      coordinator.submit(
        'wf-1',
        'high',
        'headless.exec',
        [{ args: ['retry', 'wf-1'], noTrack: true }],
        { deferDrain: true },
      ),
    );

    expect(new Set([firstQueued, ...queuedDuplicates])).toEqual(new Set([firstQueued]));

    const firstRunning = coordinator.submit(
      'wf-2',
      'high',
      'headless.exec',
      [{ args: ['retry', 'wf-2'], noTrack: true }],
    );
    await waitFor(() => order.includes('retry wf-2'));

    const runningDuplicates = Array.from({ length: 25 }, () =>
      coordinator.submit(
        'wf-2',
        'high',
        'headless.exec',
        [{ args: ['retry', 'wf-2'], noTrack: true }],
      ),
    );

    expect(new Set([firstRunning, ...runningDuplicates])).toEqual(new Set([firstRunning]));
    runningGate.resolve();

    await waitFor(() => adapter.listWorkflowMutationIntents(undefined, ['completed']).length === 2);

    expect(order.sort()).toEqual(['retry wf-1', 'retry wf-2']);
    expect(adapter.listWorkflowMutationIntents('wf-1')).toHaveLength(1);
    expect(adapter.listWorkflowMutationIntents('wf-2')).toHaveLength(1);
  });

  it('coalesces duplicate start-ready intents while queued', async () => {
    const adapter = await SQLiteAdapter.create(':memory:');
    adapters.push(adapter);
    adapter.saveWorkflow({ id: 'wf-1',
    name: 'wf-1', createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(), });

    const coordinator = new PersistedWorkflowMutationCoordinator(
      adapter,
      'owner-1',
      async () => undefined,
    );

    const first = coordinator.submit(
      'wf-1',
      'normal',
      'invoker:start-ready',
      [{}],
      { deferDrain: true },
    );
    const duplicates = Array.from({ length: 5 }, () =>
      coordinator.submit(
        'wf-1',
        'normal',
        'invoker:start-ready',
        [{}],
        { deferDrain: true },
      ),
    );

    expect(new Set([first, ...duplicates])).toEqual(new Set([first]));
    expect(adapter.listWorkflowMutationIntents('wf-1')).toHaveLength(1);
  });

  it('requeues interrupted running workflow mutations on restart and drains persisted queued work', async () => {
    const adapter = await SQLiteAdapter.create(':memory:');
    adapters.push(adapter);
    adapter.saveWorkflow({ id: 'wf-1',
    name: 'wf-1', createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(), });

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
    adapter.saveWorkflow({ id: 'wf-1',
    name: 'wf-1', createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(), });

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
    adapter.saveWorkflow({ id: 'wf-1',
    name: 'wf-1', createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(), });

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
    adapter.saveWorkflow({ id: 'wf-1',
    name: 'wf-1', createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(), });

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

  it('starts all queued workflow drains across workflows during resume', async () => {
    const adapter = await SQLiteAdapter.create(':memory:');
    adapters.push(adapter);
    for (let index = 1; index <= 4; index += 1) {
      adapter.saveWorkflow({ id: `wf-${index}`,
      name: `wf-${index}`, createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(), });
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
    );

    const resumePromise = coordinator.resumePending();
    await waitFor(() => started.length === 4);
    expect(maxActive).toBe(4);

    gates.get('job-1')?.resolve();
    gates.get('job-2')?.resolve();
    gates.get('job-3')?.resolve();
    gates.get('job-4')?.resolve();
    await resumePromise;

    expect(adapter.listWorkflowMutationIntents(undefined, ['completed'])).toHaveLength(4);
    expect(maxActive).toBe(4);
  });

  it('does not run two intents for the same workflow concurrently', async () => {
    const adapter = await SQLiteAdapter.create(':memory:');
    adapters.push(adapter);
    adapter.saveWorkflow({ id: 'wf-1',
    name: 'wf-1', createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(), });

    const firstGate = deferred();
    const order: string[] = [];
    let active = 0;
    let maxActive = 0;
    const coordinator = new PersistedWorkflowMutationCoordinator(
      adapter,
      'owner-1',
      async (_channel, args) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        order.push(String(args[0]));
        if (args[0] === 'first') {
          await firstGate.promise;
        }
        active -= 1;
      },
    );

    const first = coordinator.enqueue<void>('wf-1', 'normal', 'mut', ['first']);
    const second = coordinator.enqueue<void>('wf-1', 'normal', 'mut', ['second']);

    await waitFor(() => order.length === 1);
    expect(order).toEqual(['first']);
    expect(maxActive).toBe(1);

    firstGate.resolve();
    await first;
    await second;

    expect(order).toEqual(['first', 'second']);
    expect(maxActive).toBe(1);
  });

  it('invalidates an older running workflow intent when internal delete-workflow is enqueued', async () => {
    const adapter = await SQLiteAdapter.create(':memory:');
    adapters.push(adapter);
    adapter.saveWorkflow({ id: 'wf-1',
    name: 'wf-1', createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(), });

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
    void olderRunning.catch(() => {});
    await waitFor(() => adapter.listWorkflowMutationIntents('wf-1', ['running']).length === 1);

    const deleteWf = coordinator.enqueue<void>(
      'wf-1',
      'high',
      'invoker:delete-workflow',
      ['wf-1'],
    );
    await deleteWf;
    await expect(olderRunning).rejects.toThrow(/superseded by delete intent/i);

    const intents = adapter.listWorkflowMutationIntents('wf-1');
    expect(intents.find((intent) => intent.id === 1)?.status).toBe('failed');
    expect(intents.find((intent) => intent.id === 1)?.error).toContain('Superseded by delete intent #2');
    expect(intents.find((intent) => intent.id === 2)?.status).toBe('completed');
    expect(order).toEqual([
      'invoker:fix-with-agent:wf-1/blocker-task',
      'invoker:delete-workflow:wf-1',
    ]);
  });

  it('evicts older queued workflow intents when internal delete-workflow fence starts', async () => {
    const adapter = await SQLiteAdapter.create(':memory:');
    adapters.push(adapter);
    adapter.saveWorkflow({ id: 'wf-1',
    name: 'wf-1', createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(), });

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
    const deleteWf = coordinator.enqueue<void>('wf-1', 'high', 'invoker:delete-workflow', ['wf-1']);
    const newerQueued = coordinator.enqueue<void>('wf-1', 'normal', 'invoker:edit-task-agent', ['new-queued']);

    await deleteWf;
    await newerQueued;
    await expect(running).rejects.toThrow(/superseded by delete intent/i);
    await expect(olderQueued).rejects.toThrow(/evicted/i);

    expect(order).toEqual([
      'invoker:fix-with-agent:wf-1/blocker-task',
      'invoker:delete-workflow:wf-1',
      'invoker:edit-task-agent:new-queued',
    ]);
  });

  it('reports intents cancelled by a delete fence as task-scoped failures indistinguishable from real errors', async () => {
    const adapter = await SQLiteAdapter.create(':memory:');
    adapters.push(adapter);
    adapter.saveWorkflow({ id: 'wf-1',
    name: 'wf-1', createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(), });

    const gate = deferred();
    const failedEvents: WorkflowMutationFailedEvent[] = [];
    const coordinator = new PersistedWorkflowMutationCoordinator(
      adapter,
      'owner-1',
      async (channel) => {
        if (channel === 'invoker:fix-with-agent') {
          await gate.promise;
        }
      },
      { onIntentFailed: (event) => failedEvents.push(event) },
    );

    const running = coordinator.enqueue<void>('wf-1', 'normal', 'invoker:fix-with-agent', ['wf-1/blocker-task', null]);
    void running.catch(() => {});
    await waitFor(() => adapter.listWorkflowMutationIntents('wf-1', ['running']).length === 1);
    const queued = coordinator.enqueue<void>('wf-1', 'normal', 'invoker:edit-task-agent', ['wf-1/queued-task']);
    void queued.catch(() => {});

    await coordinator.enqueue<void>('wf-1', 'high', 'invoker:delete-workflow', ['wf-1']);
    await expect(running).rejects.toThrow(/superseded by delete intent/i);
    await expect(queued).rejects.toThrow(/evicted/i);

    // Deleting a workflow deliberately cancels its in-flight work, yet every
    // cancellation is announced as a task-scoped failure carrying no marker that
    // separates it from a genuine error. Renderers therefore treat a routine
    // delete as work the user must attend to.
    expect(failedEvents).toHaveLength(2);
    expect(failedEvents.map((event) => event.taskId)).toEqual(['wf-1/blocker-task', 'wf-1/queued-task']);
    expect(failedEvents.map((event) => event.message)).toEqual([
      expect.stringMatching(/superseded by delete intent/i),
      expect.stringMatching(/evicted/i),
    ]);
  });

  it('invalidates an older running workflow intent when delegated headless delete is enqueued', async () => {
    const adapter = await SQLiteAdapter.create(':memory:');
    adapters.push(adapter);
    adapter.saveWorkflow({ id: 'wf-1',
    name: 'wf-1', createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(), });

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

    const deleteExec = coordinator.enqueue<void>(
      'wf-1',
      'high',
      'headless.exec',
      [{ args: ['delete', 'wf-1'] }],
    );
    await deleteExec;
    await expect(olderRunning).rejects.toThrow(/superseded by delete intent/i);

    const intents = adapter.listWorkflowMutationIntents('wf-1');
    expect(intents.find((intent) => intent.id === 1)?.status).toBe('failed');
    expect(intents.find((intent) => intent.id === 1)?.error).toContain('Superseded by delete intent #2');
    expect(intents.find((intent) => intent.id === 2)?.status).toBe('completed');
    expect(order).toEqual([
      'set command wf-1/task-0 hold-work',
      'delete wf-1',
    ]);
  });

  it('evicts older queued workflow intents when delegated headless delete fence starts', async () => {
    const adapter = await SQLiteAdapter.create(':memory:');
    adapters.push(adapter);
    adapter.saveWorkflow({ id: 'wf-1',
    name: 'wf-1', createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(), });

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
    const deleteFence = coordinator.enqueue<void>('wf-1', 'high', 'headless.exec', [{ args: ['delete', 'wf-1'] }]);
    const newerQueued = coordinator.enqueue<void>('wf-1', 'normal', 'headless.exec', [{ args: ['set', 'agent', 'wf-1/task-2', 'claude'] }]);

    await Promise.resolve();
    await deleteFence;
    await newerQueued;
    await expect(running).rejects.toThrow(/superseded by delete intent/i);
    await expect(olderQueued).rejects.toThrow(/evicted/i);

    expect(order).toEqual([
      'set command wf-1/task-0 hold-work',
      'delete wf-1',
      'set agent wf-1/task-2 claude',
    ]);
    const intents = adapter.listWorkflowMutationIntents('wf-1');
    const evictedIntent = intents.find((intent) => Array.isArray(intent.args) && JSON.stringify(intent.args).includes('wf-1/task-1'));
    const invalidatedIntent = intents.find((intent) => intent.id === 1);
    expect(invalidatedIntent?.status).toBe('failed');
    expect(invalidatedIntent?.error).toContain('Superseded by delete intent #3');
    expect(evictedIntent?.status).toBe('failed');
    expect(evictedIntent?.error).toContain('queue fence');
    gate.resolve();
  });

  it('invalidates an older running workflow intent when internal delete-all-workflows is enqueued', async () => {
    const adapter = await SQLiteAdapter.create(':memory:');
    adapters.push(adapter);
    adapter.saveWorkflow({ id: 'wf-1',
    name: 'wf-1', createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(), });

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
    void olderRunning.catch(() => {});
    await waitFor(() => adapter.listWorkflowMutationIntents('wf-1', ['running']).length === 1);

    const deleteAll = coordinator.enqueue<void>(
      'wf-1',
      'high',
      'invoker:delete-all-workflows',
      [],
    );
    await deleteAll;
    await expect(olderRunning).rejects.toThrow(/superseded by delete intent/i);

    const intents = adapter.listWorkflowMutationIntents('wf-1');
    expect(intents.find((intent) => intent.id === 1)?.status).toBe('failed');
    expect(intents.find((intent) => intent.id === 1)?.error).toContain('Superseded by delete intent #2');
    expect(intents.find((intent) => intent.id === 2)?.status).toBe('completed');
    expect(order).toEqual([
      'invoker:fix-with-agent:wf-1/blocker-task',
      'invoker:delete-all-workflows:undefined',
    ]);
  });

  it('evicts older queued workflow intents when internal delete-all-workflows fence starts', async () => {
    const adapter = await SQLiteAdapter.create(':memory:');
    adapters.push(adapter);
    adapter.saveWorkflow({ id: 'wf-1',
    name: 'wf-1', createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(), });

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
    const deleteAll = coordinator.enqueue<void>('wf-1', 'high', 'invoker:delete-all-workflows', []);
    const newerQueued = coordinator.enqueue<void>('wf-1', 'normal', 'invoker:edit-task-agent', ['new-queued']);

    await deleteAll;
    await newerQueued;
    await expect(running).rejects.toThrow(/superseded by delete intent/i);
    await expect(olderQueued).rejects.toThrow(/evicted/i);

    expect(order).toEqual([
      'invoker:fix-with-agent:wf-1/blocker-task',
      'invoker:delete-all-workflows:undefined',
      'invoker:edit-task-agent:new-queued',
    ]);
  });

  it('invalidates an older running workflow intent when delegated headless delete-all is enqueued', async () => {
    const adapter = await SQLiteAdapter.create(':memory:');
    adapters.push(adapter);
    adapter.saveWorkflow({ id: 'wf-1',
    name: 'wf-1', createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(), });

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

    const deleteAllExec = coordinator.enqueue<void>(
      'wf-1',
      'high',
      'headless.exec',
      [{ args: ['delete-all'] }],
    );
    await deleteAllExec;
    await expect(olderRunning).rejects.toThrow(/superseded by delete intent/i);

    const intents = adapter.listWorkflowMutationIntents('wf-1');
    expect(intents.find((intent) => intent.id === 1)?.status).toBe('failed');
    expect(intents.find((intent) => intent.id === 1)?.error).toContain('Superseded by delete intent #2');
    expect(intents.find((intent) => intent.id === 2)?.status).toBe('completed');
    expect(order).toEqual([
      'set command wf-1/task-0 hold-work',
      'delete-all',
    ]);
  });

  it('evicts older queued workflow intents when delegated headless delete-all fence starts', async () => {
    const adapter = await SQLiteAdapter.create(':memory:');
    adapters.push(adapter);
    adapter.saveWorkflow({ id: 'wf-1',
    name: 'wf-1', createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(), });

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
    const deleteAllFence = coordinator.enqueue<void>('wf-1', 'high', 'headless.exec', [{ args: ['delete-all'] }]);
    const newerQueued = coordinator.enqueue<void>('wf-1', 'normal', 'headless.exec', [{ args: ['set', 'agent', 'wf-1/task-2', 'claude'] }]);

    await Promise.resolve();
    await deleteAllFence;
    await newerQueued;
    await expect(running).rejects.toThrow(/superseded by delete intent/i);
    await expect(olderQueued).rejects.toThrow(/evicted/i);

    expect(order).toEqual([
      'set command wf-1/task-0 hold-work',
      'delete-all',
      'set agent wf-1/task-2 claude',
    ]);
    const intents = adapter.listWorkflowMutationIntents('wf-1');
    const evictedIntent = intents.find((intent) => Array.isArray(intent.args) && JSON.stringify(intent.args).includes('wf-1/task-1'));
    const invalidatedIntent = intents.find((intent) => intent.id === 1);
    expect(invalidatedIntent?.status).toBe('failed');
    expect(invalidatedIntent?.error).toContain('Superseded by delete intent #3');
    expect(evictedIntent?.status).toBe('failed');
    expect(evictedIntent?.error).toContain('queue fence');
    gate.resolve();
  });

  // ── Bulk delete-all-workflows coordinator regression ────────────────

  it('invalidates an older running workflow intent when internal bulk delete-all-workflows is enqueued', async () => {
    const adapter = await SQLiteAdapter.create(':memory:');
    adapters.push(adapter);
    adapter.saveWorkflow({ id: 'wf-1',
    name: 'wf-1', createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(), });

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
    void olderRunning.catch(() => {});
    await waitFor(() => adapter.listWorkflowMutationIntents('wf-1', ['running']).length === 1);

    const deleteAllBulk = coordinator.enqueue<void>(
      'wf-1',
      'high',
      'invoker:delete-all-workflows-bulk',
      [],
    );
    await deleteAllBulk;
    await expect(olderRunning).rejects.toThrow(/superseded by delete intent/i);

    const intents = adapter.listWorkflowMutationIntents('wf-1');
    expect(intents.find((intent) => intent.id === 1)?.status).toBe('failed');
    expect(intents.find((intent) => intent.id === 1)?.error).toContain('Superseded by delete intent #2');
    expect(intents.find((intent) => intent.id === 2)?.status).toBe('completed');
    expect(order).toEqual([
      'invoker:fix-with-agent:wf-1/blocker-task',
      'invoker:delete-all-workflows-bulk:undefined',
    ]);
  });

  it('evicts older queued workflow intents when internal bulk delete-all-workflows fence starts', async () => {
    const adapter = await SQLiteAdapter.create(':memory:');
    adapters.push(adapter);
    adapter.saveWorkflow({ id: 'wf-1',
    name: 'wf-1', createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(), });

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
    const deleteAllBulk = coordinator.enqueue<void>('wf-1', 'high', 'invoker:delete-all-workflows-bulk', []);
    const newerQueued = coordinator.enqueue<void>('wf-1', 'normal', 'invoker:edit-task-agent', ['new-queued']);

    await deleteAllBulk;
    await newerQueued;
    await expect(running).rejects.toThrow(/superseded by delete intent/i);
    await expect(olderQueued).rejects.toThrow(/evicted/i);

    expect(order).toEqual([
      'invoker:fix-with-agent:wf-1/blocker-task',
      'invoker:delete-all-workflows-bulk:undefined',
      'invoker:edit-task-agent:new-queued',
    ]);
  });

  // ── Cancellation-aware AbortSignal tests ─────────────────────────────

  it('aborts the dispatch AbortSignal when recreate-task preempts a running fix mutation', async () => {
    const adapter = await SQLiteAdapter.create(':memory:');
    adapters.push(adapter);
    adapter.saveWorkflow({ id: 'wf-1',
    name: 'wf-1', createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(), });

    const gate = deferred();
    let capturedContext: WorkflowMutationContext | undefined;
    const coordinator = new PersistedWorkflowMutationCoordinator(
      adapter,
      'owner-1',
      async (channel, _args, context) => {
        if (channel === 'invoker:fix-with-agent') {
          capturedContext = context;
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
    void olderRunning.catch(() => {});
    await waitFor(() => capturedContext !== undefined);

    expect(capturedContext).toBeDefined();
    expect(capturedContext!.signal.aborted).toBe(false);
    expect(capturedContext!.workflowId).toBe('wf-1');
    expect(capturedContext!.intentId).toBe(1);

    const recreateTask = coordinator.enqueue<void>(
      'wf-1',
      'high',
      'invoker:recreate-task',
      ['wf-1/target-task'],
    );
    await recreateTask;

    expect(capturedContext!.signal.aborted).toBe(true);
    await expect(olderRunning).rejects.toThrow(/superseded by recreate intent/i);
  });

  it('aborts the dispatch AbortSignal when delete-workflow preempts a running fix mutation', async () => {
    const adapter = await SQLiteAdapter.create(':memory:');
    adapters.push(adapter);
    adapter.saveWorkflow({ id: 'wf-1',
    name: 'wf-1', createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(), });

    const gate = deferred();
    let capturedContext: WorkflowMutationContext | undefined;
    const coordinator = new PersistedWorkflowMutationCoordinator(
      adapter,
      'owner-1',
      async (channel, _args, context) => {
        if (channel === 'invoker:fix-with-agent') {
          capturedContext = context;
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
    void olderRunning.catch(() => {});
    await waitFor(() => capturedContext !== undefined);

    expect(capturedContext!.signal.aborted).toBe(false);

    const deleteWf = coordinator.enqueue<void>(
      'wf-1',
      'high',
      'invoker:delete-workflow',
      ['wf-1'],
    );
    await deleteWf;

    expect(capturedContext!.signal.aborted).toBe(true);
    await expect(olderRunning).rejects.toThrow(/superseded by delete intent/i);
  });

  it('aborts the dispatch AbortSignal when rebase-recreate preempts a running fix mutation', async () => {
    const adapter = await SQLiteAdapter.create(':memory:');
    adapters.push(adapter);
    adapter.saveWorkflow({ id: 'wf-1',
    name: 'wf-1', createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(), });

    const gate = deferred();
    let capturedContext: WorkflowMutationContext | undefined;
    const coordinator = new PersistedWorkflowMutationCoordinator(
      adapter,
      'owner-1',
      async (channel, _args, context) => {
        if (channel === 'invoker:fix-with-agent') {
          capturedContext = context;
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
    void olderRunning.catch(() => {});
    await waitFor(() => capturedContext !== undefined);

    expect(capturedContext!.signal.aborted).toBe(false);

    const recreateRebase = coordinator.enqueue<void>(
      'wf-1',
      'high',
      'invoker:rebase-recreate',
      ['wf-1'],
    );
    await recreateRebase;

    expect(capturedContext!.signal.aborted).toBe(true);
    await expect(olderRunning).rejects.toThrow(/superseded by recreate intent/i);
  });

  it('does not abort the dispatch AbortSignal for non-preempted mutations that complete normally', async () => {
    const adapter = await SQLiteAdapter.create(':memory:');
    adapters.push(adapter);
    adapter.saveWorkflow({ id: 'wf-1',
    name: 'wf-1', createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(), });

    let signalAbortedDuringDispatch = false;
    const coordinator = new PersistedWorkflowMutationCoordinator(
      adapter,
      'owner-1',
      async (_channel, _args, context) => {
        signalAbortedDuringDispatch = context.signal.aborted;
      },
    );

    await coordinator.enqueue<void>(
      'wf-1',
      'normal',
      'invoker:fix-with-agent',
      ['wf-1/task', null],
    );

    expect(signalAbortedDuringDispatch).toBe(false);
    const intents = adapter.listWorkflowMutationIntents('wf-1');
    expect(intents[0]?.status).toBe('completed');
  });

  it('abort signal reason is a WorkflowMutationInvalidatedError when preempted', async () => {
    const adapter = await SQLiteAdapter.create(':memory:');
    adapters.push(adapter);
    adapter.saveWorkflow({ id: 'wf-1',
    name: 'wf-1', createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(), });

    const gate = deferred();
    let capturedContext: WorkflowMutationContext | undefined;
    const coordinator = new PersistedWorkflowMutationCoordinator(
      adapter,
      'owner-1',
      async (channel, _args, context) => {
        if (channel === 'invoker:fix-with-agent') {
          capturedContext = context;
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
    void olderRunning.catch(() => {});
    await waitFor(() => capturedContext !== undefined);

    coordinator.enqueue<void>(
      'wf-1',
      'high',
      'invoker:delete-all-workflows-bulk',
      [],
    );

    await waitFor(() => capturedContext!.signal.aborted);
    const reason = capturedContext!.signal.reason;
    expect(reason).toBeInstanceOf(Error);
    expect((reason as Error).name).toBe('WorkflowMutationInvalidatedError');
    expect((reason as Error).message).toContain('Superseded by delete');
  });

  it('dispatch handler can observe abort during long-running work and stop early', async () => {
    const adapter = await SQLiteAdapter.create(':memory:');
    adapters.push(adapter);
    adapter.saveWorkflow({ id: 'wf-1',
    name: 'wf-1', createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(), });

    let iterationsBeforeAbort = 0;
    const gate = deferred();
    const coordinator = new PersistedWorkflowMutationCoordinator(
      adapter,
      'owner-1',
      async (channel, _args, context) => {
        if (channel === 'invoker:fix-with-agent') {
          // Simulate long-running work that checks signal
          while (!context.signal.aborted) {
            iterationsBeforeAbort += 1;
            await new Promise((r) => setTimeout(r, 0));
          }
          gate.resolve();
        }
      },
    );

    const olderRunning = coordinator.enqueue<void>(
      'wf-1',
      'normal',
      'invoker:fix-with-agent',
      ['wf-1/blocker-task', null],
    );
    void olderRunning.catch(() => {});
    await waitFor(() => iterationsBeforeAbort > 0);

    const recreateTask = coordinator.enqueue<void>(
      'wf-1',
      'high',
      'invoker:recreate-task',
      ['wf-1/target-task'],
    );
    await gate.promise;
    await recreateTask;

    expect(iterationsBeforeAbort).toBeGreaterThan(0);
    await expect(olderRunning).rejects.toThrow(/superseded by recreate intent/i);
  });

  it('invokes onIntentFailed with intent metadata when the async handler throws', async () => {
    const adapter = await SQLiteAdapter.create(':memory:');
    adapters.push(adapter);
    adapter.saveWorkflow({
      id: 'wf-1',
      name: 'wf-1',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const failureEvents: Array<{
      intentId: number;
      workflowId: string;
      channel: string;
      taskId?: string;
      message: string;
      failedAt: string;
    }> = [];
    const coordinator = new PersistedWorkflowMutationCoordinator(
      adapter,
      'owner-1',
      async () => {
        throw new Error('SSH target "remote_digital_ocean_3" cannot run codex');
      },
      {
        onIntentFailed: (event) => {
          failureEvents.push(event);
        },
      },
    );

    const attempt = coordinator.enqueue<void>('wf-1', 'normal', 'invoker:approve', ['wf-1/task-alpha']);
    await expect(attempt).rejects.toThrow(/cannot run codex/);

    expect(failureEvents).toHaveLength(1);
    const [event] = failureEvents;
    expect(event.workflowId).toBe('wf-1');
    expect(event.channel).toBe('invoker:approve');
    expect(event.taskId).toBe('wf-1/task-alpha');
    expect(event.intentId).toBeGreaterThan(0);
    expect(event.message).toMatch(/cannot run codex/);
    expect(typeof event.failedAt).toBe('string');
    expect(Number.isFinite(Date.parse(event.failedAt))).toBe(true);
  });

  it('emits headless.exec task metadata and banner-safe messages without stack traces', async () => {
    const adapter = await SQLiteAdapter.create(':memory:');
    adapters.push(adapter);
    adapter.saveWorkflow({
      id: 'wf-1',
      name: 'wf-1',
      status: 'running',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    adapter.saveTask('wf-1', makeTask('wf-1/task-alpha'));

    const failureEvents: Array<{
      taskId?: string;
      headlessCommand?: string;
      message: string;
    }> = [];
    const coordinator = new PersistedWorkflowMutationCoordinator(
      adapter,
      'owner-1',
      async () => {
        const err = new Error('SSH remote script failed (exit=1, phase=remote_agent_fix)\nSTDOUT:\n{"type":"error"}');
        err.stack = `${err.message}\n    at createSshRemoteScriptError (/tmp/main.js:1:1)`;
        throw err;
      },
      {
        onIntentFailed: (event) => {
          failureEvents.push(event);
        },
      },
    );

    const attempt = coordinator.enqueue<void>('wf-1', 'normal', 'headless.exec', [{
      args: ['fix', 'wf-1/task-alpha', 'codex'],
      noTrack: true,
    }]);
    await expect(attempt).rejects.toThrow(/SSH remote script failed/);

    expect(failureEvents).toHaveLength(1);
    const [event] = failureEvents;
    expect(event.taskId).toBe('wf-1/task-alpha');
    expect(event.headlessCommand).toBe('fix');
    expect(event.message).toContain('SSH remote script failed');
    expect(event.message).not.toContain('createSshRemoteScriptError');
  });

  it('leaves onIntentFailed out of the successful-completion path', async () => {
    const adapter = await SQLiteAdapter.create(':memory:');
    adapters.push(adapter);
    adapter.saveWorkflow({
      id: 'wf-1',
      name: 'wf-1',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const failureEvents: unknown[] = [];
    const coordinator = new PersistedWorkflowMutationCoordinator(
      adapter,
      'owner-1',
      async () => 'ok',
      {
        onIntentFailed: (event) => {
          failureEvents.push(event);
        },
      },
    );

    await coordinator.enqueue<string>('wf-1', 'normal', 'invoker:approve', ['wf-1/task-alpha']);
    expect(failureEvents).toEqual([]);
  });
});
