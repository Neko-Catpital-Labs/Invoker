import { describe, it, expect, vi } from 'vitest';
import {
  buildRecoveryEnv,
  createExternalRecoveryLauncher,
  type RecoveryContext,
  type ExternalFailureRecoveryConfig,
} from '../external-failure-recovery.js';

const CONTEXT: RecoveryContext = {
  failedTaskId: 'task-123',
  failedWorkflowId: 'wf-456',
  repoRoot: '/srv/repo',
  dbDir: '/srv/repo/.invoker/db',
  reason: 'executing-stall',
};

/** Build a fake spawn that records its args and returns a stub child with unref. */
function makeSpawn(overrides: { pid?: number; throws?: Error } = {}) {
  const unref = vi.fn();
  const calls: Array<{ command: unknown; options: unknown }> = [];
  const spawn = vi.fn((command: unknown, options: unknown) => {
    calls.push({ command, options });
    if (overrides.throws) throw overrides.throws;
    return { pid: overrides.pid ?? 4242, unref } as never;
  });
  return { spawn: spawn as never, unref, calls };
}

describe('buildRecoveryEnv', () => {
  it('layers the INVOKER_* failure vars on top of the base env', () => {
    const env = buildRecoveryEnv(CONTEXT, { PATH: '/usr/bin', EXISTING: 'keep' });
    expect(env.PATH).toBe('/usr/bin');
    expect(env.EXISTING).toBe('keep');
    expect(env.INVOKER_FAILED_TASK_ID).toBe('task-123');
    expect(env.INVOKER_FAILED_WORKFLOW_ID).toBe('wf-456');
    expect(env.INVOKER_REPO_ROOT).toBe('/srv/repo');
    expect(env.INVOKER_DB_DIR).toBe('/srv/repo/.invoker/db');
    expect(env.INVOKER_RECOVERY_REASON).toBe('executing-stall');
  });

  it('lets recovery vars override colliding base env keys', () => {
    const env = buildRecoveryEnv(CONTEXT, { INVOKER_FAILED_TASK_ID: 'stale' });
    expect(env.INVOKER_FAILED_TASK_ID).toBe('task-123');
  });

  it('does not mutate the provided base env', () => {
    const base = { PATH: '/usr/bin' } as NodeJS.ProcessEnv;
    buildRecoveryEnv(CONTEXT, base);
    expect(base.INVOKER_FAILED_TASK_ID).toBeUndefined();
  });
});

