import { describe, expect, it, vi } from 'vitest';
import { TaskRunner } from '../task-runner.js';
import type { CrabboxResolver } from '../task-runner.js';
import type { ResolvedCrabboxTarget } from '../crabbox-target-resolver.js';
import { SshExecutor } from '../ssh-executor.js';
import type { ExecutorRegistry } from '../registry.js';
import type { Orchestrator, TaskState } from '@invoker/workflow-core';
import type { SQLiteAdapter } from '@invoker/data-store';

// Regression guard for CodeRabbit PR #1403 (discussion r3458135315):
// "Make resolved Crabbox leases launch-scoped and validity-aware."
//
// `resolvedCrabboxTargets` is a single in-memory entry per target. When two
// tasks on the SAME crabbox target resolve concurrently (both miss the shared
// map, both call the resolver, and each gets its own lease), the second
// resolution overwrites the map after the first executor was already built from
// its own lease. The first launch then persists/logs metadata read back from
// the shared map — i.e. the OTHER launch's lease — even though its executor is
// talking to the box it originally leased. Cleanup/restore then targets the
// wrong leased box.
//
// This test forces that exact interleaving and asserts each task persists ITS
// OWN lease id. On the buggy code the first task persists the second task's
// lease id via the success-path map read.

function makeTask(id: string): TaskState {
  return {
    id,
    description: id,
    status: 'pending',
    dependencies: [],
    createdAt: new Date(),
    config: { command: 'echo hi', runnerKind: 'ssh', poolId: 'ssh-pool' },
    execution: { selectedAttemptId: `${id}-attempt`, generation: 0 },
  } as unknown as TaskState; // Minimal TaskState fixture for the runner under test.
}

const crabboxTarget = {
  type: 'crabbox' as const,
  crabboxCommand: 'crabbox',
  provider: 'do',
  class: 'medium',
  ttl: '30m',
  idleTimeout: '10m',
  network: 'default',
  target: 'ubuntu-22',
  stopAfter: 'completed',
  keepOnFailure: false,
};

function lease(id: string, host: string): ResolvedCrabboxTarget {
  return {
    sshTarget: { host, user: 'crab', sshKeyPath: `/keys/${id}`, port: 2200 },
    remoteLeaseMetadata: {
      provider: 'crabbox',
      leaseId: id,
      slug: `slug-${id}`,
      targetId: 'crab-a',
      sshHost: host,
      sshUser: 'crab',
      sshPort: 2200,
      sshKeyPath: `/keys/${id}`,
      expiresAt: '2999-01-01T00:00:00Z',
      stopAfter: 'completed',
      keepOnFailure: false,
    },
  };
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolveFn!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolveFn = res;
  });
  return { promise, resolve: resolveFn };
}

