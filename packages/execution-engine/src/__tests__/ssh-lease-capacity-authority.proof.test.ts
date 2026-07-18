import { describe, it, expect, vi } from 'vitest';
import { TaskRunner } from '../task-runner.js';
import type { TaskState } from '@invoker/workflow-core';
import { SQLiteAdapter } from '@invoker/data-store';

/**
 * Authority proof for durable SSH lease capacity.
 *
 * SSH member capacity is decided by unexpired `execution_resource_leases`
 * rows (host-keyed), not by in-memory `activeExecutions` / `pendingPoolSelections`.
 */

const sharedHost = {
  host: 'shared.example.com',
  user: 'invoker',
  sshKeyPath: '/tmp/fake-shared',
};

function makeSshExecutor() {
  return {
    type: 'ssh',
    start: vi.fn(),
    onComplete: vi.fn(),
    onOutput: vi.fn(),
    onHeartbeat: vi.fn(),
    kill: vi.fn().mockResolvedValue(undefined),
    destroyAll: vi.fn(),
  };
}

function makeTask(id: string, poolId: string, attempt = `${id}-attempt`): TaskState {
  return {
    id,
    description: id,
    status: 'pending',
    dependencies: [],
    createdAt: new Date(),
    config: { command: 'echo hi', runnerKind: 'ssh', poolId },
    execution: { selectedAttemptId: attempt, generation: 0 },
  } as TaskState;
}

function makeDualPoolRunner(opts: {
  persistence?: unknown;
  orchestrator?: unknown;
  sshExecutor?: unknown;
} = {}): TaskRunner {
  const sshExecutor = opts.sshExecutor ?? makeSshExecutor();
  return new TaskRunner({
    orchestrator: opts.orchestrator ?? {
      getTask: () => null,
      getAllTasks: () => [],
      deferTask: vi.fn(),
    },
    persistence: opts.persistence ?? { logEvent: vi.fn() },
    executorRegistry: {
      getDefault: () => sshExecutor,
      get: (type: string) => (type === 'ssh' ? sshExecutor : null),
      getAll: () => [sshExecutor],
      register: vi.fn(),
    } as never,
    cwd: '/tmp',
    remoteTargetsProvider: () => ({
      'remote-shared': sharedHost,
    }),
    executionPoolsProvider: () => ({
      'mixed-local-ssh': {
        selectionStrategy: 'leastLoaded',
        maxConcurrentTasksPerMember: 1,
        members: [{ id: 'remote-shared', type: 'ssh', maxConcurrentTasks: 1 }],
      },
      'pnpm-ssh': {
        selectionStrategy: 'leastLoaded',
        maxConcurrentTasksPerMember: 1,
        members: [{ id: 'remote-shared', type: 'ssh', maxConcurrentTasks: 1 }],
      },
    }),
  } as never);
}

describe('SSH lease capacity authority (proof)', () => {
  // Lease-backed SSH load ignores lease-less activeExecutions ghosts.
  it('does not wedge SSH capacity on a lease-less activeExecutions ghost', () => {
    const liveTask = makeTask('wf-1/task-a', 'pnpm-ssh', 'wf-1/task-a-live');
    liveTask.status = 'running';
    const sshExecutor = makeSshExecutor();
    const runner = makeDualPoolRunner({
      sshExecutor,
      orchestrator: {
        getTask: (id: string) => (id === liveTask.id ? liveTask : null),
        getAllTasks: () => [liveTask],
        deferTask: vi.fn(),
      },
      persistence: {
        logEvent: vi.fn(),
        listExecutionResourceLeases: () => [],
        claimExecutionResourceLease: () => true,
        releaseExecutionResourceLease: vi.fn(),
      },
    });

    (runner as unknown as { activeExecutions: Map<string, unknown> }).activeExecutions.set(
      'wf-1/task-a-live',
      {
        handle: { attemptId: 'wf-1/task-a-live' },
        executor: sshExecutor,
        taskId: liveTask.id,
        poolId: 'pnpm-ssh',
        poolMemberKey: 'ssh:remote-shared',
      },
    );

    expect((runner as any).persistence.listExecutionResourceLeases()).toEqual([]);
    expect(() => runner.selectExecutor(makeTask('wf-2/task-b', 'pnpm-ssh'))).not.toThrow();
  });

  // Host-keyed claim-at-select prevents two pools from double-booking one droplet.
  it('blocks a second pool from selecting a host already reserved by another pool', async () => {
    const adapter = await SQLiteAdapter.create(':memory:');
    try {
      const first = makeTask('wf-1/task-a', 'mixed-local-ssh');
      const second = makeTask('wf-2/task-b', 'pnpm-ssh');
      const runner = makeDualPoolRunner({
        persistence: {
          logEvent: vi.fn(),
          claimExecutionResourceLease: adapter.claimExecutionResourceLease.bind(adapter),
          renewExecutionResourceLease: adapter.renewExecutionResourceLease.bind(adapter),
          releaseExecutionResourceLease: adapter.releaseExecutionResourceLease.bind(adapter),
          listExecutionResourceLeases: adapter.listExecutionResourceLeases.bind(adapter),
        },
      });

      expect(() => runner.selectExecutor(first)).not.toThrow();
      // After claim-at-select, the first selection holds a host lease. The second
      // pool must see the shared host as full.
      expect(() => runner.selectExecutor(second)).toThrow(/no member capacity|resource-limit|lease/i);
      expect(adapter.listExecutionResourceLeases().length).toBeGreaterThanOrEqual(1);
    } finally {
      adapter.close();
    }
  });
});
