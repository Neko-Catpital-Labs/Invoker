import { describe, expect, it } from 'vitest';

import type { ExternalFailureRecoveryConfig } from '../config.js';
import {
  buildExternalFailureRecoveryEnv,
  createExternalFailureRecoveryLauncher,
  type ExternalFailureRecoveryContext,
  type ExternalFailureRecoverySpawn,
} from '../external-failure-recovery.js';

const context: ExternalFailureRecoveryContext = {
  taskId: 'task-42',
  workflowId: 'wf-7',
  repoRoot: '/repos/example',
  dbDir: '/var/lib/invoker',
};

function makeSpawn(): {
  spawn: ExternalFailureRecoverySpawn;
  calls: Array<{ command: string; cwd?: string; env: NodeJS.ProcessEnv }>;
} {
  const calls: Array<{ command: string; cwd?: string; env: NodeJS.ProcessEnv }> = [];
  const spawn: ExternalFailureRecoverySpawn = (command, options) => {
    calls.push({ command, cwd: options.cwd, env: options.env });
  };
  return { spawn, calls };
}

describe('buildExternalFailureRecoveryEnv', () => {
  it('sets every documented INVOKER_* variable and pins the reason', () => {
    const env = buildExternalFailureRecoveryEnv(context);
    expect(env).toEqual({
      INVOKER_FAILED_TASK_ID: 'task-42',
      INVOKER_FAILED_WORKFLOW_ID: 'wf-7',
      INVOKER_REPO_ROOT: '/repos/example',
      INVOKER_DB_DIR: '/var/lib/invoker',
      INVOKER_RECOVERY_REASON: 'task_failed',
    });
  });

  it('merges with the supplied base env without dropping pre-existing keys', () => {
    const env = buildExternalFailureRecoveryEnv(context, { PATH: '/usr/bin', HOME: '/h' });
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/h');
    expect(env.INVOKER_RECOVERY_REASON).toBe('task_failed');
  });

  it('lets INVOKER_* override any incoming clobber in the base env', () => {
    const env = buildExternalFailureRecoveryEnv(context, {
      INVOKER_FAILED_TASK_ID: 'stale',
      INVOKER_RECOVERY_REASON: 'wrong',
    });
    expect(env.INVOKER_FAILED_TASK_ID).toBe('task-42');
    expect(env.INVOKER_RECOVERY_REASON).toBe('task_failed');
  });
});

describe('createExternalFailureRecoveryLauncher', () => {
  it('skips with reason=disabled when config is undefined', () => {
    const { spawn, calls } = makeSpawn();
    const launcher = createExternalFailureRecoveryLauncher(undefined, {
      spawn,
      now: () => 0,
    });
    expect(launcher(context)).toEqual({ launched: false, reason: 'disabled' });
    expect(calls).toHaveLength(0);
  });

  it('skips with reason=disabled when enabled !== true', () => {
    const { spawn, calls } = makeSpawn();
    const launcher = createExternalFailureRecoveryLauncher(
      { enabled: false, command: '/bin/echo' },
      { spawn, now: () => 0 },
    );
    expect(launcher(context)).toEqual({ launched: false, reason: 'disabled' });
    expect(calls).toHaveLength(0);
  });

  it('skips with reason=missing-command for empty or whitespace command', () => {
    const { spawn, calls } = makeSpawn();
    const empty = createExternalFailureRecoveryLauncher(
      { enabled: true, command: '' },
      { spawn, now: () => 0 },
    );
    expect(empty(context)).toEqual({ launched: false, reason: 'missing-command' });

    const whitespace = createExternalFailureRecoveryLauncher(
      { enabled: true, command: '   \t  ' },
      { spawn, now: () => 0 },
    );
    expect(whitespace(context)).toEqual({ launched: false, reason: 'missing-command' });

    expect(calls).toHaveLength(0);
  });

  it('launches the configured command with cwd and INVOKER_* env', () => {
    const { spawn, calls } = makeSpawn();
    const config: ExternalFailureRecoveryConfig = {
      enabled: true,
      command: '/usr/local/bin/recovery.sh',
      cwd: '/tmp/work',
    };
    const launcher = createExternalFailureRecoveryLauncher(config, {
      spawn,
      now: () => 1000,
      baseEnv: { PATH: '/usr/bin' },
    });

    expect(launcher(context)).toEqual({ launched: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe('/usr/local/bin/recovery.sh');
    expect(calls[0]?.cwd).toBe('/tmp/work');
    expect(calls[0]?.env).toEqual({
      PATH: '/usr/bin',
      INVOKER_FAILED_TASK_ID: 'task-42',
      INVOKER_FAILED_WORKFLOW_ID: 'wf-7',
      INVOKER_REPO_ROOT: '/repos/example',
      INVOKER_DB_DIR: '/var/lib/invoker',
      INVOKER_RECOVERY_REASON: 'task_failed',
    });
  });

  it('trims surrounding whitespace from the command before launching', () => {
    const { spawn, calls } = makeSpawn();
    const launcher = createExternalFailureRecoveryLauncher(
      { enabled: true, command: '  /bin/echo hi  ' },
      { spawn, now: () => 0, baseEnv: {} },
    );
    expect(launcher(context)).toEqual({ launched: true });
    expect(calls[0]?.command).toBe('/bin/echo hi');
  });

  it('skips with reason=cooldown until the configured window elapses', () => {
    const { spawn, calls } = makeSpawn();
    let t = 1_000;
    const launcher = createExternalFailureRecoveryLauncher(
      { enabled: true, command: '/bin/echo', cooldownSeconds: 5 },
      { spawn, now: () => t, baseEnv: {} },
    );

    expect(launcher(context)).toEqual({ launched: true }); // first launch at t=1000

    t = 2_000; // 1s later, still in cooldown
    expect(launcher(context)).toEqual({ launched: false, reason: 'cooldown' });

    t = 5_999; // 4.999s later, still in cooldown
    expect(launcher(context)).toEqual({ launched: false, reason: 'cooldown' });

    t = 6_000; // exactly 5s elapsed, allowed
    expect(launcher(context)).toEqual({ launched: true });

    t = 7_000; // 1s after second launch, back in cooldown
    expect(launcher(context)).toEqual({ launched: false, reason: 'cooldown' });

    expect(calls).toHaveLength(2);
  });

  it('treats cooldownSeconds <= 0 or non-finite as disabled cooldown', () => {
    const { spawn, calls } = makeSpawn();
    let t = 0;
    const launcher = createExternalFailureRecoveryLauncher(
      { enabled: true, command: '/bin/echo', cooldownSeconds: 0 },
      { spawn, now: () => t, baseEnv: {} },
    );
    t = 100;
    expect(launcher(context)).toEqual({ launched: true });
    t = 101;
    expect(launcher(context)).toEqual({ launched: true });
    expect(calls).toHaveLength(2);

    const { spawn: spawn2, calls: calls2 } = makeSpawn();
    const launcher2 = createExternalFailureRecoveryLauncher(
      { enabled: true, command: '/bin/echo', cooldownSeconds: Number.NaN },
      { spawn: spawn2, now: () => 0, baseEnv: {} },
    );
    expect(launcher2(context)).toEqual({ launched: true });
    expect(launcher2(context)).toEqual({ launched: true });
    expect(calls2).toHaveLength(2);
  });
});
