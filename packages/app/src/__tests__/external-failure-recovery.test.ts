import { describe, it, expect } from 'vitest';
import {
  buildRecoveryEnv,
  ExternalFailureRecoveryLauncher,
  type FailureRecoveryContext,
  type ProcessLauncher,
} from '../external-failure-recovery.js';
import type { ExternalFailureRecoveryConfig } from '../config.js';

const CONTEXT: FailureRecoveryContext = {
  failedTaskId: 'task-123',
  failedWorkflowId: 'wf-456',
  repoRoot: '/repo/root',
  dbDir: '/repo/.invoker/db',
};

function makeLauncher(opts: {
  now?: () => number;
  launchProcess?: ProcessLauncher;
  baseEnv?: NodeJS.ProcessEnv;
} = {}) {
  const calls: Array<{ command: string; cwd?: string; env: NodeJS.ProcessEnv }> = [];
  const launchProcess: ProcessLauncher =
    opts.launchProcess ??
    ((command, options) => {
      calls.push({ command, cwd: options.cwd, env: options.env });
    });
  const launcher = new ExternalFailureRecoveryLauncher({
    now: opts.now ?? (() => 0),
    launchProcess,
    baseEnv: opts.baseEnv ?? {},
  });
  return { launcher, calls };
}

describe('buildRecoveryEnv', () => {
  it('sets the exact recovery env var contract', () => {
    const env = buildRecoveryEnv(CONTEXT, {});
    expect(env).toEqual({
      INVOKER_FAILED_TASK_ID: 'task-123',
      INVOKER_FAILED_WORKFLOW_ID: 'wf-456',
      INVOKER_REPO_ROOT: '/repo/root',
      INVOKER_DB_DIR: '/repo/.invoker/db',
      INVOKER_RECOVERY_REASON: 'task_failed',
    });
  });

  it('preserves the base environment and pins the recovery reason', () => {
    const env = buildRecoveryEnv(CONTEXT, {
      PATH: '/usr/bin',
      INVOKER_RECOVERY_REASON: 'should-be-overwritten',
    });
    expect(env.PATH).toBe('/usr/bin');
    expect(env.INVOKER_RECOVERY_REASON).toBe('task_failed');
  });
});

