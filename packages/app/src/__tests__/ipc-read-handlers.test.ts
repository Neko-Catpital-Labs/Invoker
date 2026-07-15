import { describe, expect, it, vi } from 'vitest';
import type { RegisterReadOnlyIpcHandlersContext } from '../ipc-read-handlers.js';
import { registerReadOnlyIpcHandlers } from '../ipc-read-handlers.js';

function makeTask(id: string) {
  return {
    id,
    description: id,
    status: 'pending',
    dependencies: [],
    createdAt: new Date('2026-01-01'),
    config: {},
    execution: {},
  };
}

function expectReadContextWriteToolsAreAbsent(): void {
  const exposesTaskDeltaPublisher: 'sendTaskDeltaToRenderer' extends keyof RegisterReadOnlyIpcHandlersContext ? true : false = false;
  const exposesMainWindow: 'getMainWindow' extends keyof RegisterReadOnlyIpcHandlersContext ? true : false = false;
  const exposesTaskSnapshotCache: 'lastKnownTaskStates' extends keyof RegisterReadOnlyIpcHandlersContext ? true : false = false;

  expect(exposesTaskDeltaPublisher).toBe(false);
  expect(exposesMainWindow).toBe(false);
  expect(exposesTaskSnapshotCache).toBe(false);
}


