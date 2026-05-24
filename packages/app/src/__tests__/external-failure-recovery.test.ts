import { describe, it, expect } from 'vitest';
import {
  ExternalFailureRecoveryLauncher,
  buildExternalFailureRecoveryEnv,
  type ExternalFailureRecoveryContext,
  type ExternalFailureRecoverySpawnOptions,
} from '../external-failure-recovery.js';
import type { InvokerConfig } from '../config.js';

const baseContext: ExternalFailureRecoveryContext = {
  failedTaskId: 'task-123',
  failedWorkflowId: 'wf-abc',
  repoRoot: '/repos/example',
  dbDir: '/repos/example/.invoker/db',
};

function makeSpawnRecorder() {
  const calls: ExternalFailureRecoverySpawnOptions[] = [];
  return {
    calls,
    spawn: (options: ExternalFailureRecoverySpawnOptions) => {
      calls.push(options);
    },
  };
}

describe('buildExternalFailureRecoveryEnv', () => {
  it('forwards the failure context through the documented env var names', () => {
    const env = buildExternalFailureRecoveryEnv(baseContext, { EXISTING: 'kept' });
    expect(env).toEqual({
      EXISTING: 'kept',
      INVOKER_FAILED_TASK_ID: 'task-123',
      INVOKER_FAILED_WORKFLOW_ID: 'wf-abc',
      INVOKER_REPO_ROOT: '/repos/example',
      INVOKER_DB_DIR: '/repos/example/.invoker/db',
      INVOKER_RECOVERY_REASON: 'task_failed',
    });
  });

  it('overwrites colliding INVOKER_* values from the caller env', () => {
    const env = buildExternalFailureRecoveryEnv(baseContext, {
      INVOKER_RECOVERY_REASON: 'stale',
      INVOKER_FAILED_TASK_ID: 'wrong',
    });
    expect(env.INVOKER_RECOVERY_REASON).toBe('task_failed');
    expect(env.INVOKER_FAILED_TASK_ID).toBe('task-123');
  });
});

describe('ExternalFailureRecoveryLauncher', () => {
  it('skips when externalFailureRecovery is absent', () => {
    const recorder = makeSpawnRecorder();
    const launcher = new ExternalFailureRecoveryLauncher({
      now: () => 1_000,
      spawn: recorder.spawn,
    });
    const result = launcher.launch({}, baseContext, {});
    expect(result).toEqual({ launched: false, reason: 'skipped_disabled' });
    expect(recorder.calls).toEqual([]);
    expect(launcher.getLastLaunchedAtMs()).toBeNull();
  });

  it('skips when enabled is false even with a command set', () => {
    const recorder = makeSpawnRecorder();
    const launcher = new ExternalFailureRecoveryLauncher({
      now: () => 1_000,
      spawn: recorder.spawn,
    });
    const config: InvokerConfig = {
      externalFailureRecovery: { enabled: false, command: '/bin/echo' },
    };
    const result = launcher.launch(config, baseContext, {});
    expect(result.launched).toBe(false);
    expect(result.reason).toBe('skipped_disabled');
    expect(recorder.calls).toEqual([]);
  });

  it('skips when command is missing or only whitespace', () => {
    const recorder = makeSpawnRecorder();
    const launcher = new ExternalFailureRecoveryLauncher({
      now: () => 1_000,
      spawn: recorder.spawn,
    });
    const missingResult = launcher.launch(
      { externalFailureRecovery: { enabled: true } },
      baseContext,
      {},
    );
    expect(missingResult).toEqual({ launched: false, reason: 'skipped_missing_command' });
    const blankResult = launcher.launch(
      { externalFailureRecovery: { enabled: true, command: '   ' } },
      baseContext,
      {},
    );
    expect(blankResult).toEqual({ launched: false, reason: 'skipped_missing_command' });
    expect(recorder.calls).toEqual([]);
  });

  it('launches the command with cwd and full env when enabled', () => {
    const recorder = makeSpawnRecorder();
    const launcher = new ExternalFailureRecoveryLauncher({
      now: () => 5_000,
      spawn: recorder.spawn,
    });
    const config: InvokerConfig = {
      externalFailureRecovery: {
        enabled: true,
        command: '  /usr/local/bin/recover.sh --once  ',
        cwd: '/tmp/work',
        cooldownSeconds: 60,
      },
    };
    const result = launcher.launch(config, baseContext, { CALLER: 'yes' });
    expect(result).toEqual({ launched: true, reason: 'launched' });
    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0]).toEqual({
      command: '/usr/local/bin/recover.sh --once',
      cwd: '/tmp/work',
      env: {
        CALLER: 'yes',
        INVOKER_FAILED_TASK_ID: 'task-123',
        INVOKER_FAILED_WORKFLOW_ID: 'wf-abc',
        INVOKER_REPO_ROOT: '/repos/example',
        INVOKER_DB_DIR: '/repos/example/.invoker/db',
        INVOKER_RECOVERY_REASON: 'task_failed',
      },
    });
    expect(launcher.getLastLaunchedAtMs()).toBe(5_000);
  });

  it('suppresses launches inside the cooldown window and resumes after it', () => {
    const recorder = makeSpawnRecorder();
    let clock = 10_000;
    const launcher = new ExternalFailureRecoveryLauncher({
      now: () => clock,
      spawn: recorder.spawn,
    });
    const config: InvokerConfig = {
      externalFailureRecovery: {
        enabled: true,
        command: '/bin/true',
        cooldownSeconds: 5,
      },
    };

    const first = launcher.launch(config, baseContext, {});
    expect(first).toEqual({ launched: true, reason: 'launched' });

    clock = 12_000;
    const second = launcher.launch(config, baseContext, {});
    expect(second).toEqual({ launched: false, reason: 'skipped_cooldown' });

    clock = 15_000;
    const third = launcher.launch(config, baseContext, {});
    expect(third).toEqual({ launched: true, reason: 'launched' });

    expect(recorder.calls).toHaveLength(2);
    expect(launcher.getLastLaunchedAtMs()).toBe(15_000);
  });

  it('treats cooldownSeconds=0 (and unset) as no cooldown', () => {
    const recorder = makeSpawnRecorder();
    let clock = 0;
    const launcher = new ExternalFailureRecoveryLauncher({
      now: () => clock,
      spawn: recorder.spawn,
    });
    const config: InvokerConfig = {
      externalFailureRecovery: { enabled: true, command: '/bin/true' },
    };
    launcher.launch(config, baseContext, {});
    clock = 1;
    launcher.launch(config, baseContext, {});
    expect(recorder.calls).toHaveLength(2);
  });

  it('reports launch_error when the spawn dependency throws', () => {
    const launcher = new ExternalFailureRecoveryLauncher({
      now: () => 0,
      spawn: () => { throw new Error('ENOENT'); },
    });
    const config: InvokerConfig = {
      externalFailureRecovery: { enabled: true, command: '/missing/bin' },
    };
    const result = launcher.launch(config, baseContext, {});
    expect(result.launched).toBe(false);
    expect(result.reason).toBe('launch_error');
    expect(result.error).toBe('ENOENT');
    expect(launcher.getLastLaunchedAtMs()).toBeNull();
  });
});
