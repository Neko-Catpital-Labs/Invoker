/**
 * Production path: TaskExecutor runs reconciliation, acquires a worktree, then the worker
 * emits `needs_input`. Orchestrator-only tests have no executor — call this after all
 * experiment tasks have settled so reconciliation reaches `needs_input` like production.
 */
import type { WorkResponse } from '@invoker/protocol';

export function reconciliationNeedsInputWorkResponse(reconTaskId: string): WorkResponse {
  return {
    requestId: `req-${reconTaskId}-ni`,
    actionId: reconTaskId,
    status: 'needs_input',
    outputs: { exitCode: 0, summary: 'Select experiment variant' },
  };
}
