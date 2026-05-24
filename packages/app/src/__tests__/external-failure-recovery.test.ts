import { describe, it, expect, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import type { SpawnOptions } from 'node:child_process';

import {
  buildExternalFailureRecoveryEnv,
  launchExternalFailureRecovery,
  type ExternalFailureRecoveryContext,
  type ExternalFailureRecoveryState,
} from '../external-failure-recovery.js';
import type { ExternalFailureRecoveryConfig } from '../config.js';

const CONTEXT: ExternalFailureRecoveryContext = {
  taskId: 'task-123',
  workflowId: 'wf-456',
  repoRoot: '/repo/root',
  dbDir: '/db/dir',
};

function makeFakeSpawn() {
  const calls: Array<{ command: string; options: SpawnOptions }> = [];
  let nextPid = 4242;
  const fakeSpawn = vi.fn((command: string, options: SpawnOptions) => {
    calls.push({ command, options });
    const pid = nextPid++;
    return { pid, unref: () => {} };
  });
  return { fakeSpawn, calls };
}

describe('buildExternalFailureRecoveryEnv', () => {
  it('layers exact recovery env vars on top of the base env', () => {
    const env = buildExternalFailureRecoveryEnv(CONTEXT, { PATH: '/usr/bin', FOO: 'bar' });
    expect(env).toMatchObject({
      PATH: '/usr/bin',
      FOO: 'bar',
      INVOKER_FAILED_TASK_ID: 'task-123',
      INVOKER_FAILED_WORKFLOW_ID: 'wf-456',
      INVOKER_REPO_ROOT: '/repo/root',
      INVOKER_DB_DIR: '/db/dir',
      INVOKER_RECOVERY_REASON: 'task_failed',
    });
  });

  it('uses INVOKER_RECOVERY_REASON=task_failed verbatim', () => {
    const env = buildExternalFailureRecoveryEnv(CONTEXT, {});
    expect(env.INVOKER_RECOVERY_REASON).toBe('task_failed');
  });

  it('does not include unrelated keys when the base env is empty', () => {
    const env = buildExternalFailureRecoveryEnv(CONTEXT, {});
    expect(Object.keys(env).sort()).toEqual([
      'INVOKER_DB_DIR',
      'INVOKER_FAILED_TASK_ID',
      'INVOKER_FAILED_WORKFLOW_ID',
      'INVOKER_RECOVERY_REASON',
      'INVOKER_REPO_ROOT',
    ]);
  });
});

describe('launchExternalFailureRecovery', () => {
  it('skips with reason=disabled when config is undefined', () => {
    const { fakeSpawn } = makeFakeSpawn();
    const state: ExternalFailureRecoveryState = {};
    const result = launchExternalFailureRecovery(undefined, CONTEXT, state, {
      spawn: fakeSpawn,
      now: () => 1_000,
    });
    expect(result).toEqual({ launched: false, reason: 'disabled' });
    expect(fakeSpawn).not.toHaveBeenCalled();
    expect(state.lastLaunchAtMs).toBeUndefined();
  });

  it('skips with reason=disabled when enabled is false', () => {
    const { fakeSpawn } = makeFakeSpawn();
    const config: ExternalFailureRecoveryConfig = { enabled: false, command: '/usr/local/bin/recover.sh' };
    const result = launchExternalFailureRecovery(config, CONTEXT, {}, {
      spawn: fakeSpawn,
      now: () => 1_000,
    });
    expect(result).toEqual({ launched: false, reason: 'disabled' });
    expect(fakeSpawn).not.toHaveBeenCalled();
  });

  it('skips with reason=missing-command when command is missing', () => {
    const { fakeSpawn } = makeFakeSpawn();
    const config: ExternalFailureRecoveryConfig = { enabled: true };
    const result = launchExternalFailureRecovery(config, CONTEXT, {}, {
      spawn: fakeSpawn,
      now: () => 1_000,
    });
    expect(result).toEqual({ launched: false, reason: 'missing-command' });
    expect(fakeSpawn).not.toHaveBeenCalled();
  });

  it('skips with reason=missing-command when command is whitespace-only', () => {
    const { fakeSpawn } = makeFakeSpawn();
    const config: ExternalFailureRecoveryConfig = { enabled: true, command: '   ' };
    const result = launchExternalFailureRecovery(config, CONTEXT, {}, {
      spawn: fakeSpawn,
      now: () => 1_000,
    });
    expect(result).toEqual({ launched: false, reason: 'missing-command' });
    expect(fakeSpawn).not.toHaveBeenCalled();
  });

  it('launches the configured command with the recovery env vars', () => {
    const { fakeSpawn, calls } = makeFakeSpawn();
    const config: ExternalFailureRecoveryConfig = {
      enabled: true,
      command: '/usr/local/bin/recover.sh',
      cwd: '/some/cwd',
    };
    const state: ExternalFailureRecoveryState = {};
    const result = launchExternalFailureRecovery(config, CONTEXT, state, {
      spawn: fakeSpawn,
      now: () => 5_000,
    });
    expect(result.launched).toBe(true);
    if (!result.launched) throw new Error('unreachable');
    expect(result.pid).toBe(4242);
    expect(state.lastLaunchAtMs).toBe(5_000);
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.command).toBe('/usr/local/bin/recover.sh');
    expect(call.options.cwd).toBe('/some/cwd');
    expect(call.options.detached).toBe(true);
    expect(call.options.env).toMatchObject({
      INVOKER_FAILED_TASK_ID: 'task-123',
      INVOKER_FAILED_WORKFLOW_ID: 'wf-456',
      INVOKER_REPO_ROOT: '/repo/root',
      INVOKER_DB_DIR: '/db/dir',
      INVOKER_RECOVERY_REASON: 'task_failed',
    });
  });

  it('skips with reason=cooldown when the previous launch is within the window', () => {
    const { fakeSpawn } = makeFakeSpawn();
    const config: ExternalFailureRecoveryConfig = {
      enabled: true,
      command: '/usr/local/bin/recover.sh',
      cooldownSeconds: 30,
    };
    const state: ExternalFailureRecoveryState = { lastLaunchAtMs: 10_000 };
    // 10s after lastLaunchAtMs — well inside the 30s cooldown.
    const result = launchExternalFailureRecovery(config, CONTEXT, state, {
      spawn: fakeSpawn,
      now: () => 20_000,
    });
    expect(result).toEqual({ launched: false, reason: 'cooldown' });
    expect(fakeSpawn).not.toHaveBeenCalled();
    expect(state.lastLaunchAtMs).toBe(10_000);
  });

  it('launches again once the cooldown elapses', () => {
    const { fakeSpawn } = makeFakeSpawn();
    const config: ExternalFailureRecoveryConfig = {
      enabled: true,
      command: '/usr/local/bin/recover.sh',
      cooldownSeconds: 30,
    };
    const state: ExternalFailureRecoveryState = { lastLaunchAtMs: 10_000 };
    const result = launchExternalFailureRecovery(config, CONTEXT, state, {
      spawn: fakeSpawn,
      now: () => 40_001,
    });
    expect(result.launched).toBe(true);
    expect(fakeSpawn).toHaveBeenCalledOnce();
    expect(state.lastLaunchAtMs).toBe(40_001);
  });

  it('treats cooldownSeconds <= 0 as no cooldown', () => {
    const { fakeSpawn } = makeFakeSpawn();
    const config: ExternalFailureRecoveryConfig = {
      enabled: true,
      command: '/usr/local/bin/recover.sh',
      cooldownSeconds: 0,
    };
    const state: ExternalFailureRecoveryState = { lastLaunchAtMs: 9_999 };
    const result = launchExternalFailureRecovery(config, CONTEXT, state, {
      spawn: fakeSpawn,
      now: () => 10_000,
    });
    expect(result.launched).toBe(true);
    expect(fakeSpawn).toHaveBeenCalledOnce();
  });
});

describe('externalFailureRecovery config shape', () => {
  const testDir = join(tmpdir(), `invoker-efr-config-test-${process.pid}-${Date.now()}`);
  const configPath = join(testDir, 'config.json');

  it('round-trips through loadConfig via INVOKER_REPO_CONFIG_PATH', async () => {
    mkdirSync(testDir, { recursive: true });
    try {
      writeFileSync(
        configPath,
        JSON.stringify({
          externalFailureRecovery: {
            enabled: true,
            command: '/usr/local/bin/recover.sh',
            cwd: '/var/recovery',
            cooldownSeconds: 60,
          },
        }),
      );
      const prev = process.env.INVOKER_REPO_CONFIG_PATH;
      process.env.INVOKER_REPO_CONFIG_PATH = configPath;
      try {
        const { loadConfig } = await import('../config.js');
        const config = loadConfig();
        expect(config.externalFailureRecovery).toEqual({
          enabled: true,
          command: '/usr/local/bin/recover.sh',
          cwd: '/var/recovery',
          cooldownSeconds: 60,
        });
      } finally {
        if (prev === undefined) delete process.env.INVOKER_REPO_CONFIG_PATH;
        else process.env.INVOKER_REPO_CONFIG_PATH = prev;
      }
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});
