import { describe, it, expect } from 'vitest';
import {
  buildExternalFailureRecoveryEnv,
  createExternalFailureRecoveryLauncher,
  type ExternalFailureRecoveryContext,
  type ExternalFailureRecoveryLaunchArgs,
} from '../external-failure-recovery.js';
import type { ExternalFailureRecoveryConfig } from '../config.js';

const context: ExternalFailureRecoveryContext = {
  taskId: 'task-1',
  workflowId: 'wf-1',
  repoRoot: '/repo',
  dbDir: '/db',
};

function makeRecorder() {
  const calls: ExternalFailureRecoveryLaunchArgs[] = [];
  return {
    calls,
    launchProcess: (args: ExternalFailureRecoveryLaunchArgs) => {
      calls.push(args);
    },
  };
}

describe('buildExternalFailureRecoveryEnv', () => {
  it('sets exactly the documented INVOKER_* env vars and reason=task_failed', () => {
    const env = buildExternalFailureRecoveryEnv(context, {});
    expect(env).toEqual({
      INVOKER_FAILED_TASK_ID: 'task-1',
      INVOKER_FAILED_WORKFLOW_ID: 'wf-1',
      INVOKER_REPO_ROOT: '/repo',
      INVOKER_DB_DIR: '/db',
      INVOKER_RECOVERY_REASON: 'task_failed',
    });
  });

  it('merges over the provided base env without dropping unrelated keys', () => {
    const env = buildExternalFailureRecoveryEnv(context, {
      PATH: '/usr/bin',
      INVOKER_RECOVERY_REASON: 'will_be_overwritten',
    });
    expect(env.PATH).toBe('/usr/bin');
    expect(env.INVOKER_RECOVERY_REASON).toBe('task_failed');
    expect(env.INVOKER_FAILED_TASK_ID).toBe('task-1');
  });
});

describe('createExternalFailureRecoveryLauncher', () => {
  it('skips with reason=disabled when config is missing', () => {
    const recorder = makeRecorder();
    const launcher = createExternalFailureRecoveryLauncher(undefined, {
      launchProcess: recorder.launchProcess,
      now: () => 0,
    });
    expect(launcher.launch(context)).toEqual({ launched: false, reason: 'disabled' });
    expect(recorder.calls).toHaveLength(0);
  });

  it('skips with reason=disabled when enabled is false', () => {
    const recorder = makeRecorder();
    const config: ExternalFailureRecoveryConfig = {
      enabled: false,
      command: '/bin/true',
    };
    const launcher = createExternalFailureRecoveryLauncher(config, {
      launchProcess: recorder.launchProcess,
      now: () => 0,
    });
    expect(launcher.launch(context)).toEqual({ launched: false, reason: 'disabled' });
    expect(recorder.calls).toHaveLength(0);
  });

  it('skips with reason=missing_command when command is omitted', () => {
    const recorder = makeRecorder();
    const launcher = createExternalFailureRecoveryLauncher(
      { enabled: true },
      { launchProcess: recorder.launchProcess, now: () => 0 },
    );
    expect(launcher.launch(context)).toEqual({ launched: false, reason: 'missing_command' });
    expect(recorder.calls).toHaveLength(0);
  });

  it('skips with reason=missing_command when command is whitespace', () => {
    const recorder = makeRecorder();
    const launcher = createExternalFailureRecoveryLauncher(
      { enabled: true, command: '   ' },
      { launchProcess: recorder.launchProcess, now: () => 0 },
    );
    expect(launcher.launch(context)).toEqual({ launched: false, reason: 'missing_command' });
    expect(recorder.calls).toHaveLength(0);
  });

  it('launches with the full env, cwd, and trimmed command when enabled', () => {
    const recorder = makeRecorder();
    const launcher = createExternalFailureRecoveryLauncher(
      { enabled: true, command: '  /usr/local/bin/recover.sh  ', cwd: '/srv' },
      {
        launchProcess: recorder.launchProcess,
        now: () => 0,
        baseEnv: { PATH: '/usr/bin' },
      },
    );
    expect(launcher.launch(context)).toEqual({ launched: true });
    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0]).toEqual({
      command: '/usr/local/bin/recover.sh',
      cwd: '/srv',
      env: {
        PATH: '/usr/bin',
        INVOKER_FAILED_TASK_ID: 'task-1',
        INVOKER_FAILED_WORKFLOW_ID: 'wf-1',
        INVOKER_REPO_ROOT: '/repo',
        INVOKER_DB_DIR: '/db',
        INVOKER_RECOVERY_REASON: 'task_failed',
      },
    });
  });

  it('skips repeated launches inside the cooldown window', () => {
    const recorder = makeRecorder();
    let currentMs = 1_000;
    const launcher = createExternalFailureRecoveryLauncher(
      { enabled: true, command: '/bin/true', cooldownSeconds: 10 },
      {
        launchProcess: recorder.launchProcess,
        now: () => currentMs,
      },
    );

    expect(launcher.launch(context)).toEqual({ launched: true });

    currentMs = 1_000 + 5_000;
    expect(launcher.launch(context)).toEqual({ launched: false, reason: 'cooldown' });

    currentMs = 1_000 + 9_999;
    expect(launcher.launch(context)).toEqual({ launched: false, reason: 'cooldown' });

    currentMs = 1_000 + 10_000;
    expect(launcher.launch(context)).toEqual({ launched: true });
    expect(recorder.calls).toHaveLength(2);
  });

  it('treats cooldownSeconds=0 as no throttling', () => {
    const recorder = makeRecorder();
    let currentMs = 0;
    const launcher = createExternalFailureRecoveryLauncher(
      { enabled: true, command: '/bin/true', cooldownSeconds: 0 },
      {
        launchProcess: recorder.launchProcess,
        now: () => currentMs,
      },
    );

    expect(launcher.launch(context)).toEqual({ launched: true });
    currentMs = 1;
    expect(launcher.launch(context)).toEqual({ launched: true });
    expect(recorder.calls).toHaveLength(2);
  });
});
