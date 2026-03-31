import type { Orchestrator } from '../orchestrator.js';
import { scopePlanTaskId } from '../task-id-scope.js';

/** Scoped task id for plan-local id in the workflow at `wfIndex` (0 = first loaded). */
export function sid(orch: Orchestrator, wfIndex: number, planLocalId: string): string {
  const wf = orch.getWorkflowIds()[wfIndex];
  if (!wf) throw new Error(`No workflow at index ${wfIndex}`);
  return scopePlanTaskId(wf, planLocalId);
}

/** Reconciliation task id for a pivot with the given plan-local id (matches `${scopedPivot}-reconciliation`). */
export function rid(orch: Orchestrator, wfIndex: number, pivotLocalId: string): string {
  return `${sid(orch, wfIndex, pivotLocalId)}-reconciliation`;
}
