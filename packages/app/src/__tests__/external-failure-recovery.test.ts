import { describe, expect, it, vi } from 'vitest';

import {
  buildRecoveryEnv,
  createExternalFailureRecoveryLauncher,
  type ExternalFailureRecoveryContext,
  type LaunchOptions,
} from '../external-failure-recovery.js';

const context: ExternalFailureRecoveryContext = {
  failedTaskId: 'task-42',
  failedWorkflowId: 'wf-7',
  repoRoot: '/home/op/repo',
  dbDir: '/home/op/.invoker/db',
};

describe('buildRecoveryEnv', () => {
  it('sets the exact INVOKER_* env vars and preserves the base env', () => {
    const env = buildRecoveryEnv(context, { PATH: '/usr/bin', EXISTING: 'kept' });
    expect(env.INVOKER_FAILED_TASK_ID).toBe('task-42');
    expect(env.INVOKER_FAILED_WORKFLOW_ID).toBe('wf-7');
    expect(env.INVOKER_REPO_ROOT).toBe('/home/op/repo');
    expect(env.INVOKER_DB_DIR).toBe('/home/op/.invoker/db');
    expect(env.INVOKER_RECOVERY_REASON).toBe('task_failed');
    expect(env.PATH).toBe('/usr/bin');
    expect(env.EXISTING).toBe('kept');
  });

  it('overrides any conflicting INVOKER_* keys present in the base env', () => {
    const env = buildRecoveryEnv(context, {
      INVOKER_FAILED_TASK_ID: 'stale',
      INVOKER_RECOVERY_REASON: 'stale',
    });
    expect(env.INVOKER_FAILED_TASK_ID).toBe('task-42');
    expect(env.INVOKER_RECOVERY_REASON).toBe('task_failed');
  });
});

