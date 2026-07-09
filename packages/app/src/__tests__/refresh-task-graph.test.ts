import { describe, expect, it } from 'vitest';
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
    });

    expect(result).toEqual({ tasks: [localTask], workflows: [localWorkflow] });
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
    });

    expect(result).toEqual({ tasks: [localTask], workflows: [localWorkflow] });
    expect(calls.sync).toBe(1);
    expect(warnings[0]).toEqual({
      message: expect.stringContaining('owner home mismatch: owner=/tmp/invoker-remote local=/tmp/invoker-local'),
      meta: { module: 'ipc' },
    });
  });
});
