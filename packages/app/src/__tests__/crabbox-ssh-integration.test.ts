/**
 * Cross-surface regression for Crabbox-backed SSH.
 *
 * One Crabbox-leased SSH task is driven through every surface it touches —
 * with no real Crabbox binary, SSH host, or cloud provider:
 *
 *   1. execution-engine runtime selection: a task with `runnerKind: 'ssh'` and
 *      a `poolMemberId` pointing at a `type: 'crabbox'` remote target resolves
 *      through a fake resolver (no warmup/status process spawned).
 *   2. SshExecutor construction: the executor is built from the *resolved*
 *      lease coordinates (host/user/port/keyPath), not the empty config target.
 *   3. SQLite metadata: the resolved `remoteLeaseMetadata` is persisted into a
 *      fake metadata store that mimics the SQLite columns terminal restore reads.
 *   4. Terminal restore: feeding that *same* store back into the app's terminal
 *      opener refreshes the lease and opens a terminal to the leased machine.
 *   5. Cleanup policy: a failed task with `keepOnFailure` keeps the lease (no
 *      stop), while a successful task under the default policy stops it.
 *
 * The whole flow is deterministic: every Crabbox/SSH side effect is mocked.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  TaskRunner,
  SshExecutor,
  ExecutorRegistry,
  CrabboxTargetResolver,
  type CrabboxCommandResult,
} from '@invoker/execution-engine';
import type { TaskState } from '@invoker/workflow-core';
import type { WorkResponse } from '@invoker/contracts';
import { openExternalTerminalForTask } from '../open-terminal-for-task.js';
import * as configModule from '../config.js';
import * as terminalLaunch from '../terminal-external-launch.js';

// ── Fixtures ──────────────────────────────────────────────────

/** A configured `type: 'crabbox'` remote target. Empty host/user/key on purpose:
 *  the coordinates only exist after the lease resolves, so any leak of the static
 *  target into the SSH executor would show up as undefined host. */
const CRABBOX_TARGET = {
  type: 'crabbox' as const,
  crabboxCommand: '/usr/local/bin/crabbox',
  provider: 'fly',
  class: 'performance-4x',
  ttl: '30m',
  idleTimeout: '10m',
  network: 'invoker-net',
  target: 'us-east',
  stopAfter: 'success',
  keepOnFailure: true,
  statusArgs: ['--region', 'iad'],
};

/** The leased SSH endpoint the fake resolver hands back. */
const LEASED = {
  host: '203.0.113.9',
  user: 'runner',
  sshKeyPath: '/leased/key',
  port: 2200,
};

/** Fake resolver: resolves a lease without spawning Crabbox, and records stops. */
function makeFakeResolver() {
  const resolve = vi.fn(async (config: any) => ({
    sshTarget: { ...LEASED },
    remoteLeaseMetadata: {
      provider: 'crabbox' as const,
      leaseId: 'lease-abc',
      slug: 'happy-crab',
      targetId: config.id,
      sshHost: LEASED.host,
      sshUser: LEASED.user,
      sshPort: LEASED.port,
      sshKeyPath: LEASED.sshKeyPath,
      expiresAt: '2099-01-01T00:00:00.000Z',
      stopAfter: config.stopAfter,
      keepOnFailure: config.keepOnFailure,
    },
  }));
  const stop = vi.fn(async () => {});
  return { resolve, stop };
}

function makeTask(overrides: {
  id?: string;
  config?: Partial<TaskState['config']>;
  execution?: Partial<TaskState['execution']>;
} = {}): TaskState {
  return {
    id: overrides.id ?? 'wf/crab-task',
    description: 'Crabbox SSH task',
    status: 'pending',
    dependencies: [],
    createdAt: new Date(),
    config: { ...overrides.config },
    execution: { ...overrides.execution },
  } as TaskState;
}

/**
 * Fake metadata store that plays the role of the SQLite persistence on BOTH
 * surfaces: it captures the start-metadata `updateTask` writes from the
 * TaskRunner, and exposes the column getters the terminal opener reads. This is
 * the cross-surface link — what execution-engine persists is what app reads.
 */
