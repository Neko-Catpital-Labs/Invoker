import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installWebInvoker } from '../web-invoker-client.js';

interface FetchCall {
  url: string;
  body: { channel: string; args: unknown[] };
}

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  handlers = new Map<string, (e: MessageEvent) => void>();
  url: string;

  constructor(url: string, _opts?: EventSourceInit) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(name: string, cb: (e: MessageEvent) => void): void {
    this.handlers.set(name, cb);
  }

  fire(name: string, data: unknown): void {
    const cb = this.handlers.get(name);
    if (cb) cb({ data: JSON.stringify(data) } as MessageEvent);
  }
}

describe('installWebInvoker', () => {
  let fetchCalls: FetchCall[];
  let fetchResult: unknown;

  beforeEach(() => {
    fetchCalls = [];
    fetchResult = { tasks: [], workflows: [], streamSequence: 0 };
    FakeEventSource.instances = [];
    global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return {
        ok: true,
        json: async () => ({ ok: true, result: fetchResult }),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    (global as unknown as { EventSource: typeof FakeEventSource }).EventSource = FakeEventSource;
  });

  afterEach(() => {
    delete (global as { fetch?: unknown }).fetch;
    delete (global as { EventSource?: unknown }).EventSource;
    delete (window as { invoker?: unknown }).invoker;
    delete (window as { __INVOKER_BOOTSTRAP__?: unknown }).__INVOKER_BOOTSTRAP__;
  });

  it('installs window.invoker and an empty bootstrap', () => {
    installWebInvoker({});
    expect(window.invoker).toBeDefined();
    expect(window.__INVOKER_BOOTSTRAP__).toEqual({ tasks: [], workflows: [] });
  });

  it('getTasks POSTs to /invoke and resolves the mocked result', async () => {
    installWebInvoker({});
    const result = await window.invoker.getTasks();
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe('/invoke');
    expect(fetchCalls[0].body).toEqual({ channel: 'invoker:get-tasks', args: [] });
    expect(result).toEqual({ tasks: [], workflows: [], streamSequence: 0 });
  });

  it('onTaskGraphEvent receives a fired SSE event payload', () => {
    installWebInvoker({});
    const cb = vi.fn();
    window.invoker.onTaskGraphEvent(cb as never);
    const es = FakeEventSource.instances[0];
    const payload = { type: 'snapshot', tasks: [] };
    es.fire('invoker:task-graph-event', payload);
    expect(cb).toHaveBeenCalledWith(payload);
  });

  it('approve POSTs the approve channel with args', async () => {
    fetchResult = undefined;
    installWebInvoker({});
    await window.invoker.approve('wf/x');
    expect(fetchCalls[0].body).toEqual({ channel: 'invoker:approve', args: ['wf/x'] });
  });
});
