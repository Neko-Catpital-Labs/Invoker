import { describe, it, expect, vi } from 'vitest';
import {
  ExternalFailureRecoveryLauncher,
  buildRecoveryEnv,
  type ExternalFailureRecoveryConfig,
  type FailureRecoveryContext,
  type RecoverySpawnFn,
} from '../external-failure-recovery.js';

const context: FailureRecoveryContext = {
  failedTaskId: 'task-42',
  failedWorkflowId: 'wf-7',
  repoRoot: '/repos/example',
  dbDir: '/var/invoker/db',
};

describe('buildRecoveryEnv', () => {
  it('sets every INVOKER_ key exactly as specified', () => {
    const env = buildRecoveryEnv(context, {});
    expect(env.INVOKER_FAILED_TASK_ID).toBe('task-42');
    expect(env.INVOKER_FAILED_WORKFLOW_ID).toBe('wf-7');
    expect(env.INVOKER_REPO_ROOT).toBe('/repos/example');
    expect(env.INVOKER_DB_DIR).toBe('/var/invoker/db');
    expect(env.INVOKER_RECOVERY_REASON).toBe('task_failed');
  });

  it('inherits the base env so PATH and friends survive', () => {
    const env = buildRecoveryEnv(context, { PATH: '/usr/bin', UNRELATED: 'keep' });
    expect(env.PATH).toBe('/usr/bin');
    expect(env.UNRELATED).toBe('keep');
  });
});

describe('ExternalFailureRecoveryLauncher.launch', () => {
  function makeSpawn(): { fn: RecoverySpawnFn; spy: ReturnType<typeof vi.fn> } {
    const spy = vi.fn<Parameters<RecoverySpawnFn>, void>();
    return { fn: spy as unknown as RecoverySpawnFn, spy };
  }

  it('skips when no config is provided (disabled)', () => {
    const { fn, spy } = makeSpawn();
    const launcher = new ExternalFailureRecoveryLauncher({ spawn: fn });
    expect(launcher.launch(undefined, context)).toEqual({
      launched: false,
      reason: 'disabled',
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it('skips when enabled is false', () => {
    const { fn, spy } = makeSpawn();
    const launcher = new ExternalFailureRecoveryLauncher({ spawn: fn });
    expect(
      launcher.launch({ enabled: false, command: 'recover.sh' }, context),
    ).toEqual({ launched: false, reason: 'disabled' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('skips when the command is missing or blank', () => {
    const { fn, spy } = makeSpawn();
    const launcher = new ExternalFailureRecoveryLauncher({ spawn: fn });
    expect(
      launcher.launch({ enabled: true, command: '' }, context),
    ).toEqual({ launched: false, reason: 'missing-command' });
    expect(
      launcher.launch({ enabled: true, command: '   ' }, context),
    ).toEqual({ launched: false, reason: 'missing-command' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('launches when enabled with a non-empty command and forwards env + cwd', () => {
    const { fn, spy } = makeSpawn();
    const launcher = new ExternalFailureRecoveryLauncher({
      now: () => 1_000,
      spawn: fn,
      baseEnv: { PATH: '/usr/bin' },
    });
    const result = launcher.launch(
      { enabled: true, command: 'recover.sh --notify', cwd: '/work' },
      context,
    );
    expect(result).toEqual({ launched: true, launchedAtMs: 1_000 });
    expect(spy).toHaveBeenCalledTimes(1);
    const [command, options] = spy.mock.calls[0]!;
    expect(command).toBe('recover.sh --notify');
    expect(options.cwd).toBe('/work');
    expect(options.env).toMatchObject({
      PATH: '/usr/bin',
      INVOKER_FAILED_TASK_ID: 'task-42',
      INVOKER_FAILED_WORKFLOW_ID: 'wf-7',
      INVOKER_REPO_ROOT: '/repos/example',
      INVOKER_DB_DIR: '/var/invoker/db',
      INVOKER_RECOVERY_REASON: 'task_failed',
    });
  });

  it('skips the second launch when cooldown has not elapsed', () => {
    let now = 1_000;
    const { fn, spy } = makeSpawn();
    const launcher = new ExternalFailureRecoveryLauncher({
      now: () => now,
      spawn: fn,
    });
    const config: ExternalFailureRecoveryConfig = {
      enabled: true,
      command: 'recover.sh',
      cooldownSeconds: 60,
    };
    expect(launcher.launch(config, context).launched).toBe(true);
    now = 1_000 + 30_000;
    expect(launcher.launch(config, context)).toEqual({
      launched: false,
      reason: 'cooldown',
    });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('allows a relaunch once the cooldown window elapses', () => {
    let now = 1_000;
    const { fn, spy } = makeSpawn();
    const launcher = new ExternalFailureRecoveryLauncher({
      now: () => now,
      spawn: fn,
    });
    const config: ExternalFailureRecoveryConfig = {
      enabled: true,
      command: 'recover.sh',
      cooldownSeconds: 60,
    };
    expect(launcher.launch(config, context).launched).toBe(true);
    now = 1_000 + 60_001;
    expect(launcher.launch(config, context).launched).toBe(true);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('treats cooldownSeconds=0 (the default) as no cooldown', () => {
    let now = 0;
    const { fn, spy } = makeSpawn();
    const launcher = new ExternalFailureRecoveryLauncher({
      now: () => now,
      spawn: fn,
    });
    const config: ExternalFailureRecoveryConfig = {
      enabled: true,
      command: 'recover.sh',
    };
    expect(launcher.launch(config, context).launched).toBe(true);
    now = 1;
    expect(launcher.launch(config, context).launched).toBe(true);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