function makeMetadataStore() {
  const rows = new Map<string, Record<string, any>>();
  const merge = (taskId: string, changes: any) => {
    const row = rows.get(taskId) ?? {};
    if (changes.config) Object.assign(row, changes.config);
    if (changes.execution) Object.assign(row, changes.execution);
    rows.set(taskId, row);
  };
  const col = (taskId: string, key: string) => rows.get(taskId)?.[key] ?? null;

  return {
    rows,
    // ── TaskRunner persistence surface ──
    updateTask: vi.fn((taskId: string, changes: any) => merge(taskId, changes)),
    updateAttempt: vi.fn(),
    appendTaskOutput: vi.fn(),
    logEvent: vi.fn(),
    loadAttempts: () => [],
    // ── OpenTerminalPersistence surface (reads the columns above) ──
    getTaskStatus: vi.fn(() => 'completed'),
    getRunnerKind: vi.fn((taskId: string) => col(taskId, 'runnerKind')),
    getAgentSessionId: vi.fn((taskId: string) => col(taskId, 'agentSessionId')),
    getContainerId: vi.fn((taskId: string) => col(taskId, 'containerId')),
    getWorkspacePath: vi.fn((taskId: string) => col(taskId, 'workspacePath')),
    getBranch: vi.fn((taskId: string) => col(taskId, 'branch')),
    getPoolMemberId: vi.fn((taskId: string) => col(taskId, 'poolMemberId')),
    getExecutionAgent: vi.fn((taskId: string) => col(taskId, 'agentName')),
    getRemoteLeaseMetadata: vi.fn((taskId: string) => col(taskId, 'remoteLeaseMetadata')),
  };
}

/** Mock SshExecutor lifecycle so no real SSH runs, capturing constructed coords. */
function stubSshExecutor() {
  const starts: Array<{ host: string; user: string; sshKeyPath: string; port: number }> = [];
  const completeByTask = new Map<string, (r: WorkResponse) => void>();
  vi.spyOn(SshExecutor.prototype, 'start').mockImplementation(async function (this: any, request: any) {
    starts.push({ host: this.host, user: this.user, sshKeyPath: this.sshKeyPath, port: this.port });
    return {
      executionId: `exec-${request.actionId}`,
      taskId: request.actionId,
      workspacePath: `~/.invoker/worktrees/abc/experiment-${request.actionId}`,
      branch: `experiment/${request.actionId}`,
    };
  });
  vi.spyOn(SshExecutor.prototype, 'onComplete').mockImplementation((handle: any, cb: any) => {
    completeByTask.set(handle.taskId, cb);
  });
  vi.spyOn(SshExecutor.prototype, 'onOutput').mockImplementation(() => {});
  vi.spyOn(SshExecutor.prototype, 'onHeartbeat').mockImplementation(() => {});
  vi.spyOn(SshExecutor.prototype, 'kill').mockImplementation(async () => {});
  return { starts, completeByTask };
}