describe('ExternalFailureRecoveryLauncher config shape', () => {
  it('passes the configured command, cwd, and recovery env to the launcher', () => {
    const { launcher, calls } = makeLauncher({ baseEnv: { HOME: '/home/op' } });
    const config: ExternalFailureRecoveryConfig = {
      enabled: true,
      command: '/opt/supervisor.sh --recover',
      cwd: '/opt/work',
    };

    const result = launcher.tryLaunch(config, CONTEXT);

    expect(result).toEqual({ launched: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe('/opt/supervisor.sh --recover');
    expect(calls[0]?.cwd).toBe('/opt/work');
    expect(calls[0]?.env).toMatchObject({
      HOME: '/home/op',
      INVOKER_FAILED_TASK_ID: 'task-123',
      INVOKER_FAILED_WORKFLOW_ID: 'wf-456',
      INVOKER_REPO_ROOT: '/repo/root',
      INVOKER_DB_DIR: '/repo/.invoker/db',
      INVOKER_RECOVERY_REASON: 'task_failed',
    });
  });

  it('falls back to the repo root when no cwd is configured', () => {
    const { launcher, calls } = makeLauncher();
    launcher.tryLaunch({ enabled: true, command: 'recover.sh' }, CONTEXT);
    expect(calls[0]?.cwd).toBe('/repo/root');
  });
});

describe('ExternalFailureRecoveryLauncher disabled behavior', () => {
  it('does not launch when config is undefined', () => {
    const { launcher, calls } = makeLauncher();
    const result = launcher.tryLaunch(undefined, CONTEXT);
    expect(result).toEqual({ launched: false, reason: 'disabled' });
    expect(calls).toHaveLength(0);
  });

  it('does not launch when enabled is false', () => {
    const { launcher, calls } = makeLauncher();
    const result = launcher.tryLaunch(
      { enabled: false, command: 'recover.sh' },
      CONTEXT,
    );
    expect(result).toEqual({ launched: false, reason: 'disabled' });
    expect(calls).toHaveLength(0);
  });

  it('does not launch when enabled is omitted', () => {
    const { launcher, calls } = makeLauncher();
    const result = launcher.tryLaunch(
      { command: 'recover.sh' } as ExternalFailureRecoveryConfig,
      CONTEXT,
    );
    expect(result).toEqual({ launched: false, reason: 'disabled' });
    expect(calls).toHaveLength(0);
  });
});

describe('ExternalFailureRecoveryLauncher missing-command skip', () => {
  it('skips an empty command even when enabled', () => {
    const { launcher, calls } = makeLauncher();
    const result = launcher.tryLaunch({ enabled: true, command: '' }, CONTEXT);
    expect(result).toEqual({ launched: false, reason: 'no-command' });
    expect(calls).toHaveLength(0);
  });

  it('skips a whitespace-only command', () => {
    const { launcher, calls } = makeLauncher();
    const result = launcher.tryLaunch(
      { enabled: true, command: '   ' },
      CONTEXT,
    );
    expect(result).toEqual({ launched: false, reason: 'no-command' });
    expect(calls).toHaveLength(0);
  });
});

describe('ExternalFailureRecoveryLauncher cooldown skip behavior', () => {
  it('skips a launch that arrives before the cooldown elapses', () => {
    let now = 1_000;
    const { launcher, calls } = makeLauncher({ now: () => now });
    const config: ExternalFailureRecoveryConfig = {
      enabled: true,
      command: 'recover.sh',
      cooldownSeconds: 60,
    };

    expect(launcher.tryLaunch(config, CONTEXT)).toEqual({ launched: true });

    // 30s later — still inside the 60s cooldown.
    now += 30_000;
    expect(launcher.tryLaunch(config, CONTEXT)).toEqual({
      launched: false,
      reason: 'cooldown',
    });

    expect(calls).toHaveLength(1);
  });

  it('allows a launch once the cooldown has elapsed', () => {
    let now = 1_000;
    const { launcher, calls } = makeLauncher({ now: () => now });
    const config: ExternalFailureRecoveryConfig = {
      enabled: true,
      command: 'recover.sh',
      cooldownSeconds: 60,
    };

    expect(launcher.tryLaunch(config, CONTEXT)).toEqual({ launched: true });

    // Exactly 60s later — cooldown elapsed (boundary is inclusive).
    now += 60_000;
    expect(launcher.tryLaunch(config, CONTEXT)).toEqual({ launched: true });

    expect(calls).toHaveLength(2);
  });

  it('does not apply a cooldown when cooldownSeconds is unset', () => {
    const { launcher, calls } = makeLauncher({ now: () => 0 });
    const config: ExternalFailureRecoveryConfig = {
      enabled: true,
      command: 'recover.sh',
    };
    launcher.tryLaunch(config, CONTEXT);
    launcher.tryLaunch(config, CONTEXT);
    expect(calls).toHaveLength(2);
  });

  it('resets the cooldown window relative to the most recent launch', () => {
    let now = 0;
    const { launcher, calls } = makeLauncher({ now: () => now });
    const config: ExternalFailureRecoveryConfig = {
      enabled: true,
      command: 'recover.sh',
      cooldownSeconds: 10,
    };

    expect(launcher.tryLaunch(config, CONTEXT).launched).toBe(true); // t=0
    now = 10_000;
    expect(launcher.tryLaunch(config, CONTEXT).launched).toBe(true); // t=10s
    now = 15_000;
    // 5s after the second launch — still cooling down.
    expect(launcher.tryLaunch(config, CONTEXT)).toEqual({
      launched: false,
      reason: 'cooldown',
    });

    expect(calls).toHaveLength(2);
  });
});
