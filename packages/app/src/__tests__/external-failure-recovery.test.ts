import { describe, it, expect } from 'vitest';

import {
  buildRecoveryEnv,
  createExternalRecoveryLauncher,
  type RecoveryContext,
  type RecoverySpawnFn,
} from '../external-failure-recovery.js';
import type { ExternalFailureRecoveryConfig } from '../config.js';

const ctx: RecoveryContext = {
  taskId: 'task-1',
  workflowId: 'wf-1',
  repoRoot: '/repo',
  dbDir: '/db',
};

function makeSpawnSpy() {
  const calls: Array<{
    command: string;
    args: ReadonlyArray<string>;
    options: Parameters<RecoverySpawnFn>[2];
  }> = [];
  let nextPid = 1000;
  const child = { pid: 0, unref: () => {} };
  const spawn: RecoverySpawnFn = (command, args, options) => {
    calls.push({ command, args, options });
    nextPid += 1;
    return { ...child, pid: nextPid };
  };
  return { spawn, calls };
}

describe('buildRecoveryEnv', () => {
  it('produces the documented env-var bag verbatim', () => {
    const env = buildRecoveryEnv(ctx, {});
    expect(env).toEqual({
      INVOKER_FAILED_TASK_ID: 'task-1',
      INVOKER_FAILED_WORKFLOW_ID: 'wf-1',
      INVOKER_REPO_ROOT: '/repo',
      INVOKER_DB_DIR: '/db',
      INVOKER_RECOVERY_REASON: 'task_failed',
    });
  });

  it('merges over a provided base env without dropping unrelated keys', () => {
    const env = buildRecoveryEnv(ctx, { PATH: '/usr/bin', UNRELATED: 'keep' });
    expect(env.PATH).toBe('/usr/bin');
    expect(env.UNRELATED).toBe('keep');
    expect(env.INVOKER_RECOVERY_REASON).toBe('task_failed');
  });

  it('lets recovery vars override colliding keys in the base env', () => {
    const env = buildRecoveryEnv(ctx, {
      INVOKER_FAILED_TASK_ID: 'stale',
      INVOKER_RECOVERY_REASON: 'stale',
    });
    expect(env.INVOKER_FAILED_TASK_ID).toBe('task-1');
    expect(env.INVOKER_RECOVERY_REASON).toBe('task_failed');
  });
});

