import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LocalBus } from '@invoker/transport';

// Isolated in its own file (not headless-client.test.ts) because it mocks
// build-identity.js at module scope -- vitest scopes vi.mock to the file it
// appears in, so this cannot leak into the large shared test file.
vi.mock('../build-identity.js', async () => {
  const actual = await vi.importActual<typeof import('../build-identity.js')>('../build-identity.js');
  return {
    ...actual,
    currentBuildIdentity: () => ({ version: '1.0.0', sha: 'local-sha-aaa' }),
  };
});

import { tryAcquireOwnerBootstrapLock } from '../headless-owner-bootstrap.js';
import { OwnerBuildMismatchError, ensureStandaloneOwnerViaBootstrap } from '../headless-client.js';

describe('ensureStandaloneOwnerViaBootstrap build-mismatch handling', () => {
  const savedDbDir = process.env.INVOKER_DB_DIR;
  const savedTimeout = process.env.INVOKER_HEADLESS_OWNER_BOOTSTRAP_TIMEOUT_MS;
  let dbDir: string;

  beforeEach(() => {
    dbDir = mkdtempSync(join(tmpdir(), 'headless-client-build-mismatch-'));
    process.env.INVOKER_DB_DIR = dbDir;
    // Short timeout as a safety net -- the fix should return in well under
    // this, but a regression back to "poll until timeout" would still fail
    // the test (just slowly) instead of hanging indefinitely.
    process.env.INVOKER_HEADLESS_OWNER_BOOTSTRAP_TIMEOUT_MS = '5000';
  });

  afterEach(() => {
    if (savedDbDir === undefined) delete process.env.INVOKER_DB_DIR;
    else process.env.INVOKER_DB_DIR = savedDbDir;
    if (savedTimeout === undefined) delete process.env.INVOKER_HEADLESS_OWNER_BOOTSTRAP_TIMEOUT_MS;
    else process.env.INVOKER_HEADLESS_OWNER_BOOTSTRAP_TIMEOUT_MS = savedTimeout;
    rmSync(dbDir, { recursive: true, force: true });
  });

  it('fails fast with OwnerBuildMismatchError instead of polling until timeout', async () => {
    // Hold the bootstrap lock ourselves so the function under test sees
    // lockAcquired=false and never spawns a real detached owner process.
    const heldLock = tryAcquireOwnerBootstrapLock(dbDir);
    expect(heldLock).not.toBeNull();

    const bus = new LocalBus();
    bus.onRequest('headless.owner-ping', async () => ({
      ok: true,
      ownerId: 'owner-mismatched',
      mode: 'standalone',
      buildVersion: '1.0.0',
      buildSha: 'remote-sha-bbb',
    }));

    const startedAt = Date.now();
    let thrown: unknown;
    try {
      await ensureStandaloneOwnerViaBootstrap(bus);
    } catch (err) {
      thrown = err;
    }
    const elapsedMs = Date.now() - startedAt;
    heldLock?.release();

    expect(thrown).toBeInstanceOf(OwnerBuildMismatchError);
    expect((thrown as Error).message).toContain('remote-sha-bbb');
    expect((thrown as Error).message).toContain('local-sha-aaa');
    // Must fail almost immediately, not after waiting out the whole
    // 5s bootstrap timeout window.
    expect(elapsedMs).toBeLessThan(2_000);
  }, 10_000);

  it('still succeeds normally when the discovered owner build matches', async () => {
    const heldLock = tryAcquireOwnerBootstrapLock(dbDir);
    expect(heldLock).not.toBeNull();

    const bus = new LocalBus();
    bus.onRequest('headless.owner-ping', async () => ({
      ok: true,
      ownerId: 'owner-matched',
      mode: 'standalone',
      buildVersion: '1.0.0',
      buildSha: 'local-sha-aaa',
    }));

    await expect(ensureStandaloneOwnerViaBootstrap(bus)).resolves.toBeUndefined();
    heldLock?.release();
  }, 10_000);
});
