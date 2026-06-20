import { describe, expect, it, vi } from 'vitest';
import { resolveRefreshTaskGraphSnapshot } from '../refresh-task-graph.js';

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

describe('resolveRefreshTaskGraphSnapshot', () => {
  it('returns the delegated snapshot when the owner responds', async () => {
    const delegatedTask = makeTask('wf-1/task-1');
    const localTask = makeTask('wf-1/task-local');
    const syncAllFromDb = vi.fn();
    const getAllTasks = vi.fn(() => [localTask]);
    const listWorkflows = vi.fn(() => [{ id: 'wf-local', name: 'Local', status: 'pending' }]);
    const request = vi.fn(async () => ({
      tasks: [delegatedTask],
      workflows: [{ id: 'wf-1', name: 'Delegated', status: 'running' }],
      invokerHomeRoot: '/tmp/invoker-a',
    }));
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };

    const result = await resolveRefreshTaskGraphSnapshot({
      ownerMode: false,
      messageBus: { request } as never,
      localInvokerHomeRoot: '/tmp/invoker-a',
      logger: logger as never,
      orchestrator: { syncAllFromDb, getAllTasks } as never,
      persistence: { listWorkflows } as never,
    });

    expect(result).toEqual({
      tasks: [delegatedTask],
      workflows: [{ id: 'wf-1', name: 'Delegated', status: 'running' }],
      delegated: true,
    });
    expect(syncAllFromDb).not.toHaveBeenCalled();
    expect(getAllTasks).not.toHaveBeenCalled();
    expect(listWorkflows).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('falls back to the local snapshot when owner delegation disappears', async () => {
    const localTask = makeTask('wf-2/task-1');
    const syncAllFromDb = vi.fn();
    const getAllTasks = vi.fn(() => [localTask]);
    const listWorkflows = vi.fn(() => [{ id: 'wf-2', name: 'Local', status: 'failed' }]);
    const request = vi.fn(async () => {
      throw new Error('No request handler registered for channel: headless.query');
    });
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };

    const result = await resolveRefreshTaskGraphSnapshot({
      ownerMode: false,
      messageBus: { request } as never,
      localInvokerHomeRoot: '/tmp/invoker-b',
      logger: logger as never,
      orchestrator: { syncAllFromDb, getAllTasks } as never,
      persistence: { listWorkflows } as never,
    });

    expect(result).toEqual({
      tasks: [localTask],
      workflows: [{ id: 'wf-2', name: 'Local', status: 'failed' }],
      delegated: false,
    });
    expect(syncAllFromDb).toHaveBeenCalledTimes(1);
    expect(getAllTasks).toHaveBeenCalledTimes(1);
    expect(listWorkflows).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('refresh-task-graph owner delegation failed; falling back to local read-only snapshot'),
      { module: 'ipc' },
    );
  });

  it('falls back to the local snapshot when the owner home does not match', async () => {
    const localTask = makeTask('wf-3/task-1');
    const syncAllFromDb = vi.fn();
    const getAllTasks = vi.fn(() => [localTask]);
    const listWorkflows = vi.fn(() => [{ id: 'wf-3', name: 'Local', status: 'running' }]);
    const request = vi.fn(async () => ({
      tasks: [makeTask('wf-remote/task-1')],
      workflows: [{ id: 'wf-remote', name: 'Remote', status: 'running' }],
      invokerHomeRoot: '/tmp/invoker-remote',
    }));
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };

    const result = await resolveRefreshTaskGraphSnapshot({
      ownerMode: false,
      messageBus: { request } as never,
      localInvokerHomeRoot: '/tmp/invoker-local',
      logger: logger as never,
      orchestrator: { syncAllFromDb, getAllTasks } as never,
      persistence: { listWorkflows } as never,
    });

    expect(result).toEqual({
      tasks: [localTask],
      workflows: [{ id: 'wf-3', name: 'Local', status: 'running' }],
      delegated: false,
    });
    expect(syncAllFromDb).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('owner home mismatch: owner=/tmp/invoker-remote local=/tmp/invoker-local'),
      { module: 'ipc' },
    );
  });
});