describe('createExternalRecoveryLauncher', () => {
  const enabledConfig: ExternalFailureRecoveryConfig = {
    enabled: true,
    command: 'node ./recover.js',
    cwd: '/srv/repo',
    cooldownSeconds: 0,
  };

  it('returns disabled when config is absent', () => {
    const { spawn } = makeSpawn();
    const launcher = createExternalRecoveryLauncher({ config: undefined, spawn });
    expect(launcher.launch(CONTEXT)).toEqual({ status: 'disabled' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('returns disabled when enabled is not true', () => {
    const { spawn } = makeSpawn();
    const launcher = createExternalRecoveryLauncher({
      config: { ...enabledConfig, enabled: false },
      spawn,
    });
    expect(launcher.launch(CONTEXT)).toEqual({ status: 'disabled' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('returns missing-command when command is empty or whitespace', () => {
    const { spawn } = makeSpawn();
    const launcher = createExternalRecoveryLauncher({
      config: { enabled: true, command: '   ' },
      spawn,
    });
    expect(launcher.launch(CONTEXT)).toEqual({ status: 'missing-command' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('returns missing-command when command is absent', () => {
    const { spawn } = makeSpawn();
    const launcher = createExternalRecoveryLauncher({
      config: { enabled: true },
      spawn,
    });
    expect(launcher.launch(CONTEXT)).toEqual({ status: 'missing-command' });
  });

  it('launches with shell, detached, ignored stdio, cwd, and recovery env', () => {
    const { spawn, unref, calls } = makeSpawn({ pid: 777 });
    const launcher = createExternalRecoveryLauncher({
      config: enabledConfig,
      spawn,
      baseEnv: { PATH: '/usr/bin' },
    });
    const result = launcher.launch(CONTEXT);
    expect(result).toEqual({ status: 'launched', pid: 777 });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe('node ./recover.js');
    const options = calls[0]?.options as Record<string, unknown>;
    expect(options.shell).toBe(true);
    expect(options.detached).toBe(true);
    expect(options.stdio).toBe('ignore');
    expect(options.cwd).toBe('/srv/repo');
    const env = options.env as NodeJS.ProcessEnv;
    expect(env.PATH).toBe('/usr/bin');
    expect(env.INVOKER_FAILED_TASK_ID).toBe('task-123');
    expect(env.INVOKER_FAILED_WORKFLOW_ID).toBe('wf-456');
    expect(env.INVOKER_REPO_ROOT).toBe('/srv/repo');
    expect(env.INVOKER_DB_DIR).toBe('/srv/repo/.invoker/db');
    expect(env.INVOKER_RECOVERY_REASON).toBe('executing-stall');
    expect(unref).toHaveBeenCalledOnce();
  });

  it('returns spawn-error when spawning throws', () => {
    const { spawn } = makeSpawn({ throws: new Error('boom') });
    const launcher = createExternalRecoveryLauncher({ config: enabledConfig, spawn });
    const result = launcher.launch(CONTEXT);
    expect(result.status).toBe('spawn-error');
    if (result.status === 'spawn-error') {
      expect(result.error.message).toBe('boom');
    }
  });

  it('does not arm cooldown after a spawn error', () => {
    let attempt = 0;
    const unref = vi.fn();
    const spawn = vi.fn(() => {
      attempt += 1;
      if (attempt === 1) throw new Error('transient');
      return { pid: 9, unref } as never;
    }) as never;
    const launcher = createExternalRecoveryLauncher({
      config: { ...enabledConfig, cooldownSeconds: 60 },
      spawn,
      now: () => 1000,
    });
    expect(launcher.launch(CONTEXT).status).toBe('spawn-error');
    // Retry is allowed because the failed attempt did not arm the cooldown.
    expect(launcher.launch(CONTEXT).status).toBe('launched');
  });

  it('enforces cooldown keyed by launcher instance', () => {
    const { spawn } = makeSpawn();
    let nowMs = 0;
    const launcher = createExternalRecoveryLauncher({
      config: { ...enabledConfig, cooldownSeconds: 30 },
      spawn,
      now: () => nowMs,
    });

    expect(launcher.launch(CONTEXT).status).toBe('launched');

    nowMs = 10_000; // 10s later, still inside the 30s window
    const cooled = launcher.launch(CONTEXT);
    expect(cooled.status).toBe('cooldown');
    if (cooled.status === 'cooldown') {
      expect(cooled.remainingSeconds).toBeCloseTo(20, 5);
    }
    expect(spawn).toHaveBeenCalledTimes(1);

    nowMs = 30_000; // exactly cooldown elapsed
    expect(launcher.launch(CONTEXT).status).toBe('launched');
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it('keeps cooldown state independent between launcher instances', () => {
    const { spawn } = makeSpawn();
    const config = { ...enabledConfig, cooldownSeconds: 30 };
    const a = createExternalRecoveryLauncher({ config, spawn, now: () => 0 });
    const b = createExternalRecoveryLauncher({ config, spawn, now: () => 0 });
    expect(a.launch(CONTEXT).status).toBe('launched');
    // b has its own cooldown state, so it is not blocked by a's launch.
    expect(b.launch(CONTEXT).status).toBe('launched');
  });

  it('launches without cooldown when cooldownSeconds is 0', () => {
    const { spawn } = makeSpawn();
    let nowMs = 0;
    const launcher = createExternalRecoveryLauncher({
      config: enabledConfig,
      spawn,
      now: () => nowMs,
    });
    expect(launcher.launch(CONTEXT).status).toBe('launched');
    nowMs = 1;
    expect(launcher.launch(CONTEXT).status).toBe('launched');
    expect(spawn).toHaveBeenCalledTimes(2);
  });
});
