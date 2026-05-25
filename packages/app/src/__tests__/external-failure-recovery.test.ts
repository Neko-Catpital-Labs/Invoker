import { describe, it, expect, vi } from 'vitest';
import {
  ExternalFailureRecoveryLauncher,
  buildRecoveryEnv,
  type ExternalFailureRecoveryContext,
  type SpawnFn,
} from '../external-failure-recovery.js';
import type { InvokerConfig } from '../config.js';

const context: ExternalFailureRecoveryContext = {
  failedTaskId: 'task-abc',
  failedWorkflowId: 'wf-123',
  repoRoot: '/repo/root',
  dbDir: '/db/dir',
};

function makeSpawnSpy(): { fn: SpawnFn; calls: Parameters<SpawnFn>[] } {
  const calls: Parameters<SpawnFn>[] = [];
  const fn: SpawnFn = (command, args, options) => {
    calls.push([command, args, options]);
    return { pid: 4242, unref: () => {} };
  };
  return { fn, calls };
}

describe('buildRecoveryEnv', () => {
  it('produces exactly the documented INVOKER_* variables with task_failed reason', () => {
    expect(buildRecoveryEnv(context)).toEqual({
      INVOKER_FAILED_TASK_ID: 'task-abc',
      INVOKER_FAILED_WORKFLOW_ID: 'wf-123',
      INVOKER_REPO_ROOT: '/repo/root',
      INVOKER_DB_DIR: '/db/dir',
      INVOKER_RECOVERY_REASON: 'task_failed',
    });
  });
});

describe('ExternalFailureRecoveryLauncher', () => {
  it('skips when externalFailureRecovery is not configured', () => {
    const spy = makeSpawnSpy();
    const launcher = new ExternalFailureRecoveryLauncher({
      now: () => 0,
      spawn: spy.fn,
    });
    const result = launcher.launch({}, context);
    expect(result).toEqual({ launched: false, reason: 'no_config' });
    expect(spy.calls).toEqual([]);
  });

  it('skips when enabled is false', () => {
    const spy = makeSpawnSpy();
    const launcher = new ExternalFailureRecoveryLauncher({
      now: () => 0,
      spawn: spy.fn,
    });
    const config: InvokerConfig = {
      externalFailureRecovery: { enabled: false, command: '/usr/local/bin/recover.sh' },
    };
    const result = launcher.launch(config, context);
    expect(result).toEqual({ launched: false, reason: 'disabled' });
    expect(spy.calls).toEqual([]);
  });

  it('skips when command is empty or whitespace-only', () => {
    const spy = makeSpawnSpy();
    const launcher = new ExternalFailureRecoveryLauncher({
      now: () => 0,
      spawn: spy.fn,
    });
    expect(
      launcher.launch(
        { externalFailureRecovery: { enabled: true, command: '' } },
        context,
      ),
    ).toEqual({ launched: false, reason: 'empty_command' });
    expect(
      launcher.launch(
        { externalFailureRecovery: { enabled: true, command: '   ' } },
        context,
      ),
    ).toEqual({ launched: false, reason: 'empty_command' });
    expect(spy.calls).toEqual([]);
  });

  it('launches the configured command with INVOKER_* env vars and cwd', () => {
    const spy = makeSpawnSpy();
    const launcher = new ExternalFailureRecoveryLauncher({
      now: () => 1_000,
      spawn: spy.fn,
    });
    const config: InvokerConfig = {
      externalFailureRecovery: {
        enabled: true,
        command: '/opt/recover.sh',
        cwd: '/work/cwd',
      },
    };
    const result = launcher.launch(config, context);
    expect(result).toEqual({ launched: true, pid: 4242 });
    expect(spy.calls).toHaveLength(1);
    const [command, args, options] = spy.calls[0]!;
    expect(command).toBe('/opt/recover.sh');
    expect(args).toEqual([]);
    expect(options.cwd).toBe('/work/cwd');
    expect(options.detached).toBe(true);
    expect(options.stdio).toBe('ignore');
    expect(options.env).toMatchObject({
      INVOKER_FAILED_TASK_ID: 'task-abc',
      INVOKER_FAILED_WORKFLOW_ID: 'wf-123',
      INVOKER_REPO_ROOT: '/repo/root',
      INVOKER_DB_DIR: '/db/dir',
      INVOKER_RECOVERY_REASON: 'task_failed',
    });
  });

  it('omits cwd from spawn options when not configured', () => {
    const spy = makeSpawnSpy();
    const launcher = new ExternalFailureRecoveryLauncher({
      now: () => 1_000,
      spawn: spy.fn,
    });
    const config: InvokerConfig = {
      externalFailureRecovery: { enabled: true, command: '/opt/recover.sh' },
    };
    launcher.launch(config, context);
    expect(spy.calls[0]![2].cwd).toBeUndefined();
  });

  it('skips subsequent launches inside the cooldown window', () => {
    const spy = makeSpawnSpy();
    let now = 10_000;
    const launcher = new ExternalFailureRecoveryLauncher({
      now: () => now,
      spawn: spy.fn,
    });
    const config: InvokerConfig = {
      externalFailureRecovery: {
        enabled: true,
        command: '/opt/recover.sh',
        cooldownSeconds: 30,
      },
    };

    expect(launcher.launch(config, context)).toEqual({ launched: true, pid: 4242 });
    expect(spy.calls).toHaveLength(1);

    now += 5_000;
    expect(launcher.launch(config, context)).toEqual({
      launched: false,
      reason: 'cooldown',
    });
    expect(spy.calls).toHaveLength(1);

    now = 10_000 + 29_999;
    expect(launcher.launch(config, context)).toEqual({
      launched: false,
      reason: 'cooldown',
    });
    expect(spy.calls).toHaveLength(1);

    now = 10_000 + 30_000;
    expect(launcher.launch(config, context)).toEqual({ launched: true, pid: 4242 });
    expect(spy.calls).toHaveLength(2);
  });

  it('does not enforce cooldown when cooldownSeconds is unset or <= 0', () => {
    const spy = makeSpawnSpy();
    let now = 10_000;
    const launcher = new ExternalFailureRecoveryLauncher({
      now: () => now,
      spawn: spy.fn,
    });
    const config: InvokerConfig = {
      externalFailureRecovery: { enabled: true, command: '/opt/recover.sh' },
    };
    expect(launcher.launch(config, context).launched).toBe(true);
    now += 1;
    expect(launcher.launch(config, context).launched).toBe(true);
    expect(spy.calls).toHaveLength(2);

    const zeroConfig: InvokerConfig = {
      externalFailureRecovery: {
        enabled: true,
        command: '/opt/recover.sh',
        cooldownSeconds: 0,
      },
    };
    expect(launcher.launch(zeroConfig, context).launched).toBe(true);
    expect(spy.calls).toHaveLength(3);
  });

  it('calls unref so the parent process is not held open by the child', () => {
    const unref = vi.fn();
    const calls: Parameters<SpawnFn>[] = [];
    const spawnFn: SpawnFn = (command, args, options) => {
      calls.push([command, args, options]);
      return { pid: 1, unref };
    };
    const launcher = new ExternalFailureRecoveryLauncher({ now: () => 0, spawn: spawnFn });
    launcher.launch(
      { externalFailureRecovery: { enabled: true, command: '/opt/recover.sh' } },
      context,
    );
    expect(unref).toHaveBeenCalledOnce();
  });
});
