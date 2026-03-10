import { describe, it, expect, beforeEach } from 'vitest';
import { LocalBus } from '../local-bus.js';

describe('LocalBus', () => {
  let bus: LocalBus;

  beforeEach(() => {
    bus = new LocalBus();
  });

  it('publish/subscribe: handler receives message', () => {
    const received: string[] = [];
    bus.subscribe('test', (msg: string) => received.push(msg));

    bus.publish('test', 'hello');

    expect(received).toEqual(['hello']);
  });

  it('unsubscribe stops delivery', () => {
    const received: string[] = [];
    const unsub = bus.subscribe('test', (msg: string) => received.push(msg));

    bus.publish('test', 'first');
    unsub();
    bus.publish('test', 'second');

    expect(received).toEqual(['first']);
  });

  it('multiple subscribers on same channel', () => {
    const a: string[] = [];
    const b: string[] = [];
    bus.subscribe('ch', (msg: string) => a.push(msg));
    bus.subscribe('ch', (msg: string) => b.push(msg));

    bus.publish('ch', 'data');

    expect(a).toEqual(['data']);
    expect(b).toEqual(['data']);
  });

  it('request/reply pattern works', async () => {
    bus.onRequest<number, number>('double', (n) => n * 2);

    const result = await bus.request<number, number>('double', 5);
    expect(result).toBe(10);
  });

  it('publish to empty channel does not error', () => {
    expect(() => bus.publish('empty', 'data')).not.toThrow();
  });

  it('disconnect cleans up all subscriptions', async () => {
    const received: string[] = [];
    bus.subscribe('test', (msg: string) => received.push(msg));
    bus.onRequest('rpc', () => 42);

    bus.disconnect();

    bus.publish('test', 'after');
    expect(received).toEqual([]);
    await expect(() => bus.request('rpc', null)).rejects.toThrow();
  });
});
