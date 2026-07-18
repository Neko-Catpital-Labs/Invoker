import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  OWNER_BOOTSTRAP_LOCK_DIR,
  tryAcquireOwnerBootstrapLock,
} from '../headless-owner-bootstrap.js';

describe('headless-owner-bootstrap', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const tempDir of tempDirs.splice(0)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  function makeTempHome(): string {
    const tempDir = mkdtempSync(join(tmpdir(), 'invoker-owner-bootstrap-'));
    tempDirs.push(tempDir);
    return tempDir;
  }

  it('serializes concurrent bootstrap attempts with a process pid lock', () => {
    const home = makeTempHome();
    const firstLock = tryAcquireOwnerBootstrapLock(home);

    expect(firstLock).not.toBeNull();
    expect(tryAcquireOwnerBootstrapLock(home)).toBeNull();

    firstLock?.release();
    expect(existsSync(join(home, OWNER_BOOTSTRAP_LOCK_DIR))).toBe(false);
  });

  it('recovers from a stale lock directory with no pid file', () => {
    const home = makeTempHome();
    mkdirSync(join(home, OWNER_BOOTSTRAP_LOCK_DIR));

    const lock = tryAcquireOwnerBootstrapLock(home);

    expect(lock).not.toBeNull();
    expect(existsSync(join(home, OWNER_BOOTSTRAP_LOCK_DIR, 'pid'))).toBe(true);
    lock?.release();
  });

  it('creates the invoker home root before acquiring the lock', () => {
    const parent = makeTempHome();
    const missingHome = join(parent, 'missing-home');

    const lock = tryAcquireOwnerBootstrapLock(missingHome);

    expect(lock).not.toBeNull();
    expect(existsSync(join(missingHome, OWNER_BOOTSTRAP_LOCK_DIR, 'pid'))).toBe(true);
    lock?.release();
  });
});
