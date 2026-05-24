import { describe, it, expect, vi } from 'vitest';
import {
  ExternalFailureRecoveryLauncher,
  buildRecoveryEnv,
  type RecoverySpawnFn,
} from '../external-failure-recovery.js';
import type { InvokerConfig } from '../config.js';

const sampleContext = {
  failedTaskId: 'task_abc',
  failedWorkflowId: 'wf_123',
  repoRoot: '/repo/root',
  dbDir: '/repo/root/.invoker/db',
};

function fakeSpawn(): {
  fn: RecoverySpawnFn;
  calls: Array<{ command: string; args: readonly string[]; options: Record<string, unknown> }>;
} {
  const calls: Array<{ command: string; args: readonly string[]; options: Record<string, unknown> }> = [];
  const unref = vi.fn();
  const fn: RecoverySpawnFn = (command, args, options) => {
    calls.push({ command, args, options: options as Record<string, unknown> });
    return { unref };
  };
  return { fn, calls };
}

describe('buildRecoveryEnv', () => {
  it('sets the documented INVOKER_* variables exactly', () => {
    const env = buildRecoveryEnv(sampleContext);
    expect(env.INVOKER_FAILED_TASK_ID).toBe('task_abc');
    expect(env.INVOKER_FAILED_WORKFLOW_ID).toBe('wf_123');
    expect(env.INVOKER_REPO_ROOT).toBe('/repo/root');
    expect(env.INVOKER_DB_DIR).toBe('/repo/root/.invoker/db');
    expect(env.INVOKER_RECOVERY_REASON).toBe('task_failed');
  });

  it('layers recovery vars on top of the supplied base env without losing inherited keys', () => {
    const env = buildRecoveryEnv(sampleContext, 'task_failed', { PATH: '/usr/bin', HOME: '/tmp/h' });
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/tmp/h');
    expect(env.INVOKER_FAILED_TASK_ID).toBe('task_abc');
  });

  it('lets recovery vars override conflicting base env keys', () => {
    const env = buildRecoveryEnv(sampleContext, 'task_failed', {
      INVOKER_FAILED_TASK_ID: 'stale',
      INVOKER_RECOVERY_REASON: 'stale',
    });
    expect(env.INVOKER_FAILED_TASK_ID).toBe('task_abc');
    expect(env.INVOKER_RECOVERY_REASON).toBe('task_failed');
  });
});

