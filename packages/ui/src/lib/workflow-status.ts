import type { WorkflowStatus } from '../types.js';

const WORKFLOW_STATUS_SET: ReadonlySet<WorkflowStatus> = new Set<WorkflowStatus>([
  'pending',
  'running',
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
  switch (status) {
    case 'completed':
      return {
        borderClass: 'border-green-500/45',
        railClass: 'bg-green-500',
        textClass: 'text-green-300',
        pulse: false,
      };
    case 'running':
      return {
        borderClass: 'border-blue-400/70',
        railClass: 'bg-blue-400',
        textClass: 'text-blue-300',
        pulse: true,
      };
    case 'failed':
      return {
        borderClass: 'border-red-500/60',
        railClass: 'bg-red-500',
        textClass: 'text-red-300',
        pulse: false,
      };
    case 'closed':
      return {
        borderClass: 'border-zinc-500/60',
        railClass: 'bg-zinc-500',
        textClass: 'text-zinc-300',
        pulse: false,
      };
    case 'blocked':
      return {
        borderClass: 'border-amber-500/60',
        railClass: 'bg-amber-500',
        textClass: 'text-amber-300',
        pulse: false,
      };
    case 'review_ready':
      return {
        borderClass: 'border-violet-500/50',
        railClass: 'bg-violet-500',
        textClass: 'text-violet-300',
        pulse: false,
      };
    case 'awaiting_approval':
      return {
        borderClass: 'border-orange-500/60',
        railClass: 'bg-orange-500',
        textClass: 'text-orange-300',
        pulse: false,
      };
    case 'stale':
      return {
        borderClass: 'border-slate-500/55',
        railClass: 'bg-slate-500',
        textClass: 'text-slate-300',
        pulse: false,
      };
    case 'pending':
    default:
      return {
        borderClass: 'border-gray-500/60',
        railClass: 'bg-gray-500',
        textClass: 'text-gray-300',
        pulse: false,
      };
  }
}

export function isWorkflowStatusActive(status: WorkflowStatus): boolean {
  return status === 'running';
}
