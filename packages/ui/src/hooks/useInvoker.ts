/**
 * Hook wrapping the window.invoker IPC API.
 *
 * Provides type-safe access to the Electron IPC bridge.
 * Returns undefined if window.invoker is not available (e.g., outside Electron).
 */

import type { InvokerAPI } from '../types.js';

export function useInvoker(): InvokerAPI | undefined {
  if (typeof window !== 'undefined' && window.invoker) {
    return window.invoker;
  }
  return undefined;
}
