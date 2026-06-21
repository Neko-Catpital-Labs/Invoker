/**
 * Cross-surface regression for Crabbox-backed SSH.
 *
 * One feature, four surfaces — proven end-to-end with everything mocked
 * (no real Crabbox binary, no SSH host, no cloud provider, no network):
 *
 *  1. Runtime selection — a task with runnerKind:'ssh' + poolMemberId pointing at
 *     a type:'crabbox' target resolves its SSH endpoint through a *fake* resolver
 *     (TaskRunner.resolveCrabboxIfNeeded + selectExecutor).
 *  2. Executor construction — the resulting SshExecutor receives the *resolved*
 *     host/user/port/key (not the static config).
 *  3. SQLite metadata ↔ terminal restore — the lease metadata produced by the
 *     resolver is persisted through the real SQLiteAdapter and later read back by
 *     openExternalTerminalForTask to reattach to the live box.
 *  4. Cleanup policy — a failed task with keepOnFailure keeps the box (no stop);
 *     a successful task under the default policy stops it.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  TaskRunner,
  SshExecutor,
  ExecutorRegistry,
  type CrabboxResolvedTarget,
} from '@invoker/execution-engine';
import { SQLiteAdapter } from '@invoker/data-store';
import type { TaskState } from '@invoker/workflow-core';

// Keep the external terminal launch fully mocked — no real terminal/process spawn.
vi.mock('../terminal-external-launch.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../terminal-external-launch.js')>();
  return {
    ...actual,
    spawnDetachedTerminal: vi.fn(async () => ({ opened: true })),
  };
});
import { spawnDetachedTerminal } from '../terminal-external-launch.js';
import { openExternalTerminalForTask } from '../open-terminal-for-task.js';
import * as configModule from '../config.js';

// ── Shared fixtures ───────────────────────────────────────────

/** The live endpoint a fake `crabbox` resolver hands back for a leased box. */
const RESOLVED_ENDPOINT = {
  host: 'box-42.crabbox.dev',
  user: 'crab',
  sshKeyPath: '/tmp/crab_key',
  port: 2200,
} as const;

/** Lease metadata that the resolver attaches and the runtime persists. */
const LEASE_METADATA = {
  provider: 'crabbox' as const,
  leaseId: 'lease-xyz',
  slug: 'box-42',
  targetId: 'crab-target',
  sshHost: RESOLVED_ENDPOINT.host,
  sshUser: RESOLVED_ENDPOINT.user,
  sshPort: RESOLVED_ENDPOINT.port,
  sshKeyPath: RESOLVED_ENDPOINT.sshKeyPath,
  stopAfter: 'success' as const,
  keepOnFailure: true,
};

/** A `type: 'crabbox'` remote target — leased on demand, never a static endpoint. */
const CRABBOX_TARGET = {
  type: 'crabbox',
  crabboxCommand: 'crabbox',
  provider: 'fly',
  class: 'small',
  ttl: '1h',
  idleTimeout: '20m',
  network: 'default',
  target: 'ubuntu',
  stopAfter: 'success',
  keepOnFailure: true,
};

function crabboxSshTask(id = 'wf-crab/ssh-task'): TaskState {
  return {
    id,
    description: 'crabbox ssh task',
    status: 'pending',
    dependencies: [],
    createdAt: new Date(),
    config: { command: 'echo hi', runnerKind: 'ssh', poolMemberId: 'crab-target' },
    execution: { generation: 0 },
  } as unknown as TaskState;
}

/** Build a TaskRunner wired to a fake Crabbox resolver + stopper. */
function makeRunner(overrides: {
  resolver?: ReturnType<typeof vi.fn>;
  stopper?: ReturnType<typeof vi.fn>;
} = {}) {
  const resolver =
    overrides.resolver ??
    vi.fn(
      async (): Promise<CrabboxResolvedTarget> => ({
        target: { ...RESOLVED_ENDPOINT },
        remoteLeaseMetadata: { ...LEASE_METADATA },
      }),
    );
  const stopper = overrides.stopper ?? vi.fn(async () => undefined);

  const runner = new TaskRunner({
    orchestrator: { getTask: () => null, getAllTasks: () => [], deferTask: vi.fn() } as any,
    persistence: { logEvent: vi.fn(), appendTaskOutput: vi.fn() } as any,
    executorRegistry: {
      // Return null for 'ssh' so the lazy-registration branch builds a fresh
      // SshExecutor from the resolved endpoint (a registered one would shadow it).
      get: () => null,
      getDefault: () => ({ type: 'worktree' }) as any,
      getAll: () => [],
      register: vi.fn(),
    } as any,
    cwd: '/tmp',
    remoteTargetsProvider: () => ({ 'crab-target': { ...CRABBOX_TARGET } }) as any,
    crabboxResolver: resolver as any,
    crabboxStopper: stopper as any,
  });

  return { runner, resolver, stopper };
}

// ── 1 + 2: resolver-driven runtime selection + SshExecutor construction ──

