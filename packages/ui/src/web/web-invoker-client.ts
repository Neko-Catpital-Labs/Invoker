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
import { logPlanningEvent } from '../lib/planning-telemetry.js';

export function installWebInvoker(opts: { basePath?: string }): void {
  const base = opts.basePath ?? '';

  async function invoke(channel: string, args: unknown[]): Promise<unknown> {
    const startedAt = performance.now();
    // Failures are telemetry, not just console noise: they ride the buffered
    // ui-perf pipeline so the server records what each tab experienced.
    // report-ui-perf itself is excluded — its failures are handled by the
    // telemetry retry queue and must not self-report.
    const note = (metric: string, detail: Record<string, unknown>): void => {
      if (channel === 'invoker:report-ui-perf') return;
      logPlanningEvent(metric, { channel, durationMs: Math.round(performance.now() - startedAt), ...detail });
    };
    let res: Response;
    try {
      res = await fetch(base + '/invoke', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channel, args }),
      });
    } catch (err) {
      note('web_invoke_network_error', { error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
    if (!res.ok) {
      note('web_invoke_http_error', { status: res.status });
      throw new Error('web invoke transport failed: ' + res.status);
    }
    const body = await res.json();
    if (!body || body.ok !== true) {
      note('web_invoke_error', { code: body?.error?.code, message: body?.error?.message });
      const err = new Error(body?.error?.message ?? 'web invoke failed');
      (err as { code?: unknown }).code = body?.error?.code;
      throw err;
    }
    // planning-chat-send legitimately runs for minutes; anything else this
    // slow is the "popup says failed, server says fine" shape worth a record.
    if (channel !== 'invoker:planning-chat-send' && performance.now() - startedAt > 20_000) {
      note('web_invoke_slow', {});
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
  logPlanningEvent('planning_web_boot', { href: window.location.href, visibility: document.visibilityState });
  (window as unknown as { __INVOKER_BOOTSTRAP__: unknown }).__INVOKER_BOOTSTRAP__ = {
    tasks: [],
    workflows: [],
  };
}
