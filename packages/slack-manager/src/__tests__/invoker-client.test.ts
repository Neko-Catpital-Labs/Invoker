import { describe, it, expect, vi } from 'vitest';
import { TransportError, TransportErrorCode } from '@invoker/transport';
import { IpcInvokerClient, InvokerDownError, type ConnectableBus } from '../invoker-client.js';

/** A fake IpcBus whose owner-ping succeeds only while `ownerUp()` is true. */
function makeFakeBus(ownerUp: () => boolean): ConnectableBus & { subscribe: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> } {
  return {
    ready: vi.fn(async () => {}),
    request: vi.fn(async (_channel: string) => {
      if (!ownerUp()) throw new TransportError(TransportErrorCode.NO_HANDLER, 'no peer');
      return { ok: true } as never;
    }),
    subscribe: vi.fn(() => () => {}),
    publish: vi.fn(),
    onRequest: vi.fn(() => () => {}),
    disconnect: vi.fn(),
  } as never;
}

describe('IpcInvokerClient', () => {
  it('withRecovery relaunches Invoker and retries the operation once', async () => {
    let ownerUp = false;
    const spawnInvoker = vi.fn(() => { ownerUp = true; });
    const client = new IpcInvokerClient({
      spawnInvoker, log: () => {},
      busFactory: () => makeFakeBus(() => ownerUp),
      sleep: async () => {}, healthPollIntervalMs: 1, launchHealthTimeoutMs: 1_000,
      httpHealthCheck: async () => false,
    });

    let calls = 0;
    const result = await client.withRecovery(async () => {
      calls += 1;
      if (calls === 1) throw new InvokerDownError('down');
      return 'recovered';
    });

    expect(spawnInvoker).toHaveBeenCalledTimes(1);
    expect(calls).toBe(2);
    expect(result).toBe('recovered');
  });

  it('coalesces concurrent launches into a single spawn', async () => {
    let ownerUp = false;
    const spawnInvoker = vi.fn(() => { ownerUp = true; });
    const client = new IpcInvokerClient({
      spawnInvoker, log: () => {},
      busFactory: () => makeFakeBus(() => ownerUp),
      sleep: async () => {}, healthPollIntervalMs: 1, launchHealthTimeoutMs: 1_000,
      httpHealthCheck: async () => false,
    });

    const [a, b] = await Promise.all([client.launch(), client.launch()]);
    expect(spawnInvoker).toHaveBeenCalledTimes(1);
    expect(a).toBe(true);
    expect(b).toBe(true);
  });

  it('throttles a second (non-forced) launch within the min interval', async () => {
    let ownerUp = false; // never recovers
    const spawnInvoker = vi.fn();
    let nowMs = 100_000;
    const client = new IpcInvokerClient({
      spawnInvoker, log: () => {},
      busFactory: () => makeFakeBus(() => ownerUp),
      now: () => nowMs,
      sleep: async (ms) => { nowMs += ms; },
      healthPollIntervalMs: 2, launchHealthTimeoutMs: 10,
      minLaunchIntervalMs: 60_000, httpHealthCheck: async () => false,
    });

    expect(await client.launch()).toBe(false);
    expect(spawnInvoker).toHaveBeenCalledTimes(1);

    nowMs += 1_000; // inside the window
    expect(await client.launch()).toBe(false);
    expect(spawnInvoker).toHaveBeenCalledTimes(1);

    nowMs += 60_000; // past the window
    await client.launch();
    expect(spawnInvoker).toHaveBeenCalledTimes(2);
  });

  it('promotes a probe to the live bus, applies subscriptions, and fires onReconnect', async () => {
    let ownerUp = true;
    const buses: Array<ReturnType<typeof makeFakeBus>> = [];
    const client = new IpcInvokerClient({
      spawnInvoker: vi.fn(), log: () => {},
      busFactory: () => { const b = makeFakeBus(() => ownerUp); buses.push(b); return b; },
      httpHealthCheck: async () => false,
    });
    const reconnect = vi.fn();
    client.onReconnect(reconnect);
    client.subscribe('surface.event', vi.fn());

    expect(await client.ping()).toBe(true);
    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(buses).toHaveLength(1);
    expect(buses[0].subscribe).toHaveBeenCalledWith('surface.event', expect.any(Function));
  });

  it('re-subscribes on a fresh bus after the owner dies and returns', async () => {
    let ownerUp = true;
    const buses: Array<ReturnType<typeof makeFakeBus>> = [];
    const client = new IpcInvokerClient({
      spawnInvoker: vi.fn(), log: () => {},
      busFactory: () => { const b = makeFakeBus(() => ownerUp); buses.push(b); return b; },
      httpHealthCheck: async () => false,
    });
    client.subscribe('task.delta', vi.fn());

    expect(await client.ping()).toBe(true);          // bus0 connects, subscription applied
    expect(buses[0].subscribe).toHaveBeenCalledTimes(1);

    ownerUp = false;
    expect(await client.ping()).toBe(false);         // bus0 ping fails → torn down
    expect(buses[0].disconnect).toHaveBeenCalled();

    ownerUp = true;
    expect(await client.ping()).toBe(true);          // fresh probe connects + re-subscribes
    expect(buses).toHaveLength(2);
    expect(buses[1].subscribe).toHaveBeenCalledWith('task.delta', expect.any(Function));
  });
});
