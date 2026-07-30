import type { WorkflowStatus } from '../types.js';
import { getStatusVisual } from './status-colors.js';

const WORKFLOW_STATUS_SET: ReadonlySet<WorkflowStatus> = new Set<WorkflowStatus>([
  'pending',
  'running',
  'fixing_with_ai',
  'completed',
  'failed',
  'closed',
  'blocked',
  'review_ready',
  'awaiting_approval',
  'stale',
]);

export function normalizeWorkflowStatus(rawStatus: string | undefined): WorkflowStatus {
  if (!rawStatus) return 'pending';
  const normalized = rawStatus.toLowerCase() as WorkflowStatus;
  return WORKFLOW_STATUS_SET.has(normalized) ? normalized : 'pending';
}

export interface WorkflowStatusVisual {
  borderClass: string;
  railClass: string;
  textClass: string;
  pulse: boolean;
}

export function workflowStatusVisual(status: WorkflowStatus): WorkflowStatusVisual {
  const visual = getStatusVisual(status);
  return {
    borderClass: visual.border,
    railClass: visual.rail,
    textClass: visual.text,
    pulse: visual.pulse,
  };
}

export function workflowStatusLabel(status: WorkflowStatus): string {
  const labelMap: Record<WorkflowStatus, string> = {
    pending: 'Pending',
    running: 'Running',
    fixing_with_ai: 'Fixing With AI',
    completed: 'Completed',
    failed: 'Failed',
    closed: 'Closed',
    blocked: 'Blocked',
    review_ready: 'Review Ready',
    awaiting_approval: 'Awaiting Approval',
    stale: 'Stale',
  };
  return labelMap[status] ?? status;
}

export function isWorkflowStatusActive(status: WorkflowStatus): boolean {
  return status === 'running';
}
