import { describe, it, expect, vi } from 'vitest';
import { LocalBus } from '@invoker/transport';

import { createOwnerResolver } from '../owner-resolver.js';

describe('owner-resolver', () => {
  describe('discover', () => {
    it('returns resolved owner when a standalone-capable owner responds', async () => {
      const bus = new LocalBus();
      bus.onRequest('headless.owner-ping', async () => ({
        ok: true,
        ownerId: 'owner-1',
        mode: 'standalone',
      }));

      const resolver = createOwnerResolver({
        messageBus: bus,
        ensureStandaloneOwner: vi.fn(),
      });

      const result = await resolver.discover();
      expect(result.resolved).toBe(true);
      if (result.resolved) {
        expect(result.owner.ownerId).toBe('owner-1');
        expect(result.owner.canAcceptStandaloneMutations).toBe(true);
      }
    });

    it('returns not-resolved when no owner responds', async () => {
      const bus = new LocalBus();
      const resolver = createOwnerResolver({
        messageBus: bus,
        ensureStandaloneOwner: vi.fn(),
      }, { discoveryTimeoutMs: 200 });

      const result = await resolver.discover();
      expect(result.resolved).toBe(false);
    });

    it('returns not-resolved for a GUI owner (not standalone-capable)', async () => {
      const bus = new LocalBus();
      bus.onRequest('headless.owner-ping', async () => ({
        ok: true,
        ownerId: 'owner-gui',
        mode: 'gui',
      }));

      const resolver = createOwnerResolver({
        messageBus: bus,
        ensureStandaloneOwner: vi.fn(),
      });

      const result = await resolver.discover();
      expect(result.resolved).toBe(false);
    });
  });

  describe('discoverAny', () => {
    it('returns a GUI owner as resolved', async () => {
      const bus = new LocalBus();
      bus.onRequest('headless.owner-ping', async () => ({
        ok: true,
        ownerId: 'owner-gui',
        mode: 'gui',
      }));

      const resolver = createOwnerResolver({
        messageBus: bus,
        ensureStandaloneOwner: vi.fn(),
      });

      const result = await resolver.discoverAny();
      expect(result.resolved).toBe(true);
      if (result.resolved) {
        expect(result.owner.ownerId).toBe('owner-gui');
        expect(result.owner.canAcceptStandaloneMutations).toBe(false);
      }
    });

    it('returns not-resolved when no owner responds', async () => {
      const bus = new LocalBus();
      const resolver = createOwnerResolver({
        messageBus: bus,
        ensureStandaloneOwner: vi.fn(),
      }, { discoveryTimeoutMs: 200 });

      const result = await resolver.discoverAny();
      expect(result.resolved).toBe(false);
    });
  });

  describe('refreshAndDiscover', () => {
    it('uses refreshed bus for discovery', async () => {
      const firstBus = new LocalBus();
      const secondBus = new LocalBus();
      secondBus.onRequest('headless.owner-ping', async () => ({
        ok: true,
        ownerId: 'owner-refreshed',
        mode: 'standalone',
      }));

      const refreshMessageBus = vi.fn().mockResolvedValue(secondBus);
      const resolver = createOwnerResolver({
        messageBus: firstBus,
        refreshMessageBus,
        ensureStandaloneOwner: vi.fn(),
      });

      const result = await resolver.refreshAndDiscover();
      expect(result.resolved).toBe(true);
      if (result.resolved) {
        expect(result.owner.ownerId).toBe('owner-refreshed');
        expect(result.bus).toBe(secondBus);
      }
      expect(refreshMessageBus).toHaveBeenCalledTimes(1);
    });

    it('uses original bus when no refreshMessageBus is provided', async () => {
      const bus = new LocalBus();
      bus.onRequest('headless.owner-ping', async () => ({
        ok: true,
        ownerId: 'owner-same',
        mode: 'standalone',
      }));

      const resolver = createOwnerResolver({
        messageBus: bus,
        ensureStandaloneOwner: vi.fn(),
      });

      const result = await resolver.refreshAndDiscover();
      expect(result.resolved).toBe(true);
      if (result.resolved) {
        expect(result.bus).toBe(bus);
      }
    });
  });

  describe('waitForAny', () => {
    it('returns immediately when an owner is already reachable', async () => {
      const bus = new LocalBus();
      bus.onRequest('headless.owner-ping', async () => ({
        ok: true,
        ownerId: 'owner-fast',
        mode: 'gui',
      }));

      const resolver = createOwnerResolver({
        messageBus: bus,
        ensureStandaloneOwner: vi.fn(),
      });

      const result = await resolver.waitForAny(5_000);
      expect(result.resolved).toBe(true);
    });

    it('polls until an owner appears', async () => {
      const bus = new LocalBus();
      let pingCount = 0;
      bus.onRequest('headless.owner-ping', async () => {
        pingCount += 1;
        if (pingCount >= 3) {
          return { ok: true, ownerId: 'owner-delayed', mode: 'standalone' };
        }
        return null;
      });

      const resolver = createOwnerResolver({
        messageBus: bus,
        ensureStandaloneOwner: vi.fn(),
      });

      const result = await resolver.waitForAny(10_000);
      expect(result.resolved).toBe(true);
      expect(pingCount).toBeGreaterThanOrEqual(3);
    });

    it('returns not-resolved after timeout', async () => {
      const bus = new LocalBus();
      const resolver = createOwnerResolver({
        messageBus: bus,
        ensureStandaloneOwner: vi.fn(),
      }, { discoveryTimeoutMs: 100 });

      const result = await resolver.waitForAny(500);
      expect(result.resolved).toBe(false);
    });
  });

  describe('waitForStandalone', () => {
    it('skips GUI owners and waits for standalone', async () => {
      const bus = new LocalBus();
      let pingCount = 0;
      bus.onRequest('headless.owner-ping', async () => {
        pingCount += 1;
        if (pingCount >= 3) {
          return { ok: true, ownerId: 'owner-standalone', mode: 'standalone' };
        }
        return { ok: true, ownerId: 'owner-gui', mode: 'gui' };
      });

      const resolver = createOwnerResolver({
        messageBus: bus,
        ensureStandaloneOwner: vi.fn(),
      });

      const result = await resolver.waitForStandalone(10_000);
      expect(result.resolved).toBe(true);
      if (result.resolved) {
        expect(result.owner.canAcceptStandaloneMutations).toBe(true);
      }
    });

    it('returns not-resolved after timeout when only GUI owners available', async () => {
      const bus = new LocalBus();
      bus.onRequest('headless.owner-ping', async () => ({
        ok: true,
        ownerId: 'owner-gui',
        mode: 'gui',
      }));

      const resolver = createOwnerResolver({
        messageBus: bus,
        ensureStandaloneOwner: vi.fn(),
      });

      const result = await resolver.waitForStandalone(500);
      expect(result.resolved).toBe(false);
    });
  });

  describe('resolve', () => {
    it('returns immediately when a standalone owner is already available', async () => {
      const bus = new LocalBus();
      bus.onRequest('headless.owner-ping', async () => ({
        ok: true,
        ownerId: 'owner-1',
        mode: 'standalone',
      }));

      const ensureStandaloneOwner = vi.fn();
      const resolver = createOwnerResolver({
        messageBus: bus,
        ensureStandaloneOwner,
      });

      const result = await resolver.resolve();
      expect(result.owner.ownerId).toBe('owner-1');
      expect(result.owner.canAcceptStandaloneMutations).toBe(true);
      expect(ensureStandaloneOwner).not.toHaveBeenCalled();
    });

    it('bootstraps when no owner is initially available', async () => {
      const bus = new LocalBus();
      let bootstrapped = false;

      const ensureStandaloneOwner = vi.fn(async () => {
        bootstrapped = true;
        bus.onRequest('headless.owner-ping', async () => ({
          ok: true,
          ownerId: 'owner-bootstrapped',
          mode: 'standalone',
        }));
      });

      const resolver = createOwnerResolver({
        messageBus: bus,
        ensureStandaloneOwner,
      }, {
        discoveryTimeoutMs: 200,
        postBootstrapReadyTimeoutMs: 5_000,
      });

      const result = await resolver.resolve();
      expect(bootstrapped).toBe(true);
      expect(result.owner.ownerId).toBe('owner-bootstrapped');
      expect(ensureStandaloneOwner).toHaveBeenCalledTimes(1);
    });

    it('retries bootstrap when the first attempt does not produce a reachable owner', async () => {
      const bus = new LocalBus();
      let bootstrapCalls = 0;

      const ensureStandaloneOwner = vi.fn(async () => {
        bootstrapCalls += 1;
        if (bootstrapCalls >= 2) {
          bus.onRequest('headless.owner-ping', async () => ({
            ok: true,
            ownerId: 'owner-retry',
            mode: 'standalone',
          }));
        }
      });

      const resolver = createOwnerResolver({
        messageBus: bus,
        ensureStandaloneOwner,
      }, {
        discoveryTimeoutMs: 200,
        postBootstrapReadyTimeoutMs: 500,
        maxBootstrapAttempts: 3,
      });

      const result = await resolver.resolve();
      expect(result.owner.ownerId).toBe('owner-retry');
      expect(bootstrapCalls).toBe(2);
    });

    it('throws after exhausting all bootstrap attempts', async () => {
      const bus = new LocalBus();
      const ensureStandaloneOwner = vi.fn(async () => {});

      const resolver = createOwnerResolver({
        messageBus: bus,
        ensureStandaloneOwner,
      }, {
        discoveryTimeoutMs: 100,
        postBootstrapReadyTimeoutMs: 200,
        maxBootstrapAttempts: 2,
      });

      await expect(resolver.resolve()).rejects.toThrow(
        /Could not resolve a standalone-capable owner/,
      );
      expect(ensureStandaloneOwner).toHaveBeenCalledTimes(2);
    });

    it('refreshes the bus between bootstrap attempts', async () => {
      const firstBus = new LocalBus();
      const secondBus = new LocalBus();
      let bootstrapCalls = 0;

      secondBus.onRequest('headless.owner-ping', async () => ({
        ok: true,
        ownerId: 'owner-on-second-bus',
        mode: 'standalone',
      }));

      const refreshMessageBus = vi.fn().mockResolvedValue(secondBus);
      const ensureStandaloneOwner = vi.fn(async () => {
        bootstrapCalls += 1;
      });

      const resolver = createOwnerResolver({
        messageBus: firstBus,
        refreshMessageBus,
        ensureStandaloneOwner,
      }, {
        discoveryTimeoutMs: 200,
        postBootstrapReadyTimeoutMs: 2_000,
      });

      const result = await resolver.resolve();
      expect(result.owner.ownerId).toBe('owner-on-second-bus');
      expect(refreshMessageBus).toHaveBeenCalled();
    });

    it('accepts any reachable owner when requireStandalone=false', async () => {
      const bus = new LocalBus();
      bus.onRequest('headless.owner-ping', async () => ({
        ok: true,
        ownerId: 'owner-gui',
        mode: 'gui',
      }));

      const ensureStandaloneOwner = vi.fn();
      const resolver = createOwnerResolver({
        messageBus: bus,
        ensureStandaloneOwner,
      });

      const result = await resolver.resolve(false);
      expect(result.owner.ownerId).toBe('owner-gui');
      expect(result.owner.canAcceptStandaloneMutations).toBe(false);
      expect(ensureStandaloneOwner).not.toHaveBeenCalled();
    });
  });

  describe('surface neutrality', () => {
    it('never exposes mode strings in resolved results', async () => {
      const bus = new LocalBus();
      bus.onRequest('headless.owner-ping', async () => ({
        ok: true,
        ownerId: 'owner-1',
        mode: 'standalone',
      }));

      const resolver = createOwnerResolver({
        messageBus: bus,
        ensureStandaloneOwner: vi.fn(),
      });

      const result = await resolver.discover();
      expect(result.resolved).toBe(true);
      if (result.resolved) {
        expect('mode' in result.owner).toBe(false);
        expect(Object.keys(result.owner)).toEqual(['ownerId', 'canAcceptStandaloneMutations']);
      }
    });

    it('result contains bus handle but no GUI/headless flags', async () => {
      const bus = new LocalBus();
      bus.onRequest('headless.owner-ping', async () => ({
        ok: true,
        ownerId: 'owner-1',
        mode: 'standalone',
      }));

      const resolver = createOwnerResolver({
        messageBus: bus,
        ensureStandaloneOwner: vi.fn(),
      });

      const result = await resolver.discover();
      expect(result.resolved).toBe(true);
      if (result.resolved) {
        expect(result.bus).toBeDefined();
        expect('isGui' in result).toBe(false);
        expect('isHeadless' in result).toBe(false);
        expect('surface' in result).toBe(false);
      }
    });
  });
});
