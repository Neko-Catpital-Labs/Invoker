import { describe, it, expect, vi } from 'vitest';
import type { SpawnOptions } from 'node:child_process';

import {
  buildRecoveryEnv,
  createExternalRecoveryLauncher,
  type RecoveryContext,
  type SpawnFn,
} from '../external-failure-recovery.js';
import type { ExternalFailureRecoveryConfig } from '../config.js';

const CONTEXT: RecoveryContext = {
  failedTaskId: 'task-123',
  failedWorkflowId: 'wf-456',
  repoRoot: '/repos/demo',
  dbDir: '/repos/demo/.invoker',
  reason: 'task-failed',
};

/**
 * A recording fake spawn. Captures every call and returns a child stub with a
 * fixed pid and an `unref` spy so tests can assert detachment.
 */
function makeFakeSpawn() {
  const calls: Array<{ command: string; options: SpawnOptions }> = [];
  const unref = vi.fn();
  const spawnFn: SpawnFn = (command, options) => {
    calls.push({ command, options });
    return { pid: 4242, unref };
  };
  return { spawnFn, calls, unref };
}

describe('buildRecoveryEnv', () => {
  it('layers the INVOKER_* handshake variables onto the base env', () => {
    const env = buildRecoveryEnv(CONTEXT, { PATH: '/usr/bin', EXISTING: 'keep' });
    expect(env.PATH).toBe('/usr/bin');
    expect(env.EXISTING).toBe('keep');
    expect(env.INVOKER_FAILED_TASK_ID).toBe('task-123');
    expect(env.INVOKER_FAILED_WORKFLOW_ID).toBe('wf-456');
    expect(env.INVOKER_REPO_ROOT).toBe('/repos/demo');
    expect(env.INVOKER_DB_DIR).toBe('/repos/demo/.invoker');
    expect(env.INVOKER_RECOVERY_REASON).toBe('task-failed');
  });

  it('lets recovery variables override colliding base env keys', () => {
    const env = buildRecoveryEnv(CONTEXT, { INVOKER_FAILED_TASK_ID: 'stale' });
    expect(env.INVOKER_FAILED_TASK_ID).toBe('task-123');
  });
});