describe('crabbox concurrent lease metadata', () => {
  it('persists each launch its own lease under concurrent same-target resolution', async () => {
    const leaseA = lease('lease-a', 'leased-a.crab');
    const leaseB = lease('lease-b', 'leased-b.crab');

    const taskA = makeTask('wf/crab#a');
    const taskB = makeTask('wf/crab#b');

    // Gate the resolver so BOTH launches miss the shared map and call resolve()
    // before either writes its lease back into the map.
    const gateResolveA = deferred();
    const gateResolveB = deferred();
    let resolveCall = 0;
    const resolve = vi.fn(async (): Promise<ResolvedCrabboxTarget> => {
      resolveCall += 1;
      if (resolveCall === 1) {
        await gateResolveA.promise;
        return leaseA;
      }
      await gateResolveB.promise;
      return leaseB;
    });
    const resolver: CrabboxResolver = { resolve };

    // Gate the FIRST launch's executor.start() so its success-path persistence
    // runs AFTER the second launch has overwritten the shared map.
    const gateStartA = deferred();
    const startedActionIds = new Set<string>();
    vi.spyOn(SshExecutor.prototype, 'start').mockImplementation(async function (
      this: unknown,
      request: { actionId: string },
    ) {
      startedActionIds.add(request.actionId);
      if (request.actionId === taskA.id) {
        await gateStartA.promise;
      }
      return {
        executionId: `exec-${request.actionId}`,
        taskId: request.actionId,
        workspacePath: `/remote/${request.actionId}`,
        branch: `branch-${request.actionId}`,
      };
    });
    const completeByTask = new Map<string, (response: unknown) => void>();
    vi.spyOn(SshExecutor.prototype, 'onComplete').mockImplementation((handle: { taskId: string }, cb: (r: unknown) => void) => {
      completeByTask.set(handle.taskId, cb);
    });
    vi.spyOn(SshExecutor.prototype, 'onOutput').mockImplementation(() => {});
    vi.spyOn(SshExecutor.prototype, 'onHeartbeat').mockImplementation(() => {});
    vi.spyOn(SshExecutor.prototype, 'kill').mockImplementation(async () => {});

    try {
      // Record every lease id persisted onto each task's execution row.
      const leaseWritesByTask = new Map<string, string[]>();
      const persistence = {
        logEvent: () => {},
        updateTask: (
          taskId: string,
          changes: { execution?: { remoteLeaseMetadata?: { leaseId?: string } } },
        ) => {
          const leaseId = changes.execution?.remoteLeaseMetadata?.leaseId;
          if (leaseId) {
            const list = leaseWritesByTask.get(taskId) ?? [];
            list.push(leaseId);
            leaseWritesByTask.set(taskId, list);
          }
        },
        updateAttempt: () => {},
        appendTaskOutput: () => {},
        loadAttempts: () => [],
        claimExecutionResourceLease: () => true,
        renewExecutionResourceLease: () => {},
        releaseExecutionResourceLease: () => {},
      } as unknown as SQLiteAdapter;

      const tasksById = new Map([taskA, taskB].map((t) => [t.id, t]));
      const orchestrator = {
        getTask: (id: string) => tasksById.get(id) ?? null,
        getAllTasks: () => [taskA, taskB],
        markTaskRunningAfterLaunch: () => true,
        handleWorkerResponse: () => [],
        deferTask: () => {},
      } as unknown as Orchestrator;

      const executorRegistry = {
        getDefault: () => ({ type: 'worktree' }),
        get: () => null,
        getAll: () => [],
        register: () => {},
      } as unknown as ExecutorRegistry;

      const runner = new TaskRunner({
        orchestrator,
        persistence,
        executorRegistry,
        cwd: '/tmp',
        remoteTargetsProvider: () => ({ 'crab-a': crabboxTarget }),
        executionPoolsProvider: () => ({
          'ssh-pool': {
            selectionStrategy: 'leastLoaded',
            // Two concurrent tasks may share the on-demand crabbox provisioner.
            maxConcurrentTasksPerMember: 2,
            members: [{ id: 'crab-a', type: 'ssh' as const, maxConcurrentTasks: 2 }],
          },
        }),
        crabboxResolver: resolver,
      });

      const runA = runner.executeTask(taskA);
      // First launch reaches resolve() and parks on the gate.
      await vi.waitFor(() => expect(resolve).toHaveBeenCalledTimes(1));

      const runB = runner.executeTask(taskB);
      // Second launch also misses the (still-empty) map and parks on resolve().
      await vi.waitFor(() => expect(resolve).toHaveBeenCalledTimes(2));

      // Let the first launch resolve, build its executor from lease-a, then park
      // inside executor.start() before it persists success-path metadata.
      gateResolveA.resolve();
      await vi.waitFor(() => expect(startedActionIds.has(taskA.id)).toBe(true));

      // Let the second launch resolve; it overwrites the shared map with lease-b
      // and completes fully (start is not gated for it).
      gateResolveB.resolve();
      await vi.waitFor(() => expect(completeByTask.has(taskB.id)).toBe(true));
      completeByTask.get(taskB.id)?.({
        requestId: 'rb',
        actionId: taskB.id,
        attemptId: taskB.execution.selectedAttemptId,
        executionGeneration: 0,
        status: 'completed',
        outputs: { exitCode: 0 },
      });

      // Now release the first launch. Its success-path persistence runs with the
      // shared map already pointing at lease-b.
      gateStartA.resolve();
      await vi.waitFor(() => expect(completeByTask.has(taskA.id)).toBe(true));
      completeByTask.get(taskA.id)?.({
        requestId: 'ra',
        actionId: taskA.id,
        attemptId: taskA.execution.selectedAttemptId,
        executionGeneration: 0,
        status: 'completed',
        outputs: { exitCode: 0 },
      });

      await Promise.all([runA, runB]);

      const writesA = leaseWritesByTask.get(taskA.id) ?? [];
      const writesB = leaseWritesByTask.get(taskB.id) ?? [];

      // Each task must resolve and persist a lease.
      expect(resolve).toHaveBeenCalledTimes(2);
      expect(writesA.length).toBeGreaterThan(0);
      expect(writesB.length).toBeGreaterThan(0);

      // The core invariant: a launch never persists another launch's lease id.
      // Buggy code makes taskA's success-path write read lease-b from the shared
      // map after taskB overwrote it.
      expect(writesA).not.toContain('lease-b');
      expect(writesA.every((id) => id === 'lease-a')).toBe(true);
      expect(writesB.every((id) => id === 'lease-b')).toBe(true);
    } finally {
      vi.restoreAllMocks();
    }
  });
});