/** Build a TaskRunner wired to the fake resolver + crabbox target + store. */
function makeRunner(
  task: TaskState,
  store: ReturnType<typeof makeMetadataStore>,
  resolver: { resolve: any; stop: any },
  callbacks?: any,
) {
  return new TaskRunner({
    orchestrator: {
      getTask: (id: string) => (id === task.id ? task : null),
      getAllTasks: () => [task],
      markTaskRunningAfterLaunch: () => true,
      handleWorkerResponse: () => [],
      deferTask: vi.fn(),
    } as any,
    persistence: store as any,
    executorRegistry: {
      getDefault: () => ({ type: 'worktree' }),
      get: () => null,
      getAll: () => [],
      register: vi.fn(),
    } as any,
    cwd: '/tmp',
    remoteTargetsProvider: () => ({ 'crab-1': CRABBOX_TARGET }),
    crabboxResolver: resolver,
    callbacks,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ── 1+2+3: resolution → SshExecutor construction → persisted metadata ─────────

describe('Crabbox SSH cross-surface: resolution, executor, and persisted lease', () => {
  it('resolves the lease, builds SshExecutor from the leased endpoint, and persists lease metadata', async () => {
    const { starts, completeByTask } = stubSshExecutor();
    const store = makeMetadataStore();
    const resolver = makeFakeResolver();
    const task = makeTask({
      id: 'wf/crab-task',
      config: { runnerKind: 'ssh', poolMemberId: 'crab-1' },
      execution: { selectedAttemptId: 'crab-attempt', generation: 0 },
    });
    const runner = makeRunner(task, store, resolver);

    const run = runner.executeTask(task);
    await vi.waitFor(() => expect(starts.length).toBe(1));

    // (1) Resolved exactly once with the configured crabbox lease inputs — no real
    //     warmup/status process was spawned.
    expect(resolver.resolve).toHaveBeenCalledTimes(1);
    expect(resolver.resolve.mock.calls[0][0]).toMatchObject({
      id: 'crab-1',
      crabboxCommand: '/usr/local/bin/crabbox',
      provider: 'fly',
      class: 'performance-4x',
      stopAfter: 'success',
      keepOnFailure: true,
    });

    // (2) SshExecutor was constructed from the *resolved* endpoint, not the empty
    //     static target. A leak of the static config would show undefined host.
    expect(starts[0]).toEqual({
      host: '203.0.113.9',
      user: 'runner',
      sshKeyPath: '/leased/key',
      port: 2200,
    });

    // (3) The durable lease metadata + runner kind + pool member landed in the
    //     metadata store under the columns terminal restore reads.
    const row = store.rows.get(task.id)!;
    expect(row.runnerKind).toBe('ssh');
    expect(row.poolMemberId).toBe('crab-1');
    expect(row.remoteLeaseMetadata).toMatchObject({
      provider: 'crabbox',
      leaseId: 'lease-abc',
      targetId: 'crab-1',
      sshHost: '203.0.113.9',
      sshUser: 'runner',
      sshPort: 2200,
      sshKeyPath: '/leased/key',
    });

    completeByTask.get(task.id)?.({
      requestId: 'r',
      actionId: task.id,
      attemptId: 'crab-attempt',
      status: 'completed',
      outputs: { exitCode: 0 },
    } as WorkResponse);
    await run;
  });
});

// ── 4: terminal restore reads the persisted metadata and refreshes the lease ──

describe('Crabbox SSH cross-surface: terminal restore reads persisted lease', () => {
  function scriptedResolver(result: CrabboxCommandResult) {
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const resolver = new CrabboxTargetResolver(async (command, args) => {
      calls.push({ command, args });
      return result;
    });
    return { resolver, calls };
  }

  it('reads the lease persisted by execution-engine and opens a terminal to the refreshed host', async () => {
    // First: run the task so the store holds real persisted metadata.
    const { starts, completeByTask } = stubSshExecutor();
    const store = makeMetadataStore();
    const task = makeTask({
      id: 'wf/crab-restore',
      config: { runnerKind: 'ssh', poolMemberId: 'crab-1' },
      execution: { selectedAttemptId: 'crab-attempt', generation: 0 },
    });
    const runner = makeRunner(task, store, makeFakeResolver());
    const run = runner.executeTask(task);
    await vi.waitFor(() => expect(starts.length).toBe(1));
    completeByTask.get(task.id)?.({
      requestId: 'r',
      actionId: task.id,
      attemptId: 'crab-attempt',
      status: 'completed',
      outputs: { exitCode: 0 },
    } as WorkResponse);
    await run;
    vi.restoreAllMocks();

    // Now restart-style restore: only the persisted store survives. Refreshing the
    // lease reports NEW coordinates that must override the persisted (now stale) ones.
    const mockSpawnDetached = vi.fn(async () => ({ opened: true } as const));
    vi.spyOn(terminalLaunch, 'spawnDetachedTerminal').mockImplementation(mockSpawnDetached as any);
    const loadConfigSpy = vi.spyOn(configModule, 'loadConfig').mockReturnValue({
      remoteTargets: { 'crab-1': CRABBOX_TARGET },
    } as any);

    const { resolver, calls } = scriptedResolver({
      stdout: JSON.stringify({
        id: 'lease-abc',
        slug: 'happy-crab',
        status: 'ready',
        expiresAt: '2099-12-01T00:00:00.000Z',
        sshHost: '198.51.100.7',
        sshUser: 'fresh-runner',
        sshPort: 2299,
        sshKey: '/leased/fresh-key',
      }),
      stderr: '',
      exitCode: 0,
    });

    const result = await openExternalTerminalForTask({
      taskId: task.id,
      persistence: store as any,
      executorRegistry: new ExecutorRegistry(),
      repoRoot: '/repo',
      crabboxResolver: resolver,
    });

    expect(result.opened).toBe(true);

    // Terminal restore actually read the lease metadata the runner persisted.
    expect(store.getRemoteLeaseMetadata).toHaveBeenCalledWith(task.id);

    // Refresh ran a no-wait status call against the persisted lease id.
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe('/usr/local/bin/crabbox');
    expect(calls[0].args).toEqual([
      'status', '--id', 'lease-abc', '--json', '--region', 'iad',
    ]);

    // Terminal opened to the REFRESHED host + the persisted branch; the stale
    // persisted host must not leak through.
    const argsJson = JSON.stringify(mockSpawnDetached.mock.calls[0]?.[1]);
    expect(argsJson).toContain('198.51.100.7');
    expect(argsJson).toContain('fresh-runner@198.51.100.7');
    expect(argsJson).toContain('experiment/wf/crab-restore');
    expect(argsJson).not.toContain('203.0.113.9');

    loadConfigSpy.mockRestore();
  });
});

// ── 5: cleanup policy across the success / keep-on-failure split ───────────────

describe('Crabbox SSH cross-surface: cleanup policy', () => {
  async function runToCompletion(final: { status: WorkResponse['status']; exitCode: number }) {
    const { starts, completeByTask } = stubSshExecutor();
    const store = makeMetadataStore();
    const resolver = makeFakeResolver();
    const task = makeTask({
      id: 'wf/crab-cleanup',
      config: { runnerKind: 'ssh', poolMemberId: 'crab-1' },
      execution: { selectedAttemptId: 'crab-attempt', generation: 0 },
    });
    const onOutput = vi.fn();
    const runner = makeRunner(task, store, resolver, { onOutput });

    const run = runner.executeTask(task);
    await vi.waitFor(() => expect(starts.length).toBe(1));
    completeByTask.get(task.id)?.({
      requestId: 'r',
      actionId: task.id,
      attemptId: 'crab-attempt',
      status: final.status,
      outputs: { exitCode: final.exitCode },
    } as WorkResponse);
    await run;

    const event = (name: string) =>
      store.logEvent.mock.calls.find(([, e]: [string, string]) => e === name)?.[2];
    return { resolver, store, event };
  }

  it('does NOT stop the lease on failure when keepOnFailure is true', async () => {
    const { resolver, event } = await runToCompletion({ status: 'failed', exitCode: 1 });

    expect(resolver.stop).not.toHaveBeenCalled();
    expect(event('task.executor.crabbox-cleanup-skipped')).toMatchObject({
      leaseId: 'lease-abc',
      reason: 'keepOnFailure',
    });
  });

  it('DOES stop the lease on success under the default policy', async () => {
    const { resolver, event } = await runToCompletion({ status: 'completed', exitCode: 0 });

    expect(resolver.stop).toHaveBeenCalledTimes(1);
    expect(resolver.stop).toHaveBeenCalledWith(
      { id: 'crab-1', crabboxCommand: '/usr/local/bin/crabbox', stopArgs: undefined },
      'lease-abc',
    );
    expect(event('task.executor.crabbox-stopped')).toMatchObject({
      leaseId: 'lease-abc',
      stopAfter: 'success',
      succeeded: true,
    });
  });
});
