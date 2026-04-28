/**
 * IPC Bridge Types — Shared between preload and renderer.
 *
 * All IPC types are now defined in @invoker/contracts. This module
 * re-exports them so existing imports from './types.js' still resolve.
 */

export type {
  InvokerAPI,
  TaskReplacementDef,
  WorkflowMeta,
  WorkflowStatus,
  TaskOutputData,
  ActivityLogEntry,
  ClaudeMessage,
  AgentSessionData,
  ExternalGatePolicyUpdate,
} from '@invoker/contracts';

import type { InvokerAPI } from '@invoker/contracts';

// ── Augment global Window ────────────────────────────────────

declare global {
  interface Window {
    invoker: InvokerAPI;
  }
}