describe('createExternalRecoveryLauncher', () => {
  it('skips with reason="disabled" when config is undefined', () => {
    const { spawn, calls } = makeSpawnSpy();
    const launcher = createExternalRecoveryLauncher({ spawn, baseEnv: {} });
    const result = launcher.launch(undefined, ctx);
    expect(result).toEqual({ launched: false, reason: 'disabled' });
    expect(calls).toHaveLength(0);
  });

  it('skips with reason="disabled" when enabled is false', () => {
    const { spawn, calls } = makeSpawnSpy();
    const launcher = createExternalRecoveryLauncher({ spawn, baseEnv: {} });
    const cfg: ExternalFailureRecoveryConfig = {
      enabled: false,
      command: '/tmp/recover.sh',
    };
    const result = launcher.launch(cfg, ctx);
    expect(result).toEqual({ launched: false, reason: 'disabled' });
    expect(calls).toHaveLength(0);
  });

  it('skips with reason="missing-command" when command is empty or whitespace', () => {
    const { spawn, calls } = makeSpawnSpy();
    const launcher = createExternalRecoveryLauncher({ spawn, baseEnv: {} });
    expect(launcher.launch({ enabled: true, command: '' }, ctx)).toEqual({
      launched: false,
      reason: 'missing-command',
    });
    expect(launcher.launch({ enabled: true, command: '   ' }, ctx)).toEqual({
      launched: false,
      reason: 'missing-command',
    });
    expect(calls).toHaveLength(0);
  });

  it('launches the command with cwd, shell, detached, and the recovery env bag', () => {
    const { spawn, calls } = makeSpawnSpy();
    const launcher = createExternalRecoveryLauncher({
      spawn,
      baseEnv: { PATH: '/usr/bin' },
      now: () => 1000,
    });
    const cfg: ExternalFailureRecoveryConfig = {
      enabled: true,
      command: '/tmp/recover.sh --verbose',
      cwd: '/work',
    };
    const result = launcher.launch(cfg, ctx);

    expect(result).toEqual({ launched: true, pid: 1001 });
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.command).toBe('/tmp/recover.sh --verbose');
    expect(call.args).toEqual([]);
    expect(call.options.cwd).toBe('/work');
    expect(call.options.shell).toBe(true);
    expect(call.options.detached).toBe(true);
    expect(call.options.stdio).toBe('ignore');
    expect(call.options.env).toEqual({
      PATH: '/usr/bin',
      INVOKER_FAILED_TASK_ID: 'task-1',
      INVOKER_FAILED_WORKFLOW_ID: 'wf-1',
      INVOKER_REPO_ROOT: '/repo',
      INVOKER_DB_DIR: '/db',
      INVOKER_RECOVERY_REASON: 'task_failed',
    });
  });

  it('returns reason="spawn-error" with the thrown message when spawn fails', () => {
    const failing: RecoverySpawnFn = () => {
      throw new Error('ENOENT recover.sh');
    };
    const launcher = createExternalRecoveryLauncher({ spawn: failing, baseEnv: {} });
    const result = launcher.launch(
      { enabled: true, command: '/missing.sh' },
      ctx,
    );
    expect(result).toEqual({
      launched: false,
      reason: 'spawn-error',
      detail: 'ENOENT recover.sh',
    });
  });

  describe('cooldown', () => {
    it('allows back-to-back launches when cooldownSeconds is unset', () => {
      const { spawn, calls } = makeSpawnSpy();
      const launcher = createExternalRecoveryLauncher({
        spawn,
        baseEnv: {},
        now: () => 0,
      });
      const cfg: ExternalFailureRecoveryConfig = {
        enabled: true,
        command: '/tmp/recover.sh',
      };
      expect(launcher.launch(cfg, ctx).launched).toBe(true);
      expect(launcher.launch(cfg, ctx).launched).toBe(true);
      expect(calls).toHaveLength(2);
    });

    it('skips with reason="cooldown" inside the window and launches again after', () => {
      const { spawn, calls } = makeSpawnSpy();
      let nowMs = 1_000_000;
      const launcher = createExternalRecoveryLauncher({
        spawn,
        baseEnv: {},
        now: () => nowMs,
      });
      const cfg: ExternalFailureRecoveryConfig = {
        enabled: true,
        command: '/tmp/recover.sh',
        cooldownSeconds: 30,
      };

      // First launch always proceeds.
      expect(launcher.launch(cfg, ctx)).toEqual({ launched: true, pid: 1001 });

      // 29s later — inside the 30s cooldown.
      nowMs += 29_000;
      expect(launcher.launch(cfg, ctx)).toEqual({
        launched: false,
        reason: 'cooldown',
      });

      // Exactly at 30s — boundary is considered out of cooldown.
      nowMs += 1_000;
      expect(launcher.launch(cfg, ctx)).toEqual({ launched: true, pid: 1002 });

      expect(calls).toHaveLength(2);
    });

    it('does not start the cooldown clock from skipped launches', () => {
      const { spawn, calls } = makeSpawnSpy();
      let nowMs = 0;
      const launcher = createExternalRecoveryLauncher({
        spawn,
        baseEnv: {},
        now: () => nowMs,
      });

      // Disabled launch must not arm the cooldown.
      launcher.launch({ enabled: false, command: '/tmp/recover.sh' }, ctx);
      nowMs += 5_000;

      const cfg: ExternalFailureRecoveryConfig = {
        enabled: true,
        command: '/tmp/recover.sh',
        cooldownSeconds: 60,
      };
      expect(launcher.launch(cfg, ctx).launched).toBe(true);
      expect(calls).toHaveLength(1);
    });
  });
});
