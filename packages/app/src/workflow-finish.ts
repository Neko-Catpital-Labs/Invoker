/**
 * Pure logic for determining whether onFinish should run.
 * Separated from main.ts to avoid Electron imports in tests.
 */

import type { PlanDefinition } from '@invoker/core';

export interface WorkflowStatus {
  running: number;
  pending: number;
  failed: number;
  total: number;
}

export function shouldRunOnFinish(
  status: WorkflowStatus,
  plan: PlanDefinition | null,
): boolean {
  if (!plan) return false;
  if (status.total === 0) return false;
  if (status.running > 0 || status.pending > 0) return false;
  if (status.failed > 0) return false;
  return plan.onFinish !== undefined && plan.onFinish !== 'none';
}
