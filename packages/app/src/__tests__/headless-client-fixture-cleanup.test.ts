import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', () => ({
  readdir: vi.fn(async () => []),
  readFile: vi.fn(),
  writeFile: vi.fn(async () => undefined),
}));

vi.mock('node:timers/promises', () => ({
  setTimeout: vi.fn(async () => undefined),
}));

import { readdir, readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { cleanupStandaloneOwnersForTestDir } from '../../e2e/fixtures/headless-client.js';

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
