/**
 * Preload Script — Exposes a safe IPC bridge to the renderer via contextBridge.
 *
 * Runs in a sandboxed context with access to ipcRenderer.
 * The renderer accesses this API through `window.invoker`.
 *
 * The bridge is derived at runtime by iterating IpcChannels and IpcEventChannels
 * from @invoker/contracts. Adding a new channel to the registry automatically
 * exposes it here — no manual editing required.
 */

import { contextBridge, ipcRenderer } from 'electron';
import { IpcChannels, IpcTestOnlyChannels, IpcEventChannels } from '@invoker/contracts';
import type { InvokerAPI } from '@invoker/contracts';

// ── Runtime channel-name → method-name conversion ───────────
// Mirrors the type-level ChannelToMethod: strip "invoker:" prefix, kebab → camelCase.

function channelToMethod(channel: string): string {
  const stripped = channel.startsWith('invoker:') ? channel.slice(8) : channel;
  return stripped.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

function channelToEventMethod(channel: string): string {
  const base = channelToMethod(channel);
  return `on${base.charAt(0).toUpperCase()}${base.slice(1)}`;
}

// ── Build the API object from the channel registries ────────

const api: Record<string, unknown> = {};
const bootstrapState = ipcRenderer.sendSync('invoker:get-bootstrap-state-sync') as
  | { tasks?: unknown[]; workflows?: unknown[] }
  | undefined;

// Invoke channels: each becomes (...args) => ipcRenderer.invoke(channel, ...args)
for (const channel of Object.keys(IpcChannels)) {
  const method = channelToMethod(channel);
  api[method] = (...args: unknown[]) => ipcRenderer.invoke(channel, ...args);
}

// Test-only channels: only registered when NODE_ENV === 'test'
if (process.env.NODE_ENV === 'test') {
  for (const channel of Object.keys(IpcTestOnlyChannels)) {
    const method = channelToMethod(channel);
    api[method] = (...args: unknown[]) => ipcRenderer.invoke(channel, ...args);
  }
}

// Event channels: each becomes (cb) => { subscribe; return unsubscribe }
for (const channel of Object.keys(IpcEventChannels)) {
  const method = channelToEventMethod(channel);
  if (channel === 'invoker:task-delta') {
    api[method] = (cb: (...args: unknown[]) => void) => {
      const singleHandler = (_event: Electron.IpcRendererEvent, ...data: unknown[]) => cb(...data);
      const batchHandler = (_event: Electron.IpcRendererEvent, batch: unknown[]) => {
        if (!Array.isArray(batch)) return;
        for (const item of batch) {
          cb(item);
        }
      };
      ipcRenderer.on(channel, singleHandler);
      ipcRenderer.on('invoker:task-delta-batch', batchHandler);
      return () => {
        ipcRenderer.removeListener(channel, singleHandler);
        ipcRenderer.removeListener('invoker:task-delta-batch', batchHandler);
      };
    };
    continue;
  }

  api[method] = (cb: (...args: unknown[]) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, ...data: unknown[]) => cb(...data);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  };
}

contextBridge.exposeInMainWorld('invoker', api as InvokerAPI);
contextBridge.exposeInMainWorld('__INVOKER_BOOTSTRAP__', bootstrapState ?? { tasks: [], workflows: [] });
