import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  buildRecoveryEnv,
  createExternalRecoveryLauncher,
  type RecoveryContext,
} from '../external-failure-recovery.js';
import type { InvokerConfig } from '../config.js';

const baseContext: RecoveryContext = {
  taskId: 'task-42',
  workflowId: 'wf-99',
  repoRoot: '/home/user/repo',
  dbDir: '/home/user/.invoker/db',
  reason: 'exit-code-1',
};

describe('buildRecoveryEnv', () => {
  it('sets all INVOKER_* recovery vars', () => {
    const env = buildRecoveryEnv(baseContext);
    expect(env.INVOKER_FAILED_TASK_ID).toBe('task-42');
    expect(env.INVOKER_FAILED_WORKFLOW_ID).toBe('wf-99');
    expect(env.INVOKER_REPO_ROOT).toBe('/home/user/repo');
    expect(env.INVOKER_DB_DIR).toBe('/home/user/.invoker/db');
    expect(env.INVOKER_RECOVERY_REASON).toBe('exit-code-1');
  });

  it('inherits base env and recovery vars override', () => {
    const base = { PATH: '/usr/bin', INVOKER_FAILED_TASK_ID: 'old' };
    const env = buildRecoveryEnv(baseContext, base);
    expect(env.PATH).toBe('/usr/bin');
    expect(env.INVOKER_FAILED_TASK_ID).toBe('task-42');
  });

  it('returns empty base env values when no base provided', () => {
    const env = buildRecoveryEnv(baseContext);
    expect(env.PATH).toBeUndefined();
  });
});

vi.mock('node:child_process', () => {
  const unref = vi.fn();
  const fakeSpawn = vi.fn(() => ({ pid: 12345, unref }));
  return { spawn: fakeSpawn, __unref: unref };
});

describe('createExternalRecoveryLauncher', () => {
  let spawnMock: ReturnType<typeof vi.fn>;
  let unrefMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const cp = await import('node:child_process');
    spawnMock = cp.spawn as unknown as ReturnType<typeof vi.fn>;
    unrefMock = (cp as unknown as { __unref: ReturnType<typeof vi.fn> }).__unref;
    spawnMock.mockClear();
    unrefMock.mockClear();
    spawnMock.mockReturnValue({ pid: 12345, unref: unrefMock });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns disabled when config has no externalFailureRecovery', () => {
    const launch = createExternalRecoveryLauncher({});
    expect(launch(baseContext)).toEqual({ status: 'disabled' });
  });

  it('returns disabled when enabled is false', () => {
    const config: InvokerConfig = {
      externalFailureRecovery: { enabled: false, command: 'echo hi' },
    };
    const launch = createExternalRecoveryLauncher(config);
    expect(launch(baseContext)).toEqual({ status: 'disabled' });
  });

  it('returns missing-command when command is empty', () => {
    const config: InvokerConfig = {
      externalFailureRecovery: { enabled: true, command: '' },
    };
    const launch = createExternalRecoveryLauncher(config);
    expect(launch(baseContext)).toEqual({ status: 'missing-command' });
  });

  it('launches with correct spawn options', () => {
    const config: InvokerConfig = {
      externalFailureRecovery: {
        enabled: true,
        command: '/usr/local/bin/recover.sh',
        cwd: '/tmp/recovery',
      },
    };
    const launch = createExternalRecoveryLauncher(config);
    const result = launch(baseContext, { HOME: '/home/user' });

    expect(result).toEqual({ status: 'launched', pid: 12345 });
    expect(spawnMock).toHaveBeenCalledOnce();
    const [cmd, opts] = spawnMock.mock.calls[0]!;
    expect(cmd).toBe('/usr/local/bin/recover.sh');
    expect(opts.shell).toBe(true);
    expect(opts.detached).toBe(true);
    expect(opts.stdio).toBe('ignore');
    expect(opts.cwd).toBe('/tmp/recovery');
    expect(opts.env.HOME).toBe('/home/user');
    expect(opts.env.INVOKER_FAILED_TASK_ID).toBe('task-42');
    expect(opts.env.INVOKER_FAILED_WORKFLOW_ID).toBe('wf-99');
    expect(opts.env.INVOKER_REPO_ROOT).toBe('/home/user/repo');
    expect(opts.env.INVOKER_DB_DIR).toBe('/home/user/.invoker/db');
    expect(opts.env.INVOKER_RECOVERY_REASON).toBe('exit-code-1');
  });

  it('calls unref on the child process', () => {
    const config: InvokerConfig = {
      externalFailureRecovery: { enabled: true, command: 'echo hi' },
    };
    const launch = createExternalRecoveryLauncher(config);
    launch(baseContext);
    expect(unrefMock).toHaveBeenCalledOnce();
  });

  it('returns spawn-error when spawn throws', () => {
    spawnMock.mockImplementation(() => { throw new Error('ENOENT'); });
    const config: InvokerConfig = {
      externalFailureRecovery: { enabled: true, command: '/nonexistent' },
    };
    const launch = createExternalRecoveryLauncher(config);
    const result = launch(baseContext);
    expect(result.status).toBe('spawn-error');
    if (result.status === 'spawn-error') {
      expect(result.error.message).toBe('ENOENT');
    }
  });

  it('enforces cooldown between launches', () => {
    const config: InvokerConfig = {
      externalFailureRecovery: {
        enabled: true,
        command: 'echo hi',
        cooldownSeconds: 60,
      },
    };
    const now = 1000000;
    vi.spyOn(Date, 'now').mockReturnValue(now);

    const launch = createExternalRecoveryLauncher(config);

    const first = launch(baseContext);
    expect(first.status).toBe('launched');

    const second = launch(baseContext);
    expect(second.status).toBe('cooldown');
    if (second.status === 'cooldown') {
      expect(second.remainingMs).toBeGreaterThan(0);
      expect(second.remainingMs).toBeLessThanOrEqual(60000);
    }
  });

  it('allows launch after cooldown expires', () => {
    const config: InvokerConfig = {
      externalFailureRecovery: {
        enabled: true,
        command: 'echo hi',
        cooldownSeconds: 10,
      },
    };
    let now = 1000000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);

    const launch = createExternalRecoveryLauncher(config);

    expect(launch(baseContext).status).toBe('launched');

    now += 5000;
    expect(launch(baseContext).status).toBe('cooldown');

    now += 6000;
    expect(launch(baseContext).status).toBe('launched');
  });

  it('cooldown is per-launcher instance', () => {
    const config: InvokerConfig = {
      externalFailureRecovery: {
        enabled: true,
        command: 'echo hi',
        cooldownSeconds: 60,
      },
    };
    const now = 1000000;
    vi.spyOn(Date, 'now').mockReturnValue(now);

    const launchA = createExternalRecoveryLauncher(config);
    const launchB = createExternalRecoveryLauncher(config);

    expect(launchA(baseContext).status).toBe('launched');
    expect(launchA(baseContext).status).toBe('cooldown');
    expect(launchB(baseContext).status).toBe('launched');
  });
});
