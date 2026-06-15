import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect } from 'vitest';
import { IpcBus, LocalBus } from '@invoker/transport';

import {
  discoverOwner,
  discoverStandaloneOwner,
  isOwnerReachable,
  isStandaloneCapable,
  type OwnerEndpointInfo,
} from '../owner-endpoint.js';

describe('owner-endpoint contract', () => {
  describe('discoverOwner', () => {
    it('returns null when no owner responds within the timeout', async () => {
      const bus = new LocalBus();
      const result = await discoverOwner(bus, 200);
      expect(result).toBeNull();
    });

    it('returns OwnerEndpointInfo with canAcceptStandaloneMutations=true for standalone owners', async () => {
      const bus = new LocalBus();
      bus.onRequest('headless.owner-ping', async () => ({
        ok: true,
        ownerId: 'owner-123',
        mode: 'standalone',
      }));

      const result = await discoverOwner(bus);
      expect(result).not.toBeNull();
      expect(result!.ownerId).toBe('owner-123');
      expect(result!.canAcceptStandaloneMutations).toBe(true);
    });

    it('returns OwnerEndpointInfo with canAcceptStandaloneMutations=false for non-standalone owners', async () => {
      const bus = new LocalBus();
      bus.onRequest('headless.owner-ping', async () => ({
        ok: true,
        ownerId: 'owner-456',
        mode: 'gui',
      }));

      const result = await discoverOwner(bus);
      expect(result).not.toBeNull();
      expect(result!.ownerId).toBe('owner-456');
      expect(result!.canAcceptStandaloneMutations).toBe(false);
    });

    it('does not expose the raw mode string in the returned contract', async () => {
      const bus = new LocalBus();
      bus.onRequest('headless.owner-ping', async () => ({
        ok: true,
        ownerId: 'owner-789',
        mode: 'gui',
      }));

      const result = await discoverOwner(bus);
      expect(result).not.toBeNull();
      // The contract type should not have a `mode` field
      expect('mode' in result!).toBe(false);
    });

    it('defaults ownerId to empty string when the ping response omits it', async () => {
      const bus = new LocalBus();
      bus.onRequest('headless.owner-ping', async () => ({
        ok: true,
        mode: 'standalone',
      }));

      const result = await discoverOwner(bus);
      expect(result).not.toBeNull();
      expect(result!.ownerId).toBe('');
      expect(result!.canAcceptStandaloneMutations).toBe(true);
    });

    it('discovers a standalone peer when a GUI owner is the IPC server', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'owner-endpoint-'));
      const socketPath = join(dir, 'ipc.sock');
      const guiServer = new IpcBus(socketPath);
      let standalonePeer: IpcBus | null = null;
      let client: IpcBus | null = null;

      try {
        await guiServer.ready();
        guiServer.onRequest('headless.owner-ping', async () => ({
          ok: true,
          ownerId: 'owner-gui',
          mode: 'gui',
        }));

        standalonePeer = new IpcBus(socketPath);
        await standalonePeer.ready();
        standalonePeer.onRequest('headless.owner-ping', async () => ({
          ok: true,
          ownerId: 'owner-daemon',
          mode: 'standalone',
        }));
        standalonePeer.onRequest('headless.owner-ping.standalone', async () => ({
          ok: true,
          ownerId: 'owner-daemon',
          mode: 'standalone',
        }));

        client = new IpcBus(socketPath, { allowServe: false });
        await client.ready();

        const generic = await discoverOwner(client, 1_000);
        expect(generic?.ownerId).toBe('owner-gui');
        expect(generic?.canAcceptStandaloneMutations).toBe(false);

        const standalone = await discoverStandaloneOwner(client, 1_000);
        expect(standalone?.ownerId).toBe('owner-daemon');
        expect(standalone?.canAcceptStandaloneMutations).toBe(true);
      } finally {
        client?.disconnect();
        standalonePeer?.disconnect();
        guiServer.disconnect();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('isStandaloneCapable', () => {
    it('returns true for standalone-capable owners', () => {
      const owner: OwnerEndpointInfo = {
        ownerId: 'owner-1',
        canAcceptStandaloneMutations: true,
      };
      expect(isStandaloneCapable(owner)).toBe(true);
    });

    it('returns false for non-standalone owners', () => {
      const owner: OwnerEndpointInfo = {
        ownerId: 'owner-2',
        canAcceptStandaloneMutations: false,
      };
      expect(isStandaloneCapable(owner)).toBe(false);
    });

    it('returns false for null (no owner reachable)', () => {
      expect(isStandaloneCapable(null)).toBe(false);
    });
  });

  describe('isOwnerReachable', () => {
    it('returns true for any non-null owner', () => {
      const standaloneOwner: OwnerEndpointInfo = {
        ownerId: 'owner-1',
        canAcceptStandaloneMutations: true,
      };
      const transientOwner: OwnerEndpointInfo = {
        ownerId: 'owner-2',
        canAcceptStandaloneMutations: false,
      };
      expect(isOwnerReachable(standaloneOwner)).toBe(true);
      expect(isOwnerReachable(transientOwner)).toBe(true);
    });

    it('returns false for null', () => {
      expect(isOwnerReachable(null)).toBe(false);
    });
  });

  describe('surface neutrality', () => {
    it('treats any owner with mode !== standalone as non-standalone-capable', async () => {
      const bus = new LocalBus();
      // Hypothetical future mode — the contract should not care
      bus.onRequest('headless.owner-ping', async () => ({
        ok: true,
        ownerId: 'owner-future',
        mode: 'some-new-surface',
      }));

      const result = await discoverOwner(bus);
      expect(result).not.toBeNull();
      expect(result!.canAcceptStandaloneMutations).toBe(false);
      expect(isOwnerReachable(result)).toBe(true);
      expect(isStandaloneCapable(result)).toBe(false);
    });

    it('client code uses capability predicates instead of raw mode strings', () => {
      // This test documents the contract guarantee: the OwnerEndpointInfo
      // type has no `mode` field. Client code uses capability predicates.
      const info: OwnerEndpointInfo = {
        ownerId: 'owner-1',
        canAcceptStandaloneMutations: true,
      };
      // Type-level: 'mode' is not a key of OwnerEndpointInfo
      const keys = Object.keys(info);
      expect(keys).toContain('ownerId');
      expect(keys).toContain('canAcceptStandaloneMutations');
      expect(keys).not.toContain('mode');
    });
  });
});