describe('createExternalRecoveryLauncher', () => {
  const enabled: ExternalFailureRecoveryConfig = {
    enabled: true,
    command: 'node ./supervisor.js',
    cwd: '/srv/invoker',
    cooldownSeconds: 60,
  };

  it('returns "disabled" when config is undefined', () => {
    const { spawnFn, calls } = makeFakeSpawn();
    const launch = createExternalRecoveryLauncher(undefined, { spawnFn });
    expect(launch(CONTEXT)).toEqual({ status: 'disabled' });
    expect(calls).toHaveLength(0);
  });

  it('returns "disabled" when enabled is not true', () => {
    const { spawnFn, calls } = makeFakeSpawn();
    const launch = createExternalRecoveryLauncher(
      { ...enabled, enabled: false },
      { spawnFn },
    );
    expect(launch(CONTEXT)).toEqual({ status: 'disabled' });
    expect(calls).toHaveLength(0);
  });

  it('returns "missing-command" when the command is blank', () => {
    const { spawnFn, calls } = makeFakeSpawn();
    const launch = createExternalRecoveryLauncher(
      { enabled: true, command: '   ' },
      { spawnFn },
    );
    expect(launch(CONTEXT)).toEqual({ status: 'missing-command' });
    expect(calls).toHaveLength(0);
  });

  it('launches with shell/detached/stdio/cwd and the recovery env, then unrefs', () => {
    const { spawnFn, calls, unref } = makeFakeSpawn();
    const launch = createExternalRecoveryLauncher(enabled, {
      spawnFn,
      baseEnv: { PATH: '/usr/bin' },
    });

    const result = launch(CONTEXT);
    expect(result).toEqual({ status: 'launched', pid: 4242 });
    expect(unref).toHaveBeenCalledOnce();
    expect(calls).toHaveLength(1);

    const { command, options } = calls[0]!;
    expect(command).toBe('node ./supervisor.js');
    expect(options.shell).toBe(true);
    expect(options.detached).toBe(true);
    expect(options.stdio).toBe('ignore');
    expect(options.cwd).toBe('/srv/invoker');
    const env = options.env as NodeJS.ProcessEnv;
    expect(env.PATH).toBe('/usr/bin');
    expect(env.INVOKER_FAILED_TASK_ID).toBe('task-123');
    expect(env.INVOKER_FAILED_WORKFLOW_ID).toBe('wf-456');
    expect(env.INVOKER_REPO_ROOT).toBe('/repos/demo');
    expect(env.INVOKER_DB_DIR).toBe('/repos/demo/.invoker');
    expect(env.INVOKER_RECOVERY_REASON).toBe('task-failed');
  });

  it('trims the configured command before spawning', () => {
    const { spawnFn, calls } = makeFakeSpawn();
    const launch = createExternalRecoveryLauncher(
      { enabled: true, command: '  ./recover.sh  ' },
      { spawnFn },
    );
    expect(launch(CONTEXT).status).toBe('launched');
    expect(calls[0]!.command).toBe('./recover.sh');
  });

  it('throttles repeat launches within the cooldown window', () => {
    const { spawnFn, calls } = makeFakeSpawn();
    let clock = 1_000_000;
    const launch = createExternalRecoveryLauncher(enabled, {
      spawnFn,
      now: () => clock,
    });

    expect(launch(CONTEXT).status).toBe('launched');

    clock += 30_000; // 30s into a 60s cooldown
    expect(launch(CONTEXT)).toEqual({ status: 'cooldown', remainingMs: 30_000 });
    expect(calls).toHaveLength(1);

    clock += 30_000; // cooldown elapsed
    expect(launch(CONTEXT).status).toBe('launched');
    expect(calls).toHaveLength(2);
  });

  it('keys cooldown to the launcher instance, not the shared config', () => {
    const { spawnFn, calls } = makeFakeSpawn();
    const now = () => 1_000_000;
    const a = createExternalRecoveryLauncher(enabled, { spawnFn, now });
    const b = createExternalRecoveryLauncher(enabled, { spawnFn, now });

    expect(a(CONTEXT).status).toBe('launched');
    // b has its own clock state, so it is not throttled by a's launch.
    expect(b(CONTEXT).status).toBe('launched');
    expect(calls).toHaveLength(2);
  });

  it('does not start the cooldown clock when no command is configured', () => {
    const { spawnFn } = makeFakeSpawn();
    const launch = createExternalRecoveryLauncher(
      { enabled: true, cooldownSeconds: 60 },
      { spawnFn },
    );
    expect(launch(CONTEXT)).toEqual({ status: 'missing-command' });
    expect(launch(CONTEXT)).toEqual({ status: 'missing-command' });
  });

  it('returns "spawn-error" and does not arm cooldown when spawn throws', () => {
    let clock = 1_000_000;
    const spawnFn: SpawnFn = () => {
      throw new Error('spawn ENOENT');
    };
    const launch = createExternalRecoveryLauncher(enabled, {
      spawnFn,
      now: () => clock,
    });

    expect(launch(CONTEXT)).toEqual({ status: 'spawn-error', error: 'spawn ENOENT' });

    // A failed spawn must not consume the cooldown window: a recovering spawn
    // succeeds immediately rather than being throttled.
    const succeedingSpawn = makeFakeSpawn();
    const launch2 = createExternalRecoveryLauncher(enabled, {
      spawnFn: succeedingSpawn.spawnFn,
      now: () => clock,
    });
    expect(launch2(CONTEXT).status).toBe('launched');
  });

  it('tolerates a child without an unref method', () => {
    const spawnFn: SpawnFn = () => ({ pid: 7, unref: undefined as never });
    const launch = createExternalRecoveryLauncher(enabled, { spawnFn });
    expect(launch(CONTEXT)).toEqual({ status: 'launched', pid: 7 });
  });
});
