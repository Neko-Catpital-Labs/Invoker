import { describe, expect, it, vi } from 'vitest';
import {
  buildRecoveryEnv,
  createExternalRecoveryLauncher,
  type ExternalFailureRecoveryConfig,
  type RecoveryContext,
} from '../external-failure-recovery.js';

const CONTEXT: RecoveryContext = {
  failedTaskId: 'wf-1/task-a',
  failedWorkflowId: 'wf-1',
  repoRoot: '/srv/invoker',
  dbDir: '/srv/invoker/.invoker',
  reason: 'task_failed',
};

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

describe('external failure recovery launcher', () => {
  const enabledConfig: ExternalFailureRecoveryConfig = {
    enabled: true,
    command: 'bash scripts/prod-recreate-supervisor.sh',
    cwd: '/srv/invoker',
    cooldownSeconds: 0,
  };

  it('builds the operator recovery environment without mutating the base env', () => {
    const base = { PATH: '/usr/bin', INVOKER_FAILED_TASK_ID: 'old' } as NodeJS.ProcessEnv;
    const env = buildRecoveryEnv(CONTEXT, base);

    expect(env.PATH).toBe('/usr/bin');
    expect(env.INVOKER_FAILED_TASK_ID).toBe('wf-1/task-a');
    expect(env.INVOKER_FAILED_WORKFLOW_ID).toBe('wf-1');
    expect(env.INVOKER_REPO_ROOT).toBe('/srv/invoker');
    expect(env.INVOKER_DB_DIR).toBe('/srv/invoker/.invoker');
    expect(env.INVOKER_RECOVERY_REASON).toBe('task_failed');
    expect(base.INVOKER_FAILED_TASK_ID).toBe('old');
  });

  it('launches the configured command detached with the recovery env', () => {
    const { spawn, unref, calls } = makeSpawn({ pid: 777 });
    const launcher = createExternalRecoveryLauncher({
      config: enabledConfig,
      spawn,
      baseEnv: { PATH: '/usr/bin' },
    });

    expect(launcher.launch(CONTEXT)).toEqual({ status: 'launched', pid: 777 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe('bash scripts/prod-recreate-supervisor.sh');
    expect(calls[0]?.options).toMatchObject({
      shell: true,
      detached: true,
      stdio: 'ignore',
      cwd: '/srv/invoker',
    });
    expect((calls[0]?.options as { env: NodeJS.ProcessEnv }).env.INVOKER_FAILED_WORKFLOW_ID).toBe('wf-1');
    expect(unref).toHaveBeenCalledOnce();
  });

  it('reports disabled and missing command without spawning', () => {
    const { spawn } = makeSpawn();
    expect(createExternalRecoveryLauncher({ config: undefined, spawn }).launch(CONTEXT)).toEqual({
      status: 'disabled',
    });
    expect(createExternalRecoveryLauncher({
      config: { enabled: true, command: '   ' },
      spawn,
    }).launch(CONTEXT)).toEqual({ status: 'missing-command' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('enforces cooldown only after successful launches', () => {
    const { spawn } = makeSpawn();
    let nowMs = 0;
    const launcher = createExternalRecoveryLauncher({
      config: { ...enabledConfig, cooldownSeconds: 30 },
      spawn,
      now: () => nowMs,
    });

    expect(launcher.launch(CONTEXT).status).toBe('launched');
    nowMs = 10_000;
    const cooled = launcher.launch(CONTEXT);
    expect(cooled.status).toBe('cooldown');
    expect(spawn).toHaveBeenCalledTimes(1);
    nowMs = 30_000;
    expect(launcher.launch(CONTEXT).status).toBe('launched');
  });

  it('does not arm cooldown when spawn throws', () => {
    let attempt = 0;
    const spawn = vi.fn(() => {
      attempt += 1;
      if (attempt === 1) throw new Error('transient');
      return { pid: 9, unref: vi.fn() } as never;
    }) as never;
    const launcher = createExternalRecoveryLauncher({
      config: { ...enabledConfig, cooldownSeconds: 60 },
      spawn,
      now: () => 0,
    });

    expect(launcher.launch(CONTEXT).status).toBe('spawn-error');
    expect(launcher.launch(CONTEXT).status).toBe('launched');
  });

  it('resolves config lazily while preserving launcher cooldown state', () => {
    const { spawn } = makeSpawn();
    let config: ExternalFailureRecoveryConfig | undefined;
    let nowMs = 0;
    const launcher = createExternalRecoveryLauncher({
      config: () => config,
      spawn,
      now: () => nowMs,
    });

    expect(launcher.launch(CONTEXT).status).toBe('disabled');
    config = { ...enabledConfig, cooldownSeconds: 30 };
    expect(launcher.launch(CONTEXT).status).toBe('launched');
    nowMs = 10_000;
    expect(launcher.launch(CONTEXT).status).toBe('cooldown');
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});
