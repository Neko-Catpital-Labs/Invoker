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
  WorkflowRollup,
  WorkflowStatus,
  TaskOutputData,
  ActivityLogEntry,
  ClaudeMessage,
  AgentSessionData,
  ExternalGatePolicyUpdate,
  InAppPlanRequest,
  InAppPlanResponse,
  InAppPlanningChatLine,
  InAppPlanningChatRequest,
  InAppPlanningChatResponse,
  InAppPlanningCreateSessionRequest,
  InAppPlanningCreateSessionResponse,
  InAppPlanningGetSessionRequest,
  InAppPlanningGetSessionResponse,
  InAppPlanningListSessionsResponse,
  InAppPlanningPlanSummary,
  InAppPlanningResetRequest,
  InAppPlanningResetResponse,
  InAppPlanningSessionStatus,
  InAppPlanningSessionSummary,
  InAppPlanningSubmitRequest,
  InAppPlanningSubmitResponse,
  PlanningPresetOption,
} from '@invoker/contracts';

import type { InvokerAPI } from '@invoker/contracts';

// ── Augment global Window ────────────────────────────────────

declare global {
  interface Window {
    invoker: InvokerAPI;
  }
}
