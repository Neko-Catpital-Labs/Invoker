import { describe, expect, it, vi } from 'vitest';
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
});
