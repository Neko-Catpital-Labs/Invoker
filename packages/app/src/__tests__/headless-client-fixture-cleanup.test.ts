import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', () => ({
  readdir: vi.fn(async () => []),
  readFile: vi.fn(),
  writeFile: vi.fn(async () => undefined),
}));

vi.mock('node:timers/promises', () => ({
  setTimeout: vi.fn(async () => undefined),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: vi.fn(() => ({ unref: vi.fn() })),
  };
});

import { readdir, readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { spawn } from 'node:child_process';
import { cleanupStandaloneOwnersForTestDir, headlessTestEnv } from '../../e2e/fixtures/headless-client.js';
import {
  OwnerChildProfileError,
  resolveDetachedOwnerCommand,
  resolveOwnerChildProfileEnv,
  spawnDetachedStandaloneOwner,
} from '../headless-owner-bootstrap.js';

describe('cleanupStandaloneOwnersForTestDir', () => {
  const linuxIt = process.platform === 'linux' ? it : it.skip;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('skips the grace delay when no standalone owners match the test dir', async () => {
    await cleanupStandaloneOwnersForTestDir('/tmp/invoker-no-owner-test-dir');

    if (process.platform === 'linux') {
      expect(readdir).toHaveBeenCalledWith('/proc');
    }
    expect(readFile).not.toHaveBeenCalled();
    expect(delay).not.toHaveBeenCalled();
  });

  linuxIt('revalidates the same standalone owner identity before SIGKILL escalation', async () => {
    const testDir = '/tmp/invoker-owner-test-dir';
    const ipcSocketPath = `${testDir}/ipc-transport.sock`;
    const cmdline = 'node packages/app/dist/main.js --headless owner-serve';
    vi.mocked(readdir).mockResolvedValue(['123']);
    vi.mocked(readFile)
      .mockResolvedValueOnce(cmdline)
      .mockResolvedValueOnce(`INVOKER_DB_DIR=${testDir}\0INVOKER_IPC_SOCKET=${ipcSocketPath}\0`)
      .mockResolvedValueOnce(cmdline)
      .mockResolvedValueOnce(`INVOKER_DB_DIR=${testDir}\0INVOKER_IPC_SOCKET=${ipcSocketPath}\0`);
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);

    await cleanupStandaloneOwnersForTestDir(testDir);

    expect(kill).toHaveBeenCalledWith(123, 'SIGTERM');
    expect(kill).toHaveBeenCalledWith(123, 0);
    expect(kill).toHaveBeenCalledWith(123, 'SIGKILL');
  });

  linuxIt('does not SIGKILL when a PID no longer matches the captured owner identity', async () => {
    const testDir = '/tmp/invoker-reused-pid-test-dir';
    const cmdline = 'node packages/app/dist/main.js --headless owner-serve';
    vi.mocked(readdir).mockResolvedValue(['123']);
    vi.mocked(readFile)
      .mockResolvedValueOnce(cmdline)
      .mockResolvedValueOnce(`INVOKER_DB_DIR=${testDir}\0`)
      .mockResolvedValueOnce('node unrelated.js');
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);

    await cleanupStandaloneOwnersForTestDir(testDir);

    expect(kill).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith(123, 'SIGTERM');
    expect(kill).not.toHaveBeenCalledWith(123, 0);
    expect(kill).not.toHaveBeenCalledWith(123, 'SIGKILL');
  });
});