describe('registerReadOnlyIpcHandlers', () => {
  it('get-tasks returns a snapshot', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const ipcMain = {
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, handler);
      }),
    };
    const task = makeTask('wf-1/task-1');

    registerReadOnlyIpcHandlers({
      ipcMain: ipcMain as never,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      } as never,
      persistence: {
        listWorkflows: vi.fn(() => [{ id: 'wf-1', name: 'Workflow 1', status: 'pending' }]),
      } as never,
      getOrchestrator: () => ({
        getAllTasks: () => [task],
        getWorkflowStatus: () => ({ total: 1, completed: 0, failed: 0, closed: 0, running: 0, pending: 1 }),
      }) as never,
      agentRegistry: {} as never,
      loadTaskByIdFromPersistence: () => undefined,
      resolveAgentSession: vi.fn(async () => null),
      getOwnerMode: () => true,
      getMessageBus: () => ({ request: vi.fn() }),
      recordStartupDuration: vi.fn(),
      getTaskDeltaStreamSequence: () => 42,
    });

    const result = await handlers.get('invoker:get-tasks')?.({});

    expect(result).toEqual({
      tasks: [task],
      workflows: [{ id: 'wf-1', name: 'Workflow 1', status: 'pending' }],
      streamSequence: 42,
    });
  });

  it('get-review-gate returns the shared review gate shape', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const ipcMain = {
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, handler);
      }),
    };
    const mergeTask = {
      ...makeTask('__merge__wf-1'),
      status: 'review_ready',
      config: { workflowId: 'wf-1', isMergeNode: true },
      execution: {
        reviewGate: {
          activeGeneration: 0,
          completion: { required: 'all', status: 'approved' },
          artifacts: [
            { id: 'contracts', required: true, status: 'approved', generation: 0 },
            { id: 'runtime', required: true, status: 'open', generation: 0, dependsOn: ['contracts'] },
            { id: 'ui', required: true, status: 'open', generation: 0, dependsOn: ['runtime'] },
          ],
        },
      },
    };

    registerReadOnlyIpcHandlers({
      ipcMain: ipcMain as never,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
      persistence: {
        listWorkflows: vi.fn(() => []),
        loadWorkflow: vi.fn(() => ({ id: 'wf-1' })),
        loadTasks: vi.fn(() => [mergeTask]),
      } as never,
      getOrchestrator: () => ({ getAllTasks: () => [mergeTask], getWorkflowStatus: () => ({}) }) as never,
      agentRegistry: {} as never,
      loadTaskByIdFromPersistence: () => undefined,
      resolveAgentSession: vi.fn(async () => null),
      recordStartupDuration: vi.fn(),
      getTaskDeltaStreamSequence: () => 1,
    });

    const result = await handlers.get('invoker:get-review-gate')?.({}, 'wf-1');

    expect(result).toMatchObject({
      workflowId: 'wf-1',
      mergeTaskId: '__merge__wf-1',
      edges: [
        { from: 'contracts', to: 'runtime' },
        { from: 'runtime', to: 'ui' },
      ],
      ready: false,
      substate: 'review_open',
    });
  });

  it('get-worker-action-history returns paged action summaries', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const ipcMain = {
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, handler);
      }),
    };
    const listWorkerActions = vi.fn(() => [
      {
        id: 'wa-1',
        workerKind: 'autofix',
        actionType: 'repair',
        subjectType: 'task',
        subjectId: 'wf-1/task-1',
        externalKey: 'key-1',
        status: 'completed',
        attemptCount: 1,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:02.000Z',
      },
      {
        id: 'wa-2',
        workerKind: 'autofix',
        actionType: 'repair',
        subjectType: 'task',
        subjectId: 'wf-1/task-2',
        externalKey: 'key-2',
        status: 'failed',
        attemptCount: 1,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:01.000Z',
      },
    ]);

    registerReadOnlyIpcHandlers({
      ipcMain: ipcMain as never,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
      persistence: { listWorkerActions } as never,
      getOrchestrator: () => ({}) as never,
      agentRegistry: {} as never,
      loadTaskByIdFromPersistence: () => undefined,
      resolveAgentSession: vi.fn(async () => null),
      recordStartupDuration: vi.fn(),
      getTaskDeltaStreamSequence: () => 1,
    });

    await expect(handlers.get('invoker:get-worker-action-history')?.({}, { workerKind: 'autofix', limit: 1, offset: 3 })).resolves.toMatchObject({
      workerKind: 'autofix',
      actions: [{ id: 'wa-1' }],
      limit: 1,
      offset: 3,
      hasMore: true,
      nextOffset: 4,
    });
    expect(listWorkerActions).toHaveBeenCalledWith({ workerKind: 'autofix', limit: 2, offset: 3 });
  });
  it('get-history-tasks returns persistence history rows in owner mode', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const ipcMain = {
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, handler);
      }),
    };
    const historyRows = [
      {
        id: 't1',
        description: 'History task',
        status: 'completed',
        workflowName: 'Plan A',
        lastEventAt: '2026-07-01T00:00:00Z',
        eventCount: 3,
      },
    ];
    const loadAllHistoryTasks = vi.fn(() => historyRows);

    registerReadOnlyIpcHandlers({
      ipcMain: ipcMain as never,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
      persistence: { loadAllHistoryTasks } as never,
      getOrchestrator: () => ({}) as never,
      agentRegistry: {} as never,
      loadTaskByIdFromPersistence: () => undefined,
      resolveAgentSession: vi.fn(async () => null),
      getOwnerMode: () => true,
      getMessageBus: () => ({ request: vi.fn() }),
      recordStartupDuration: vi.fn(),
      getTaskDeltaStreamSequence: () => 1,
    });

    await expect(handlers.get('invoker:get-history-tasks')?.({})).resolves.toEqual(historyRows);
    expect(loadAllHistoryTasks).toHaveBeenCalledTimes(1);
  });

  it('get-history-tasks falls back to local persistence when owner has no handler', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const ipcMain = {
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, handler);
      }),
    };
    const historyRows = [{ id: 'local-hist', workflowName: 'Local', lastEventAt: null, eventCount: 0 }];
    registerReadOnlyIpcHandlers({
      ipcMain: ipcMain as never,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
      persistence: { loadAllHistoryTasks: vi.fn(() => historyRows) } as never,
      getOrchestrator: () => ({}) as never,
      agentRegistry: {} as never,
      loadTaskByIdFromPersistence: () => undefined,
      resolveAgentSession: vi.fn(async () => null),
      getOwnerMode: () => false,
      getMessageBus: () => ({
        request: vi.fn(() =>
          Promise.reject(Object.assign(new Error('No request handler registered for channel: headless.query'), { code: 'NO_HANDLER' })),
        ),
      }),
      recordStartupDuration: vi.fn(),
      getTaskDeltaStreamSequence: () => 0,
    });

    await expect(handlers.get('invoker:get-history-tasks')?.({})).resolves.toEqual(historyRows);
  });

  it('does not expose renderer write tools to read handlers', () => {
    expectReadContextWriteToolsAreAbsent();
  });

  function registerViewer(requestImpl: () => Promise<unknown>) {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const ipcMain = {
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, handler);
      }),
    };
    registerReadOnlyIpcHandlers({
      ipcMain: ipcMain as never,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
      persistence: { listWorkflows: vi.fn(() => [{ id: 'LOCAL-FALLBACK' }]) } as never,
      getOrchestrator: () => ({}) as never,
      agentRegistry: {} as never,
      loadTaskByIdFromPersistence: () => undefined,
      resolveAgentSession: vi.fn(async () => null),
      getOwnerMode: () => false, // viewer mode → delegates to owner
      getMessageBus: () => ({ request: vi.fn(requestImpl) }),
      recordStartupDuration: vi.fn(),
      getTaskDeltaStreamSequence: () => 0,
    });
    return handlers;
  }

  it('rethrows owner errors instead of silently serving local data (timeout)', async () => {
    const handlers = registerViewer(() =>
      Promise.reject(Object.assign(new Error('owner timed out'), { code: 'REQUEST_TIMEOUT' })));
    await expect(handlers.get('invoker:list-workflows')?.({})).rejects.toThrow(/owner timed out/);
  });

  it('falls back to local only when the owner has no handler', async () => {
    const handlers = registerViewer(() =>
      Promise.reject(Object.assign(new Error('No request handler registered for channel: headless.query'), { code: 'NO_HANDLER' })));
    await expect(handlers.get('invoker:list-workflows')?.({})).resolves.toEqual([{ id: 'LOCAL-FALLBACK' }]);
  });

  it('notifies when owner query delegation finds no mutation owner', async () => {
    const onMutationOwnerUnavailable = vi.fn();
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const ipcMain = {
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, handler);
      }),
    };
    registerReadOnlyIpcHandlers({
      ipcMain: ipcMain as never,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
      persistence: { listWorkflows: vi.fn(() => [{ id: 'LOCAL-FALLBACK' }]) } as never,
      getOrchestrator: () => ({}) as never,
      agentRegistry: {} as never,
      loadTaskByIdFromPersistence: () => undefined,
      resolveAgentSession: vi.fn(async () => null),
      getOwnerMode: () => false,
      getMessageBus: () => ({
        request: vi.fn(async () => {
          throw Object.assign(new Error('No request handler registered for channel: headless.query'), { code: 'NO_HANDLER' });
        }),
      }),
      onMutationOwnerUnavailable,
      recordStartupDuration: vi.fn(),
      getTaskDeltaStreamSequence: () => 0,
    });

    await expect(handlers.get('invoker:list-workflows')?.({})).resolves.toEqual([{ id: 'LOCAL-FALLBACK' }]);
    expect(onMutationOwnerUnavailable).toHaveBeenCalledWith(
      'No request handler registered for channel: headless.query',
    );
  });

});