describe('ExternalFailureRecoveryLauncher.launch', () => {
  it('is disabled when the config block is missing', () => {
    const spawn = fakeSpawn();
    const launcher = new ExternalFailureRecoveryLauncher({ now: () => 1000, spawnFn: spawn.fn });
    const result = launcher.launch({} as InvokerConfig, sampleContext);
    expect(result).toEqual({ launched: false, reason: 'disabled' });
    expect(spawn.calls).toHaveLength(0);
  });

  it('is disabled when enabled is false', () => {
    const spawn = fakeSpawn();
    const launcher = new ExternalFailureRecoveryLauncher({ now: () => 1000, spawnFn: spawn.fn });
    const config: InvokerConfig = {
      externalFailureRecovery: { enabled: false, command: '/bin/recover' },
    };
    const result = launcher.launch(config, sampleContext);
    expect(result).toEqual({ launched: false, reason: 'disabled' });
    expect(spawn.calls).toHaveLength(0);
  });

  it('skips when the command is missing or blank', () => {
    const spawn = fakeSpawn();
    const launcher = new ExternalFailureRecoveryLauncher({ now: () => 1000, spawnFn: spawn.fn });
    const config: InvokerConfig = {
      externalFailureRecovery: { enabled: true, command: '   ' },
    };
    const result = launcher.launch(config, sampleContext);
    expect(result).toEqual({ launched: false, reason: 'missing_command' });
    expect(spawn.calls).toHaveLength(0);
  });

  it('spawns the configured command with the recovery env and cwd when enabled', () => {
    const spawn = fakeSpawn();
    const launcher = new ExternalFailureRecoveryLauncher({ now: () => 1000, spawnFn: spawn.fn });
    const config: InvokerConfig = {
      externalFailureRecovery: {
        enabled: true,
        command: '/usr/local/bin/recover.sh',
        cwd: '/var/invoker',
      },
    };
    const result = launcher.launch(config, sampleContext, 'task_failed', { PATH: '/usr/bin' });
    expect(result).toEqual({ launched: true });
    expect(spawn.calls).toHaveLength(1);
    const call = spawn.calls[0]!;
    expect(call.command).toBe('/usr/local/bin/recover.sh');
    expect(call.args).toEqual([]);
    expect(call.options.cwd).toBe('/var/invoker');
    expect(call.options.detached).toBe(true);
    expect(call.options.stdio).toBe('ignore');
    const env = call.options.env as NodeJS.ProcessEnv;
    expect(env.INVOKER_FAILED_TASK_ID).toBe('task_abc');
    expect(env.INVOKER_FAILED_WORKFLOW_ID).toBe('wf_123');
    expect(env.INVOKER_REPO_ROOT).toBe('/repo/root');
    expect(env.INVOKER_DB_DIR).toBe('/repo/root/.invoker/db');
    expect(env.INVOKER_RECOVERY_REASON).toBe('task_failed');
    expect(env.PATH).toBe('/usr/bin');
  });

  it('skips the second launch when within the cooldown window', () => {
    const spawn = fakeSpawn();
    let current = 1000;
    const launcher = new ExternalFailureRecoveryLauncher({
      now: () => current,
      spawnFn: spawn.fn,
    });
    const config: InvokerConfig = {
      externalFailureRecovery: {
        enabled: true,
        command: '/bin/recover',
        cooldownSeconds: 30,
      },
    };
    const first = launcher.launch(config, sampleContext);
    expect(first).toEqual({ launched: true });
    current += 5_000;
    const second = launcher.launch(config, sampleContext);
    expect(second.launched).toBe(false);
    expect(second).toMatchObject({ reason: 'cooldown' });
    expect(spawn.calls).toHaveLength(1);
  });

  it('allows a second launch after the cooldown elapses', () => {
    const spawn = fakeSpawn();
    let current = 1000;
    const launcher = new ExternalFailureRecoveryLauncher({
      now: () => current,
      spawnFn: spawn.fn,
    });
    const config: InvokerConfig = {
      externalFailureRecovery: {
        enabled: true,
        command: '/bin/recover',
        cooldownSeconds: 30,
      },
    };
    expect(launcher.launch(config, sampleContext)).toEqual({ launched: true });
    current += 30_001;
    expect(launcher.launch(config, sampleContext)).toEqual({ launched: true });
    expect(spawn.calls).toHaveLength(2);
  });

  it('does not enforce a cooldown when cooldownSeconds is omitted or zero', () => {
    const spawn = fakeSpawn();
    const launcher = new ExternalFailureRecoveryLauncher({ now: () => 1000, spawnFn: spawn.fn });
    const config: InvokerConfig = {
      externalFailureRecovery: { enabled: true, command: '/bin/recover' },
    };
    expect(launcher.launch(config, sampleContext)).toEqual({ launched: true });
    expect(launcher.launch(config, sampleContext)).toEqual({ launched: true });
    expect(spawn.calls).toHaveLength(2);
  });

  it('reports spawn errors without updating the cooldown timestamp', () => {
    const spawn: RecoverySpawnFn = () => {
      throw new Error('ENOENT: recover');
    };
    let current = 1000;
    const launcher = new ExternalFailureRecoveryLauncher({
      now: () => current,
      spawnFn: spawn,
    });
    const config: InvokerConfig = {
      externalFailureRecovery: {
        enabled: true,
        command: '/bin/recover',
        cooldownSeconds: 60,
      },
    };
    const failed = launcher.launch(config, sampleContext);
    expect(failed.launched).toBe(false);
    expect(failed).toMatchObject({ reason: 'spawn_error' });
    const okSpawn = fakeSpawn();
    const recovered = new ExternalFailureRecoveryLauncher({
      now: () => current,
      spawnFn: okSpawn.fn,
    });
    expect(recovered.launch(config, sampleContext)).toEqual({ launched: true });
  });
});