describe('detached owner child profile identity', () => {
  const sourceDevelopmentEnv = {
    INVOKER_RUNTIME_KIND: 'source-development',
    INVOKER_DEVELOPMENT_PROFILE: '1',
    INVOKER_DEVELOPMENT_PROFILE_ACTIVE: '1',
    INVOKER_SOURCE_ROOT: '/repo/checkout',
    INVOKER_PROFILE_ID: 'abc1234567',
    INVOKER_DB_DIR: '/Users/dev/.invoker/dev/abc1234567',
    INVOKER_USER_DATA_DIR: '/Users/dev/.invoker/dev/abc1234567/electron',
    INVOKER_IPC_SOCKET: '/Users/dev/.invoker/dev/abc1234567/ipc-transport.sock',
    INVOKER_REPO_CONFIG_PATH: '/Users/dev/.invoker/dev/abc1234567/config.json',
    INVOKER_ENV_PATH: '/Users/dev/.invoker/dev/abc1234567/.env',
    INVOKER_LOG_PATH: '/Users/dev/.invoker/dev/abc1234567/invoker.log',
    INVOKER_API_PORT: '41123',
    INVOKER_WEB_PORT: '42123',
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes production identity from a packaged parent to the child', () => {
    const childEnv = resolveOwnerChildProfileEnv({});

    expect(childEnv).toEqual({ INVOKER_RUNTIME_KIND: 'packaged' });
  });

  it('launches main.js directly when the parent process is Electron', () => {
    expect(resolveDetachedOwnerCommand('/repo/checkout', {
      executablePath: '/electron',
      isElectron: true,
      platform: 'linux',
    })).toEqual({
      command: '/electron',
      args: [
        '--no-sandbox',
        '/repo/checkout/packages/app/dist/main.js',
        '--headless',
        'owner-serve',
      ],
    });
  });

  it('keeps the launcher wrapper when the parent process is Node', () => {
    expect(resolveDetachedOwnerCommand('/repo/checkout', {
      executablePath: '/node',
      isElectron: false,
      platform: 'linux',
    })).toEqual({
      command: '/node',
      args: [
        '/repo/checkout/scripts/electron.cjs',
        '--no-sandbox',
        '/repo/checkout/packages/app/dist/main.js',
        '--headless',
        'owner-serve',
      ],
    });
  });

  it('passes the same source profile and disjoint locations from a source-development parent to the child', () => {
    const childEnv = resolveOwnerChildProfileEnv(sourceDevelopmentEnv);

    expect(childEnv).toEqual({ INVOKER_RUNTIME_KIND: 'source-development', ...sourceDevelopmentEnv });
    expect(childEnv.INVOKER_DB_DIR).not.toBe('/Users/dev/.invoker');
    expect(childEnv.INVOKER_IPC_SOCKET).not.toBe('/Users/dev/.invoker/ipc-transport.sock');
  });

  it('gives headless E2E clients a complete source-development profile', () => {
    const testDir = '/tmp/invoker-headless-profile-test';
    const env = headlessTestEnv(testDir);

    expect(env).toMatchObject({
      INVOKER_RUNTIME_KIND: 'source-development',
      INVOKER_DEVELOPMENT_PROFILE: '1',
      INVOKER_DEVELOPMENT_PROFILE_ACTIVE: '1',
      INVOKER_DB_DIR: testDir,
      INVOKER_IPC_SOCKET: `${testDir}/ipc-transport.sock`,
      INVOKER_REPO_CONFIG_PATH: `${testDir}/e2e-config.json`,
    });
  });

  it('fails before spawn when a source-development parent has a partial profile', () => {
    const { INVOKER_DB_DIR: _drop, ...partialEnv } = sourceDevelopmentEnv;

    expect(() => resolveOwnerChildProfileEnv(partialEnv)).toThrow(OwnerChildProfileError);
  });

  it('fails before spawn when settings declare contradictory profiles', () => {
    const contradictoryEnv = { ...sourceDevelopmentEnv, INVOKER_RUNTIME_KIND: 'packaged' };

    expect(() => resolveOwnerChildProfileEnv(contradictoryEnv)).toThrow(OwnerChildProfileError);
  });

  it('spawnDetachedStandaloneOwner does not spawn a child when the profile is contradictory', () => {
    const previousEnv = { ...process.env };
    Object.assign(process.env, { ...sourceDevelopmentEnv, INVOKER_RUNTIME_KIND: 'packaged' });

    try {
      expect(() => spawnDetachedStandaloneOwner('/repo/checkout')).toThrow(OwnerChildProfileError);
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      for (const key of Object.keys(sourceDevelopmentEnv)) delete process.env[key];
      Object.assign(process.env, previousEnv);
    }
  });
});