describe('Crabbox SSH: runtime selection builds SshExecutor from the resolved lease', () => {
  it('resolves a type:crabbox target through the fake resolver and constructs SshExecutor with resolved host/user/port/key', async () => {
    const { runner, resolver } = makeRunner();
    const task = crabboxSshTask();

    // The execution loop resolves the Crabbox box (async) before building the executor.
    await (runner as any).resolveCrabboxIfNeeded(task);
    const executor = runner.selectExecutor(task);

    // The fake resolver was called exactly once, with the config derived from the
    // crabbox target — no real `crabbox` binary, SSH host, or cloud call.
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(resolver.mock.calls[0][0]).toMatchObject({
      crabboxCommand: 'crabbox',
      provider: 'fly',
      class: 'small',
      target: 'ubuntu',
      stopAfter: 'success',
      keepOnFailure: true,
    });

    // Construction received the *resolved* endpoint, not static config.
    expect(executor).toBeInstanceOf(SshExecutor);
    expect((executor as any).host).toBe(RESOLVED_ENDPOINT.host);
    expect((executor as any).user).toBe(RESOLVED_ENDPOINT.user);
    expect((executor as any).port).toBe(RESOLVED_ENDPOINT.port);
    expect((executor as any).sshKeyPath).toBe(RESOLVED_ENDPOINT.sshKeyPath);
  });

  it('refuses to build the SSH executor when the Crabbox box was never resolved', () => {
    const { runner } = makeRunner();
    const task = crabboxSshTask('wf-crab/unresolved');
    // selectExecutor without a prior resolveCrabboxIfNeeded must fail loudly.
    expect(() => runner.selectExecutor(task)).toThrow(/no resolved SSH endpoint/);
  });
});

// ── 3: SQLite metadata persisted by the runtime, read back by terminal restore ──

describe('Crabbox SSH: lease metadata round-trips SQLite into terminal restore', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(spawnDetachedTerminal).mockClear();
  });

  it('persists remoteLeaseMetadata and reattaches the terminal to a refreshed lease', async () => {
    const adapter = await SQLiteAdapter.create(':memory:');
    const now = new Date().toISOString();
    adapter.saveWorkflow({ id: 'wf-crab', name: 'crab', createdAt: now, updatedAt: now } as any);
    adapter.saveTask('wf-crab', {
      id: 'wf-crab/ssh-task',
      description: 'crabbox ssh task',
      status: 'completed',
      dependencies: [],
      createdAt: new Date(),
      config: { command: 'echo hi', runnerKind: 'ssh', poolMemberId: 'crab-target' },
      execution: {
        generation: 0,
        workspacePath: '~/.invoker/worktrees/abc/experiment-crab',
        branch: 'experiment/crab',
        remoteLeaseMetadata: { ...LEASE_METADATA },
      },
    } as unknown as TaskState);

    // Surface 3a: the lease metadata is durably persisted by the SQLite layer.
    expect(adapter.getRemoteLeaseMetadata('wf-crab/ssh-task')).toMatchObject({
      provider: 'crabbox',
      leaseId: 'lease-xyz',
      targetId: 'crab-target',
    });

    // Static config still names this a crabbox target (open-terminal looks it up).
    vi.spyOn(configModule, 'loadConfig').mockReturnValue({
      remoteTargets: { 'crab-target': { ...CRABBOX_TARGET } },
    } as any);

    // Fake `crabbox status` — refreshes the lease to a *live* endpoint.
    const crabboxCommandRunner = vi.fn(async () => ({
      stdout: JSON.stringify({
        id: 'lease-xyz',
        status: 'ready',
        sshHost: 'box-42.crabbox.dev',
        sshUser: 'crab',
        sshPort: 2200,
        sshKey: '/tmp/crab_key',
      }),
      stderr: '',
      exitCode: 0,
    }));

    const result = await openExternalTerminalForTask({
      taskId: 'wf-crab/ssh-task',
      persistence: adapter as any,
      executorRegistry: new ExecutorRegistry(),
      repoRoot: '/repo',
      crabboxCommandRunner,
    });

    // Surface 3b: terminal restore read the persisted lease and refreshed it
    // (no --wait), then opened an SSH terminal to the refreshed box.
    expect(result.opened).toBe(true);
    expect(crabboxCommandRunner).toHaveBeenCalledTimes(1);
    const [cmd, statusArgs] = crabboxCommandRunner.mock.calls[0];
    expect(cmd).toBe('crabbox');
    expect(statusArgs).toEqual(expect.arrayContaining(['status', '--id', 'lease-xyz', '--json']));
    expect(statusArgs).not.toContain('--wait');

    const spawned = vi.mocked(spawnDetachedTerminal).mock.calls[0];
    const spawnedArgs = JSON.stringify(spawned?.[1]);
    expect(spawnedArgs).toContain('box-42.crabbox.dev');
    expect(spawnedArgs).toContain('experiment/crab');

    adapter.close?.();
  });
});

// ── 4: cleanup policy — keep on failure, stop on success ──────

describe('Crabbox SSH: cleanup policy after task completion', () => {
  async function cleanupContextFor(runner: TaskRunner, task: TaskState) {
    await (runner as any).resolveCrabboxIfNeeded(task);
    return (runner as any).crabboxCleanupContextForTask(task);
  }

  it('does NOT stop the box on failure when keepOnFailure is true', async () => {
    const { runner, stopper } = makeRunner();
    const task = crabboxSshTask('wf-crab/fail');
    const ctx = await cleanupContextFor(runner, task);

    await (runner as any).maybeCleanupCrabboxLease(task.id, ctx, {
      status: 'failed',
      outputs: { exitCode: 1 },
    });

    expect(stopper).not.toHaveBeenCalled();
  });

  it('stops the box on success under the default policy', async () => {
    const { runner, stopper } = makeRunner();
    const task = crabboxSshTask('wf-crab/ok');
    const ctx = await cleanupContextFor(runner, task);

    await (runner as any).maybeCleanupCrabboxLease(task.id, ctx, {
      status: 'completed',
      outputs: { exitCode: 0 },
    });

    expect(stopper).toHaveBeenCalledTimes(1);
    expect(stopper.mock.calls[0][1]).toBe('lease-xyz');
  });
});
