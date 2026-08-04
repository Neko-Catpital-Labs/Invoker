import { mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { IpcBus } from '@invoker/transport';
import { createOwnerSocketSentinel } from '../owner-socket-sentinel.js';

function noopLog(): void {}

describe('createOwnerSocketSentinel', () => {
  it('does not re-serve while the probe succeeds', async () => {
    let reserves = 0;
    const sentinel = createOwnerSocketSentinel({
      probe: () => Promise.resolve(true),
      reserve: () => { reserves++; },
      log: noopLog,
    });
    await sentinel.tick();
    await sentinel.tick();
    expect(reserves).toBe(0);
  });

  it('re-serves only after consecutive probe failures', async () => {
    let reserves = 0;
    let ok = false;
    const sentinel = createOwnerSocketSentinel({
      probe: () => Promise.resolve(ok),
      reserve: () => { reserves++; },
      log: noopLog,
      failuresBeforeReserve: 2,
    });
    await sentinel.tick();
    expect(reserves).toBe(0);
    await sentinel.tick();
    expect(reserves).toBe(1);
    ok = true;
    await sentinel.tick();
    ok = false;
    await sentinel.tick();
    expect(reserves).toBe(1);
    await sentinel.tick();
    expect(reserves).toBe(2);
  });

  it('treats a throwing probe as a failure', async () => {
    let reserves = 0;
    const sentinel = createOwnerSocketSentinel({
      probe: () => Promise.reject(new Error('boom')),
      reserve: () => { reserves++; },
      log: noopLog,
      failuresBeforeReserve: 1,
    });
    await sentinel.tick();
    expect(reserves).toBe(1);
  });

  it('logs recovery after the socket becomes reachable again', async () => {
    const lines: string[] = [];
    let ok = false;
    const sentinel = createOwnerSocketSentinel({
      probe: () => Promise.resolve(ok),
      reserve: () => {},
      log: (_level, message) => { lines.push(message); },
      failuresBeforeReserve: 1,
    });
    await sentinel.tick();
    ok = true;
    await sentinel.tick();
    expect(lines.some((line) => line.includes('reachable again'))).toBe(true);
  });
});

describe('IpcBus.serveAsOwner socket reclaim', () => {
  let dir: string;

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('re-binds the socket path after the socket file is deleted under a live server', async () => {
    dir = mkdtempSync(join(tmpdir(), 'sentinel-sock-'));
    const socketPath = join(dir, 'ipc.sock');
    const owner = new IpcBus(socketPath, { allowServe: true });
    await owner.ready();
    expect(owner.isServing()).toBe(true);
    owner.onRequest('headless.owner-ping', async () => ({ ok: true, ownerId: 'me' }));

    unlinkSync(socketPath);
    const strandedClient = new IpcBus(socketPath, { allowServe: false, requestDeadlineMs: 300 });
    await strandedClient.ready();
    await expect(strandedClient.request('headless.owner-ping', {})).rejects.toThrow();
    strandedClient.disconnect();

    owner.serveAsOwner();
    await new Promise((resolve) => setTimeout(resolve, 50));

    const client = new IpcBus(socketPath, { allowServe: false, requestDeadlineMs: 1_000 });
    await client.ready();
    await expect(client.request('headless.owner-ping', {})).resolves.toEqual({ ok: true, ownerId: 'me' });
    client.disconnect();
    owner.disconnect();
  });
});
