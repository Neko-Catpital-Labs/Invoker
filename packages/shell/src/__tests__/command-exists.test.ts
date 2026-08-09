import { describe, expect, it, vi, beforeEach } from 'vitest';

const spawnSyncMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({
  spawnSync: spawnSyncMock,
}));

import { commandExists } from '../command-exists.ts';

describe('commandExists', () => {
  beforeEach(() => {
    spawnSyncMock.mockReset();
  });

  it('passes the command as a shell positional argument', () => {
    spawnSyncMock.mockReturnValue({ status: 0 });

    expect(commandExists('x; touch /tmp/command-injection')).toBe(true);

    expect(spawnSyncMock).toHaveBeenCalledWith(
      'sh',
      ['-c', 'command -v "$1" >/dev/null 2>&1', 'sh', 'x; touch /tmp/command-injection'],
      { stdio: 'ignore' },
    );
  });

  it('returns false when POSIX sh is unavailable', () => {
    spawnSyncMock.mockReturnValue({ status: null });

    expect(commandExists('codex')).toBe(false);
  });
});
