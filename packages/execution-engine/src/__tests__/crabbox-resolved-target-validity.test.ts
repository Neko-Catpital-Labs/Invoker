import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskRunner } from '../task-runner.js';
import type { CrabboxResolver } from '../task-runner.js';
import type { ResolvedCrabboxTarget } from '../crabbox-target-resolver.js';
import { SshExecutor } from '../ssh-executor.js';
import type { ExecutorRegistry } from '../registry.js';
import type { Orchestrator, TaskState } from '@invoker/workflow-core';
import type { SQLiteAdapter } from '@invoker/data-store';

function makeTask(id: string): TaskState {
  return {
    id,
    description: id,
    status: 'pending',
    dependencies: [],
    createdAt: new Date(),
    config: { command: 'echo hi', runnerKind: 'ssh', poolId: 'ssh-pool' },
    execution: { selectedAttemptId: `${id}-attempt`, generation: 0 },
  } as unknown as TaskState;
}

function makeCrabboxTarget(overrides: Record<string, unknown> = {}) {
  return {
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
    ...overrides,
  };
}

function lease(id: string, host: string, expiresAt: string = '2999-01-01T00:00:00Z'): ResolvedCrabboxTarget {
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
      expiresAt,
      stopAfter: 'completed',
      keepOnFailure: false,
    },
  };
}

function makeRunner(args: {
  tasks: TaskState[];
  remoteTargetsProvider: () => Record<string, unknown>;
  resolver: CrabboxResolver;
}): TaskRunner {
  const tasksById = new Map(args.tasks.map((task) => [task.id, task]));
  const orchestrator = {
    getTask: (id: string) => tasksById.get(id) ?? null,
    getAllTasks: () => args.tasks,
    markTaskRunningAfterLaunch: () => true,
    handleWorkerResponse: () => [],
    deferTask: () => {},
  } as unknown as Orchestrator;
  const persistence = {
    logEvent: () => {},
    updateTask: () => {},
    updateAttempt: () => {},
    appendTaskOutput: () => {},
    loadAttempts: () => [],
    claimExecutionResourceLease: () => true,
    renewExecutionResourceLease: () => {},
    releaseExecutionResourceLease: () => {},
  } as unknown as SQLiteAdapter;
  const executorRegistry = {
    getDefault: () => ({ type: 'worktree' }),
    get: () => null,
    getAll: () => [],
    register: () => {},
  } as unknown as ExecutorRegistry;

  return new TaskRunner({
    orchestrator,
    persistence,
    executorRegistry,
    cwd: '/tmp',
    remoteTargetsProvider: args.remoteTargetsProvider,
    executionPoolsProvider: () => ({
      'ssh-pool': {
        selectionStrategy: 'leastLoaded',
        maxConcurrentTasksPerMember: 1,
        members: [{ id: 'crab-a', type: 'ssh' as const, maxConcurrentTasks: 1 }],
      },
    }),
    crabboxResolver: args.resolver,
  });
}

function installSshCompletionMocks(): Map<string, (response: unknown) => void> {
  const completeByTask = new Map<string, (response: unknown) => void>();
  vi.spyOn(SshExecutor.prototype, 'start').mockImplementation(async function (
    this: unknown,
    request: { actionId: string },
  ) {
    return {
      executionId: `exec-${request.actionId}`,
      taskId: request.actionId,
      workspacePath: `/remote/${request.actionId}`,
      branch: `branch-${request.actionId}`,
    };
  });
  vi.spyOn(SshExecutor.prototype, 'onComplete').mockImplementation((handle: { taskId: string }, cb: (response: unknown) => void) => {
    completeByTask.set(handle.taskId, cb);
  });
  vi.spyOn(SshExecutor.prototype, 'onOutput').mockImplementation(() => {});
  vi.spyOn(SshExecutor.prototype, 'onHeartbeat').mockImplementation(() => {});
  vi.spyOn(SshExecutor.prototype, 'kill').mockImplementation(async () => {});
  return completeByTask;
}

function completeTask(completeByTask: Map<string, (response: unknown) => void>, task: TaskState): void {
  completeByTask.get(task.id)?.({
    requestId: `r-${task.id}`,
    actionId: task.id,
    attemptId: task.execution.selectedAttemptId,
    executionGeneration: task.execution.generation ?? 0,
    status: 'completed',
    outputs: { exitCode: 0 },
  });
}

describe('crabbox resolved target validity', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('re-resolves when the crabbox target config changes', async () => {
    const completeByTask = installSshCompletionMocks();
    const taskA = makeTask('wf/crab#config-a');
    const taskB = makeTask('wf/crab#config-b');
    let currentTarget = makeCrabboxTarget();
    const resolve = vi.fn(async (config: { provider: string; class: string }) => {
      return config.provider === 'do'
        ? lease('lease-a', 'leased-a.crab')
        : lease('lease-b', 'leased-b.crab');
    });
    const runner = makeRunner({
      tasks: [taskA, taskB],
      remoteTargetsProvider: () => ({ 'crab-a': currentTarget }),
      resolver: { resolve },
    });

    const runA = runner.executeTask(taskA);
    await vi.waitFor(() => expect(resolve).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(completeByTask.has(taskA.id)).toBe(true));
    completeTask(completeByTask, taskA);
    await runA;

    currentTarget = makeCrabboxTarget({ provider: 'fly', class: 'performance-4x' });

    const runB = runner.executeTask(taskB);
    await vi.waitFor(() => expect(resolve).toHaveBeenCalledTimes(2));
    expect(resolve.mock.calls[1]?.[0]).toMatchObject({
      provider: 'fly',
      class: 'performance-4x',
    });
    await vi.waitFor(() => expect(completeByTask.has(taskB.id)).toBe(true));
    completeTask(completeByTask, taskB);
    await runB;
  });

  it('re-resolves when the cached crabbox lease is expired', async () => {
    const completeByTask = installSshCompletionMocks();
    const taskA = makeTask('wf/crab#expired-a');
    const taskB = makeTask('wf/crab#expired-b');
    const resolve = vi.fn()
      .mockResolvedValueOnce(lease('lease-expired', 'leased-expired.crab', '2000-01-01T00:00:00Z'))
      .mockResolvedValueOnce(lease('lease-fresh', 'leased-fresh.crab'));
    const runner = makeRunner({
      tasks: [taskA, taskB],
      remoteTargetsProvider: () => ({ 'crab-a': makeCrabboxTarget() }),
      resolver: { resolve },
    });

    const runA = runner.executeTask(taskA);
    await vi.waitFor(() => expect(resolve).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(completeByTask.has(taskA.id)).toBe(true));
    completeTask(completeByTask, taskA);
    await runA;

    const runB = runner.executeTask(taskB);
    await vi.waitFor(() => expect(resolve).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(completeByTask.has(taskB.id)).toBe(true));
    completeTask(completeByTask, taskB);
    await runB;
  });

  it('rehydrates the resolved ssh endpoint from persisted lease metadata', () => {
    const task = makeTask('wf/crab#restart');
    task.execution.remoteLeaseMetadata = lease('lease-restart', 'leased-restart.crab').remoteLeaseMetadata;
    const runner = makeRunner({
      tasks: [task],
      remoteTargetsProvider: () => ({ 'crab-a': makeCrabboxTarget() }),
      resolver: { resolve: vi.fn() },
    });

    expect(runner.getRemoteTargetConfig('crab-a', task.execution)).toMatchObject({
      host: 'leased-restart.crab',
      user: 'crab',
      sshKeyPath: '/keys/lease-restart',
      port: 2200,
    });
  });
});
