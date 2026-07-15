import { describe, expect, it, vi } from 'vitest';
import { TaskRunner } from '../task-runner.js';
import type { CrabboxResolver } from '../task-runner.js';
import type { ResolvedCrabboxTarget } from '../crabbox-target-resolver.js';
import { SshExecutor } from '../ssh-executor.js';
import type { ExecutorRegistry } from '../registry.js';
import type { Orchestrator, TaskState } from '@invoker/workflow-core';
import type { SQLiteAdapter } from '@invoker/data-store';

// Regression guard for CodeRabbit PR #1403 (discussion r3458135329):
// once Crabbox resolution succeeds the machine is leased on the provider, so
// the lease metadata must be persisted to the task IMMEDIATELY. If it is only
// written on the success path (after executor.start()), a lease whose launch is
// abandoned — pool-lease denied or executor.start() failure — leaves the leased
// box unrecorded in task state, so cleanup/restart flows cannot find and stop
// it and the lease leaks until its TTL.

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

const resolvedTarget: ResolvedCrabboxTarget = {
  sshTarget: { host: 'leased.crab', user: 'crab', sshKeyPath: '/leased/key', port: 2200 },
  remoteLeaseMetadata: {
    provider: 'crabbox',
    leaseId: 'L1',
    slug: 'lease-slug',
    targetId: 'crab-a',
    sshHost: 'leased.crab',
    sshUser: 'crab',
    sshPort: 2200,
    sshKeyPath: '/leased/key',
    expiresAt: '2999-01-01T00:00:00Z',
    stopAfter: 'completed',
    keepOnFailure: false,
  },
};

describe('crabbox lease metadata persistence', () => {
  it('persists lease metadata immediately when executor.start() fails after resolution', async () => {
    // The lease resolves, but the SSH executor start fails afterwards. Use a
    // non-transport error so the runner does not retry another pool member.
    vi.spyOn(SshExecutor.prototype, 'start').mockRejectedValue(
      new Error('crabbox lease executor start failed for repro'),
    );
    vi.spyOn(SshExecutor.prototype, 'onComplete').mockImplementation(() => {});
    vi.spyOn(SshExecutor.prototype, 'onOutput').mockImplementation(() => {});
    vi.spyOn(SshExecutor.prototype, 'onHeartbeat').mockImplementation(() => {});
    vi.spyOn(SshExecutor.prototype, 'kill').mockImplementation(async () => {});

    try {
      const task = makeTask('wf-1/crab-a');
      const resolve = vi.fn(async (): Promise<ResolvedCrabboxTarget> => resolvedTarget);
      const resolver: CrabboxResolver = { resolve };

      // Capture every lease id the runner persists onto the task's execution row.
      const leaseWrites: string[] = [];
      const persistence = {
        logEvent: () => {},
        updateTask: (
          _taskId: string,
          changes: { execution?: { remoteLeaseMetadata?: { leaseId?: string } } },
        ) => {
          const leaseId = changes.execution?.remoteLeaseMetadata?.leaseId;
          if (leaseId) leaseWrites.push(leaseId);
        },
        updateAttempt: () => {},
        appendTaskOutput: () => {},
        loadAttempts: () => [],
        claimExecutionResourceLease: () => true,
        renewExecutionResourceLease: () => {},
        releaseExecutionResourceLease: () => {},
      } as unknown as SQLiteAdapter;

      const orchestrator = {
        getTask: (id: string) => (id === task.id ? task : null),
        getAllTasks: () => [task],
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
            maxConcurrentTasksPerMember: 1,
            members: [{ id: 'crab-a', type: 'ssh' as const, maxConcurrentTasks: 1 }],
          },
        }),
        crabboxResolver: resolver,
      });

      // executeTask swallows the start failure into a failed WorkResponse, so it
      // resolves rather than rejecting.
      await runner.executeTask(task);

      // Resolution ran and the executor start was attempted (and failed).
      expect(resolve).toHaveBeenCalledTimes(1);
      expect(SshExecutor.prototype.start).toHaveBeenCalledTimes(1);

      // The lease must have been persisted to the task despite the abandoned
      // launch. On the buggy code lease metadata is only written on the success
      // path (after a successful start), so nothing is recorded here.
      expect(leaseWrites).toContain('L1');
    } finally {
      vi.restoreAllMocks();
    }
  });
});
