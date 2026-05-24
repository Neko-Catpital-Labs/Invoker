import { describe, it, expect, vi } from 'vitest';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import {
  buildRecoveryEnv,
  createExternalFailureRecoveryLauncher,
  type ExternalFailureRecoveryContext,
  type SpawnFn,
} from '../external-failure-recovery.js';
import type { ExternalFailureRecoveryConfig } from '../config.js';

const baseContext: ExternalFailureRecoveryContext = {
  failedTaskId: 'task-42',
  failedWorkflowId: 'wf-7',
  repoRoot: '/repo',
  dbDir: '/db',
};

function makeFakeChild(pid = 1234): ChildProcess {
  const unref = vi.fn();
  return { pid, unref } as unknown as ChildProcess;
}

function makeSpawn(child: ChildProcess = makeFakeChild()): SpawnFn & ReturnType<typeof vi.fn> {
  return vi.fn(() => child) as unknown as SpawnFn & ReturnType<typeof vi.fn>;
}

describe('buildRecoveryEnv', () => {
  it('overlays the five INVOKER_* context vars onto the base env with reason=task_failed', () => {
    const env = buildRecoveryEnv(baseContext, { EXISTING: 'keep', INVOKER_FAILED_TASK_ID: 'stale' });
    expect(env).toMatchObject({
      EXISTING: 'keep',
      INVOKER_FAILED_TASK_ID: 'task-42',
      INVOKER_FAILED_WORKFLOW_ID: 'wf-7',
      INVOKER_REPO_ROOT: '/repo',
      INVOKER_DB_DIR: '/db',
      INVOKER_RECOVERY_REASON: 'task_failed',
    });
  });

  it('overwrites any stale INVOKER_RECOVERY_REASON in the base env', () => {
    const env = buildRecoveryEnv(baseContext, { INVOKER_RECOVERY_REASON: 'something_else' });
    expect(env.INVOKER_RECOVERY_REASON).toBe('task_failed');
  });
});

describe('createExternalFailureRecoveryLauncher', () => {
  it('returns disabled and does not spawn when config is undefined', () => {
    const spawn = makeSpawn();
    const launcher = createExternalFailureRecoveryLauncher(undefined, { spawn });
    const outcome = launcher.launch(baseContext);
    expect(outcome).toEqual({ launched: false, reason: 'disabled' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('returns disabled when enabled is false', () => {
    const spawn = makeSpawn();
    const launcher = createExternalFailureRecoveryLauncher(
      { enabled: false, command: 'recover.sh' },
      { spawn },
    );
    expect(launcher.launch(baseContext)).toEqual({ launched: false, reason: 'disabled' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('returns no_command when command is missing or whitespace-only', () => {
    const spawn = makeSpawn();
    const empty = createExternalFailureRecoveryLauncher(
      { enabled: true, command: '' },
      { spawn },
    );
    const whitespace = createExternalFailureRecoveryLauncher(
      { enabled: true, command: '   ' },
      { spawn },
    );
    expect(empty.launch(baseContext)).toEqual({ launched: false, reason: 'no_command' });
    expect(whitespace.launch(baseContext)).toEqual({ launched: false, reason: 'no_command' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('spawns the configured command with the recovery env vars and cwd', () => {
    const child = makeFakeChild(9999);
    const spawn = makeSpawn(child);
    const launcher = createExternalFailureRecoveryLauncher(
      { enabled: true, command: '/usr/local/bin/recover.sh --flag', cwd: '/work' },
      { spawn, env: { PATH: '/usr/bin' } },
    );

    const outcome = launcher.launch(baseContext);

    expect(outcome).toEqual({ launched: true, pid: 9999 });
    expect(spawn).toHaveBeenCalledTimes(1);
    const [command, args, options] = spawn.mock.calls[0] as [
      string,
      readonly string[],
      SpawnOptions,
    ];
    expect(command).toBe('/usr/local/bin/recover.sh --flag');
    expect(args).toEqual([]);
    expect(options.cwd).toBe('/work');
    expect(options.detached).toBe(true);
    expect(options.stdio).toBe('ignore');
    expect(options.shell).toBe(true);
    expect(options.env).toMatchObject({
      PATH: '/usr/bin',
      INVOKER_FAILED_TASK_ID: 'task-42',
      INVOKER_FAILED_WORKFLOW_ID: 'wf-7',
      INVOKER_REPO_ROOT: '/repo',
      INVOKER_DB_DIR: '/db',
      INVOKER_RECOVERY_REASON: 'task_failed',
    });
    expect(child.unref).toHaveBeenCalledTimes(1);
  });

  it('reports spawn_error and does not arm the cooldown when spawn throws', () => {
    const spawn = vi.fn(() => {
      throw new Error('boom');
    }) as unknown as SpawnFn & ReturnType<typeof vi.fn>;
    let nowValue = 0;
    const launcher = createExternalFailureRecoveryLauncher(
      { enabled: true, command: 'recover.sh', cooldownSeconds: 60 },
      { spawn, now: () => nowValue },
    );

    const first = launcher.launch(baseContext);
    expect(first).toEqual({ launched: false, reason: 'spawn_error', detail: 'boom' });

    const goodChild = makeFakeChild();
    (spawn as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => goodChild);
    nowValue = 1_000;
    const second = launcher.launch(baseContext);
    expect(second).toEqual({ launched: true, pid: goodChild.pid });
  });

  it('skips with cooldown reason when launches arrive inside the cooldown window', () => {
    const spawn = makeSpawn();
    let nowValue = 1_000;
    const launcher = createExternalFailureRecoveryLauncher(
      { enabled: true, command: 'recover.sh', cooldownSeconds: 30 },
      { spawn, now: () => nowValue },
    );

    expect(launcher.launch(baseContext).launched).toBe(true);
    expect(spawn).toHaveBeenCalledTimes(1);

    nowValue = 1_000 + 29_999;
    expect(launcher.launch(baseContext)).toEqual({ launched: false, reason: 'cooldown' });
    expect(spawn).toHaveBeenCalledTimes(1);

    nowValue = 1_000 + 30_000;
    expect(launcher.launch(baseContext).launched).toBe(true);
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it('ignores cooldown when cooldownSeconds is 0 or unset', () => {
    const spawn = makeSpawn();
    const launcher = createExternalFailureRecoveryLauncher(
      { enabled: true, command: 'recover.sh' },
      { spawn, now: () => 0 },
    );
    expect(launcher.launch(baseContext).launched).toBe(true);
    expect(launcher.launch(baseContext).launched).toBe(true);
    expect(spawn).toHaveBeenCalledTimes(2);
  });
});

describe('ExternalFailureRecoveryConfig type shape', () => {
  it('accepts the full set of documented fields', () => {
    const full: ExternalFailureRecoveryConfig = {
      enabled: true,
      command: 'recover.sh',
      cwd: '/work',
      cooldownSeconds: 60,
    };
    const minimal: ExternalFailureRecoveryConfig = {
      enabled: false,
      command: '',
    };
    expect(full.enabled).toBe(true);
    expect(minimal.enabled).toBe(false);
  });
});