describe('createExternalFailureRecoveryLauncher', () => {
  it('skips with reason=disabled when config is undefined', () => {
    const launch = vi.fn();
    const launcher = createExternalFailureRecoveryLauncher(undefined, { launch });
    expect(launcher.trigger(context)).toEqual({ launched: false, reason: 'disabled' });
    expect(launch).not.toHaveBeenCalled();
  });

  it('skips with reason=disabled when enabled is false', () => {
    const launch = vi.fn();
    const launcher = createExternalFailureRecoveryLauncher(
      { enabled: false, command: '/usr/bin/recover.sh' },
      { launch },
    );
    expect(launcher.trigger(context)).toEqual({ launched: false, reason: 'disabled' });
    expect(launch).not.toHaveBeenCalled();
  });

  it('skips with reason=disabled when enabled is omitted', () => {
    const launch = vi.fn();
    const launcher = createExternalFailureRecoveryLauncher(
      { command: '/usr/bin/recover.sh' },
      { launch },
    );
    expect(launcher.trigger(context)).toEqual({ launched: false, reason: 'disabled' });
    expect(launch).not.toHaveBeenCalled();
  });

  it('skips with reason=no_command when command is missing', () => {
    const launch = vi.fn();
    const launcher = createExternalFailureRecoveryLauncher(
      { enabled: true },
      { launch },
    );
    expect(launcher.trigger(context)).toEqual({ launched: false, reason: 'no_command' });
    expect(launch).not.toHaveBeenCalled();
  });

  it('skips with reason=no_command when command is whitespace-only', () => {
    const launch = vi.fn();
    const launcher = createExternalFailureRecoveryLauncher(
      { enabled: true, command: '   ' },
      { launch },
    );
    expect(launcher.trigger(context)).toEqual({ launched: false, reason: 'no_command' });
    expect(launch).not.toHaveBeenCalled();
  });

  it('launches with the configured command, cwd, and recovery env', () => {
    const launch = vi.fn<(options: LaunchOptions) => void>();
    const launcher = createExternalFailureRecoveryLauncher(
      {
        enabled: true,
        command: '  /usr/bin/recover.sh --tag prod  ',
        cwd: '/work',
      },
      { launch, baseEnv: { PATH: '/usr/bin' } },
    );

    expect(launcher.trigger(context)).toEqual({ launched: true });
    expect(launch).toHaveBeenCalledOnce();

    const options = launch.mock.calls[0]![0];
    expect(options.command).toBe('/usr/bin/recover.sh --tag prod');
    expect(options.cwd).toBe('/work');
    expect(options.env).toEqual({
      PATH: '/usr/bin',
      INVOKER_FAILED_TASK_ID: 'task-42',
      INVOKER_FAILED_WORKFLOW_ID: 'wf-7',
      INVOKER_REPO_ROOT: '/home/op/repo',
      INVOKER_DB_DIR: '/home/op/.invoker/db',
      INVOKER_RECOVERY_REASON: 'task_failed',
    });
  });

  it('omits cwd when none is configured', () => {
    const launch = vi.fn<(options: LaunchOptions) => void>();
    const launcher = createExternalFailureRecoveryLauncher(
      { enabled: true, command: 'recover.sh' },
      { launch, baseEnv: {} },
    );
    launcher.trigger(context);
    expect(launch.mock.calls[0]![0].cwd).toBeUndefined();
  });

  it('skips while inside the cooldown window then re-launches afterwards', () => {
    let nowMs = 1_000_000;
    const launch = vi.fn<(options: LaunchOptions) => void>();
    const launcher = createExternalFailureRecoveryLauncher(
      { enabled: true, command: 'recover.sh', cooldownSeconds: 30 },
      { launch, now: () => nowMs },
    );

    expect(launcher.trigger(context)).toEqual({ launched: true });
    expect(launch).toHaveBeenCalledTimes(1);

    nowMs += 5_000;
    expect(launcher.trigger(context)).toEqual({ launched: false, reason: 'cooldown' });
    expect(launch).toHaveBeenCalledTimes(1);

    nowMs += 24_999;
    expect(launcher.trigger(context)).toEqual({ launched: false, reason: 'cooldown' });
    expect(launch).toHaveBeenCalledTimes(1);

    nowMs += 1;
    expect(launcher.trigger(context)).toEqual({ launched: true });
    expect(launch).toHaveBeenCalledTimes(2);
  });

  it('treats zero cooldown as immediate re-launch', () => {
    let nowMs = 0;
    const launch = vi.fn<(options: LaunchOptions) => void>();
    const launcher = createExternalFailureRecoveryLauncher(
      { enabled: true, command: 'recover.sh', cooldownSeconds: 0 },
      { launch, now: () => nowMs },
    );
    expect(launcher.trigger(context)).toEqual({ launched: true });
    expect(launcher.trigger(context)).toEqual({ launched: true });
    expect(launch).toHaveBeenCalledTimes(2);
  });

  it('only starts the cooldown clock after a successful launch', () => {
    let nowMs = 100;
    const launch = vi.fn<(options: LaunchOptions) => void>();
    const launcher = createExternalFailureRecoveryLauncher(
      { enabled: false, command: 'recover.sh', cooldownSeconds: 60 },
      { launch, now: () => nowMs },
    );

    // Disabled call must not arm the cooldown.
    expect(launcher.trigger(context)).toEqual({ launched: false, reason: 'disabled' });

    // Re-create with enabled config; first trigger should launch immediately.
    const enabledLauncher = createExternalFailureRecoveryLauncher(
      { enabled: true, command: 'recover.sh', cooldownSeconds: 60 },
      { launch, now: () => nowMs },
    );
    expect(enabledLauncher.trigger(context)).toEqual({ launched: true });
    expect(launch).toHaveBeenCalledTimes(1);

    nowMs += 30_000;
    expect(enabledLauncher.trigger(context)).toEqual({
      launched: false,
      reason: 'cooldown',
    });
  });
});
