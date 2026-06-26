/**
 * Web invoker shim — builds `window.invoker` for the browser surface.
 *
 * Mirrors the Electron preload bridge (packages/app/src/preload.ts): it derives
 * the API generically from the channel registries in @invoker/contracts instead
 * of hand-listing methods. Request/response goes over HTTP `POST /invoke`; push
 * events arrive over a single SSE `EventSource(/events)`.
 */

// Import from the browser-safe ipc-channels subpath, NOT the @invoker/contracts
// barrel — the barrel re-exports Node-only modules (node:crypto/os/fs) that
// break the browser bundle.
import { IpcChannels, IpcEventChannels, channelToMethod, channelToEventMethod } from '@invoker/contracts/ipc-channels';
import type { InvokerAPI } from '@invoker/contracts/ipc-channels';

export function installWebInvoker(opts: { basePath?: string }): void {
  const base = opts.basePath ?? '';

  async function invoke(channel: string, args: unknown[]): Promise<unknown> {
    const res = await fetch(base + '/invoke', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel, args }),
    });
    if (!res.ok) throw new Error('web invoke transport failed: ' + res.status);
    const body = await res.json();
    if (!body || body.ok !== true) {
      const err = new Error(body?.error?.message ?? 'web invoke failed');
      (err as { code?: unknown }).code = body?.error?.code;
      throw err;
    }
    return body.result;
  }

  const api: Record<string, unknown> = {};

  // Invoke channels: each becomes (...args) => POST /invoke { channel, args }.
  for (const channel of Object.keys(IpcChannels)) {
    api[channelToMethod(channel)] = (...args: unknown[]) => invoke(channel, args);
  }

  // Event plumbing: one EventSource fans out to per-channel listener sets.
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  function dispatch(channel: string, data: unknown): void {
    for (const cb of listeners.get(channel) ?? []) cb(data);
  }

  if (typeof EventSource !== 'undefined') {
    const es = new EventSource(base + '/events', { withCredentials: true });
    for (const channel of Object.keys(IpcEventChannels)) {
      es.addEventListener(channel, (e) => dispatch(channel, JSON.parse((e as MessageEvent).data)));
    }
    // The task-graph stream also arrives batched: parse the array and feed each
    // element to the single-event listener set (mirrors preload's batch path).
    es.addEventListener('invoker:task-graph-event-batch', (e) => {
      const batch = JSON.parse((e as MessageEvent).data);
      if (!Array.isArray(batch)) return;
      for (const item of batch) dispatch('invoker:task-graph-event', item);
    });
  }

  for (const channel of Object.keys(IpcEventChannels)) {
    api[channelToEventMethod(channel)] = (cb: (data: unknown) => void) => {
      let set = listeners.get(channel);
      if (!set) {
        set = new Set();
        listeners.set(channel, set);
      }
      set.add(cb);
      return () => set!.delete(cb);
    };
  }

  (window as unknown as { invoker: InvokerAPI }).invoker = api as InvokerAPI;
  (window as unknown as { __INVOKER_BOOTSTRAP__: unknown }).__INVOKER_BOOTSTRAP__ = {
    tasks: [],
    workflows: [],
  };
}
