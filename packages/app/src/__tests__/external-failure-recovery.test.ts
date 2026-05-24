import { describe, it, expect } from 'vitest';

import {
  buildRecoveryEnv,
  launchExternalFailureRecovery,
  type FailureRecoveryContext,
  type RecoveryLauncherState,
  type RecoverySpawnFn,
} from '../external-failure-recovery.js';
import type { ExternalFailureRecoveryConfig } from '../config.js';

const context: FailureRecoveryContext = {
  failedTaskId: 't-123',
  failedWorkflowId: 'wf-456',
  repoRoot: '/work/repo',
  dbDir: '/work/db',
};

type SpawnCall = { command: string; cwd?: string; env: NodeJS.ProcessEnv };

function recordingSpawn(): { fn: RecoverySpawnFn; calls: SpawnCall[] } {
  const calls: SpawnCall[] = [];
  const fn: RecoverySpawnFn = (command, options) => {
    calls.push({ command, cwd: options.cwd, env: options.env });
  };
  return { fn, calls };
}

describe('buildRecoveryEnv', () => {
  it('sets the documented context env vars including the fixed reason', () => {
    const env = buildRecoveryEnv(context);
    expect(env).toEqual({
      INVOKER_FAILED_TASK_ID: 't-123',
      INVOKER_FAILED_WORKFLOW_ID: 'wf-456',
      INVOKER_REPO_ROOT: '/work/repo',
      INVOKER_DB_DIR: '/work/db',
      INVOKER_RECOVERY_REASON: 'task_failed',
    });
  });

  it('layers context vars on top of a base env without dropping unrelated keys', () => {
    const env = buildRecoveryEnv(context, { PATH: '/usr/bin', UNRELATED: 'keep-me' });
    expect(env.PATH).toBe('/usr/bin');
    expect(env.UNRELATED).toBe('keep-me');
    expect(env.INVOKER_FAILED_TASK_ID).toBe('t-123');
    expect(env.INVOKER_RECOVERY_REASON).toBe('task_failed');
  });

  it('lets context vars override clashing keys in the base env', () => {
    const env = buildRecoveryEnv(context, {
      INVOKER_FAILED_TASK_ID: 'stale',
      INVOKER_RECOVERY_REASON: 'stale',
    });
    expect(env.INVOKER_FAILED_TASK_ID).toBe('t-123');
    expect(env.INVOKER_RECOVERY_REASON).toBe('task_failed');
  });
});

describe('launchExternalFailureRecovery', () => {
  it('skips with reason "disabled" when config is undefined', () => {
    const { fn, calls } = recordingSpawn();
    const state: RecoveryLauncherState = {};
    const outcome = launchExternalFailureRecovery(undefined, context, state, { spawn: fn });
    expect(outcome).toEqual({ launched: false, reason: 'disabled' });
    expect(calls).toHaveLength(0);
    expect(state.lastLaunchMs).toBeUndefined();
  });

  it('skips with reason "disabled" when enabled=false', () => {
    const { fn, calls } = recordingSpawn();
    const config: ExternalFailureRecoveryConfig = {
      enabled: false,
      command: '/bin/true',
    };
    const outcome = launchExternalFailureRecovery(config, context, {}, { spawn: fn });
    expect(outcome).toEqual({ launched: false, reason: 'disabled' });
    expect(calls).toHaveLength(0);
  });

  it('skips with reason "no_command" when command is missing or whitespace', () => {
    const { fn, calls } = recordingSpawn();
    expect(
      launchExternalFailureRecovery({ enabled: true }, context, {}, { spawn: fn }),
    ).toEqual({ launched: false, reason: 'no_command' });
    expect(
      launchExternalFailureRecovery(
        { enabled: true, command: '   ' },
        context,
        {},
        { spawn: fn },
      ),
    ).toEqual({ launched: false, reason: 'no_command' });
    expect(calls).toHaveLength(0);
  });

  it('launches when enabled with a command and forwards env + cwd', () => {
    const { fn, calls } = recordingSpawn();
    const state: RecoveryLauncherState = {};
    const outcome = launchExternalFailureRecovery(
      {
        enabled: true,
        command: '/usr/local/bin/recover.sh --verbose',
        cwd: '/var/lib/invoker',
      },
      context,
      state,
      { now: () => 5_000, spawn: fn },
    );

    expect(outcome.launched).toBe(true);
    if (!outcome.launched) return;
    expect(outcome.command).toBe('/usr/local/bin/recover.sh --verbose');
    expect(outcome.cwd).toBe('/var/lib/invoker');
    expect(outcome.env.INVOKER_FAILED_TASK_ID).toBe('t-123');
    expect(outcome.env.INVOKER_FAILED_WORKFLOW_ID).toBe('wf-456');
    expect(outcome.env.INVOKER_REPO_ROOT).toBe('/work/repo');
    expect(outcome.env.INVOKER_DB_DIR).toBe('/work/db');
    expect(outcome.env.INVOKER_RECOVERY_REASON).toBe('task_failed');

    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe('/usr/local/bin/recover.sh --verbose');
    expect(calls[0]?.cwd).toBe('/var/lib/invoker');
    expect(calls[0]?.env.INVOKER_FAILED_TASK_ID).toBe('t-123');

    expect(state.lastLaunchMs).toBe(5_000);
  });

  it('skips with reason "cooldown" when invoked again before cooldownSeconds elapses', () => {
    const { fn, calls } = recordingSpawn();
    const state: RecoveryLauncherState = {};
    const config: ExternalFailureRecoveryConfig = {
      enabled: true,
      command: '/bin/recover',
      cooldownSeconds: 60,
    };

    let nowMs = 1_000_000;
    const now = () => nowMs;

    const first = launchExternalFailureRecovery(config, context, state, { now, spawn: fn });
    expect(first.launched).toBe(true);
    expect(state.lastLaunchMs).toBe(1_000_000);
    expect(calls).toHaveLength(1);

    nowMs = 1_000_000 + 30_000;
    const second = launchExternalFailureRecovery(config, context, state, { now, spawn: fn });
    expect(second).toEqual({ launched: false, reason: 'cooldown' });
    expect(calls).toHaveLength(1);
    expect(state.lastLaunchMs).toBe(1_000_000);

    nowMs = 1_000_000 + 60_000;
    const third = launchExternalFailureRecovery(config, context, state, { now, spawn: fn });
    expect(third.launched).toBe(true);
    expect(calls).toHaveLength(2);
    expect(state.lastLaunchMs).toBe(1_000_000 + 60_000);
  });

  it('treats cooldownSeconds=0 (or unset) as no cooldown', () => {
    const { fn, calls } = recordingSpawn();
    const state: RecoveryLauncherState = {};
    const config: ExternalFailureRecoveryConfig = {
      enabled: true,
      command: '/bin/recover',
    };

    let nowMs = 0;
    const now = () => nowMs;

    launchExternalFailureRecovery(config, context, state, { now, spawn: fn });
    nowMs = 1;
    launchExternalFailureRecovery(config, context, state, { now, spawn: fn });
    expect(calls).toHaveLength(2);
  });
});
