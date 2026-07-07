import { spawn, type ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createInvokerLauncher } from '../invoker-launcher.js';

vi.mock('node:fs', () => ({
  openSync: vi.fn(() => 99),
}));

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => ({ pid: 123, exitCode: null, unref: vi.fn() } as unknown as ChildProcess)),
}));

const STRIPPED_ENV_KEYS = [
  'SLACK_BOT_TOKEN',
  'SLACK_APP_TOKEN',
  'SLACK_SIGNING_SECRET',
  'SLACK_CHANNEL_ID',
  'SLACK_LOBBY_CHANNEL_ID',
  'INVOKER_REPO_CONFIG_PATH',
  'INVOKER_CONFIG',
] as const;

describe('createInvokerLauncher', () => {
  const savedEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...savedEnv };
    vi.clearAllMocks();
  });

  it('strips Slack secrets and config overrides from spawned GUI env', () => {
    for (const key of STRIPPED_ENV_KEYS) process.env[key] = `${key}-value`;

    createInvokerLauncher({
      repoRoot: '/repo',
      logPath: '/tmp/invoker.log',
      log: vi.fn(),
    }).spawnInvoker();

    expect(spawn).toHaveBeenCalledTimes(1);
    const options = vi.mocked(spawn).mock.calls[0]?.[2];
    expect(options?.env).toBeDefined();
    for (const key of STRIPPED_ENV_KEYS) {
      expect(options?.env).not.toHaveProperty(key);
    }
    expect(options?.env).toMatchObject({ LIBGL_ALWAYS_SOFTWARE: '1' });
  });
});
