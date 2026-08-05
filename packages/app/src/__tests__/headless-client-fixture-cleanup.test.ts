import { describe, expect, it, vi } from 'vitest';

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
  it('skips the grace delay when no standalone owners match the test dir', async () => {
    await cleanupStandaloneOwnersForTestDir('/tmp/invoker-no-owner-test-dir');

    if (process.platform === 'linux') {
      expect(readdir).toHaveBeenCalledWith('/proc');
    }
    expect(readFile).not.toHaveBeenCalled();
    expect(delay).not.toHaveBeenCalled();
  });
});
