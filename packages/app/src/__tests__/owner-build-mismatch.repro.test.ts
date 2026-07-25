import { describe, it, expect } from 'vitest';
import { LocalBus } from '@invoker/transport';

import { discoverOwner, isStandaloneCapable } from '../owner-endpoint.js';

/**
 * Repro for the incident where a GUI dev build silently delegated to a
 * stale, globally-installed Invoker owner process (an older, differently
 * versioned build). The owner didn't recognize newer IPC commands
 * ('invoker:planning-chat-list', 'review-gate', 'worker-decisions') and
 * threw a fresh "Unsupported X" error for every single one, instead of one
 * clear "these two processes are incompatible" failure up front.
 *
 * `discoverOwner` now carries build identity (version + git sha, stamped by
 * tsup at build time — see build-identity.ts) in the owner-ping handshake
 * and refuses to mark a mismatched owner as standalone-capable.
 */
describe('owner build-mismatch invariant', () => {
  it('refuses to delegate to an owner that predates the build-identity field (the real incident)', async () => {
    const bus = new LocalBus();
    // Simulates the old globally-installed Invoker.app (v0.0.5): it answers
    // the owner-ping handshake, but its response has no buildVersion/buildSha
    // at all, because that build predates this check.
    bus.onRequest('headless.owner-ping', async () => ({
      ok: true,
      ownerId: 'owner-87196-1784969265739',
      mode: 'standalone',
    }));

    const localBuild = { version: '0.0.8', sha: 'abc1234' };
    const owner = await discoverOwner(bus, 200, localBuild);

    expect(isStandaloneCapable(owner)).toBe(false);
    expect(owner?.buildMismatchReason).toContain('predates this compatibility check');
  });

  it('refuses to delegate to an owner running a different commit', async () => {
    const bus = new LocalBus();
    bus.onRequest('headless.owner-ping', async () => ({
      ok: true,
      ownerId: 'owner-1',
      mode: 'standalone',
      buildVersion: '0.0.7',
      buildSha: 'deadbee',
    }));

    const localBuild = { version: '0.0.8', sha: 'abc1234' };
    const owner = await discoverOwner(bus, 200, localBuild);

    expect(isStandaloneCapable(owner)).toBe(false);
    expect(owner?.buildMismatchReason).toContain('0.0.7 (deadbee)');
  });

  it('delegates normally once both processes report the same build', async () => {
    const bus = new LocalBus();
    bus.onRequest('headless.owner-ping', async () => ({
      ok: true,
      ownerId: 'owner-1',
      mode: 'standalone',
      buildVersion: '0.0.8',
      buildSha: 'abc1234',
    }));

    const localBuild = { version: '0.0.8', sha: 'abc1234' };
    const owner = await discoverOwner(bus, 200, localBuild);

    expect(isStandaloneCapable(owner)).toBe(true);
    expect(owner?.buildMismatchReason).toBeFalsy();
  });
});
