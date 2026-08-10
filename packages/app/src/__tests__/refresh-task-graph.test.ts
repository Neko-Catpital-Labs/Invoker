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

  it.fails('uses the caller\'s own local streamSequence on a successful delegated read, not the remote reply\'s', async () => {
    // PROOF for a live infinite-resync-loop incident: streamSequence is a
    // per-caller delivery count (how many deltas THIS process has locally
    // stamped and forwarded to its own renderer). The remote owner cannot
    // know that count -- especially a headless standalone owner, whose own
    // "streamSequence" is a hardcoded 0 stub (main.ts, `getStreamSequence: () => 0`
    // for the standalone `headless.query` handler) because it has no
    // renderer of its own. Today, resolveRefreshTaskGraphSnapshot trusts the
    // remote reply's streamSequence on a successful delegated read, handing
    // callers a number from a different process's counter -- which could
    // never satisfy their own gap-detection watermark, so a resync could
    // never actually close the gap that triggered it, looping forever. This
    // assertion is expected to fail against today's code (it.fails); the
    // next slice in this stack fixes resolveRefreshTaskGraphSnapshot and
    // flips this to a normal `it`.
    const remoteTask = makeTask('wf-9/task-1');
    const remoteWorkflow = { id: 'wf-9', name: 'Remote', status: 'running' };

    const result = await resolveRefreshTaskGraphSnapshot({
      ownerMode: false,
      messageBus: {
        async request() {
          // Mirrors the real standalone owner's answer: valid data, but a
          // streamSequence that means nothing to this caller (0, or any
          // other process's own count -- same bug either way).
          return {
            tasks: [remoteTask],
            workflows: [remoteWorkflow],
            streamSequence: 0,
          };
        },
      } as never,
      resolveInvokerHomeRoot: () => '/tmp/invoker-caller',
      logger: makeLogger().logger as never,
      orchestrator: { syncAllFromDb() {}, getAllTasks() { return []; } } as never,
      persistence: { listWorkflows() { return []; } } as never,
      // This caller has already locally forwarded 7285 deltas to its own
      // renderer -- that's the number a resync must report to be useful.
      getStreamSequence: () => 7285,
    });

    expect(result).toEqual({ tasks: [remoteTask], workflows: [remoteWorkflow], streamSequence: 7285 });
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
