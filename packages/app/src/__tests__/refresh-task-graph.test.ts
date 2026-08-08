import { describe, expect, it, vi } from 'vitest';
import {
  publishForcedRefreshTaskGraphSnapshot,
  resolveRefreshTaskGraphSnapshot,
} from '../refresh-task-graph.js';

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

function makeLogger() {
  const warnings: Array<{ message: string; meta: unknown }> = [];
  return {
    logger: {
      info() {},
      warn(message: string, meta: unknown) {
        warnings.push({ message, meta });
      },
      error() {},
      debug() {},
    },
    warnings,
  };
}

describe('publishForcedRefreshTaskGraphSnapshot', () => {
  it('always publishes the refresh snapshot as forced', () => {
    const publisher = {
      publishSnapshot: vi.fn(),
    };
    const task = makeTask('wf-1/task-1');
    const workflow = { id: 'wf-1', name: 'Workflow 1', status: 'running' };

    publishForcedRefreshTaskGraphSnapshot(publisher, 'refresh-task-graph', {
      tasks: [task],
      workflows: [workflow],
      streamSequence: 5,
    });

    expect(publisher.publishSnapshot).toHaveBeenCalledWith(
      'refresh-task-graph',
      [task],
      [workflow],
      5,
      true,
    );
  });
});

describe('resolveRefreshTaskGraphSnapshot fallback', () => {
  it('falls back to the local snapshot when owner delegation disappears', async () => {
    const localTask = makeTask('wf-2/task-1');
    const localWorkflow = { id: 'wf-2', name: 'Local', status: 'failed' };
    const calls = { sync: 0, tasks: 0, workflows: 0 };
    const { logger, warnings } = makeLogger();

    const result = await resolveRefreshTaskGraphSnapshot({
      ownerMode: false,
      messageBus: {
        async request() {
          throw new Error('No request handler registered for channel: headless.query');
        },
      } as never,
      resolveInvokerHomeRoot: () => '/tmp/invoker-b',
      logger: logger as never,
      orchestrator: {
        syncAllFromDb() {
          calls.sync += 1;
        },
        getAllTasks() {
          calls.tasks += 1;
          return [localTask];
        },
      } as never,
      persistence: {
        listWorkflows() {
          calls.workflows += 1;
          return [localWorkflow];
        },
      } as never,
      getStreamSequence: () => 9,
    });

    expect(result).toEqual({ tasks: [localTask], workflows: [localWorkflow], streamSequence: 9 });
    expect(calls).toEqual({ sync: 1, tasks: 1, workflows: 1 });
    expect(warnings).toEqual([
      {
        message: expect.stringContaining('refresh-task-graph owner delegation failed; falling back to local read-only snapshot'),
        meta: { module: 'ipc' },
      },
    ]);
  });

  it('falls back to the local snapshot when the owner home does not match', async () => {
    const localTask = makeTask('wf-3/task-1');
    const localWorkflow = { id: 'wf-3', name: 'Local', status: 'running' };
    const calls = { sync: 0 };
    const { logger, warnings } = makeLogger();

    const result = await resolveRefreshTaskGraphSnapshot({
      ownerMode: false,
      messageBus: {
        async request() {
          return {
            tasks: [makeTask('wf-remote/task-1')],
            workflows: [{ id: 'wf-remote', name: 'Remote', status: 'running' }],
            streamSequence: 1,
            invokerHomeRoot: '/tmp/invoker-remote',
          };
        },
      } as never,
      resolveInvokerHomeRoot: () => '/tmp/invoker-local',
      logger: logger as never,
      orchestrator: {
        syncAllFromDb() {
          calls.sync += 1;
        },
        getAllTasks() {
          return [localTask];
        },
      } as never,
      persistence: {
        listWorkflows() {
          return [localWorkflow];
        },
      } as never,
      getStreamSequence: () => 9,
    });

    expect(result).toEqual({ tasks: [localTask], workflows: [localWorkflow], streamSequence: 9 });
    expect(calls.sync).toBe(1);
    expect(warnings[0]).toEqual({
      message: expect.stringContaining('owner home mismatch: owner=/tmp/invoker-remote local=/tmp/invoker-local'),
      meta: { module: 'ipc' },
    });
  });

  it('captures streamSequence via getStreamSequence at the same synchronous read as tasks/workflows', async () => {
    const localTask = makeTask('wf-4/task-1');
    const localWorkflow = { id: 'wf-4', name: 'Local', status: 'running' };
    const { logger } = makeLogger();

    const result = await resolveRefreshTaskGraphSnapshot({
      ownerMode: true,
      messageBus: { async request() { throw new Error('unused in owner mode'); } } as never,
      resolveInvokerHomeRoot: () => '/tmp/invoker-owner',
      logger: logger as never,
      orchestrator: {
        syncAllFromDb() {},
        getAllTasks() {
          return [localTask];
        },
      } as never,
      persistence: {
        listWorkflows() {
          return [localWorkflow];
        },
      } as never,
      getStreamSequence: () => 42,
    });

    expect(result).toEqual({ tasks: [localTask], workflows: [localWorkflow], streamSequence: 42 });
  });
});
