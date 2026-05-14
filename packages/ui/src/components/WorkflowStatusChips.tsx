import type { MouseEvent } from 'react';
import type { WorkflowMeta, WorkflowStatus } from '../types.js';
import { getStatusVisual } from '../lib/status-colors.js';

interface WorkflowStatusChipsProps {
  workflows: Map<string, WorkflowMeta>;
  activeFilters: Set<WorkflowStatus>;
  onStatusClick: (status: WorkflowStatus, event: MouseEvent<HTMLButtonElement>) => void;
}

const ALWAYS_VISIBLE: WorkflowStatus[] = ['completed', 'running', 'fixing_with_ai', 'failed', 'pending'];
const OPTIONAL_VISIBLE: WorkflowStatus[] = ['review_ready', 'awaiting_approval', 'blocked', 'stale'];

const STATUS_LABELS: Record<WorkflowStatus, string> = {
  pending: 'Pending',
  running: 'Running',
  fixing_with_ai: 'Fixing',
  completed: 'Completed',
  failed: 'Failed',
  blocked: 'Blocked',
  review_ready: 'Review Ready',
  awaiting_approval: 'Approval',
  stale: 'Stale',
};

export function WorkflowStatusChips({
  workflows,
  activeFilters,
  onStatusClick,
}: WorkflowStatusChipsProps): JSX.Element {
  const counts = new Map<WorkflowStatus, number>();
  for (const status of [...ALWAYS_VISIBLE, ...OPTIONAL_VISIBLE]) counts.set(status, 0);
  for (const workflow of workflows.values()) {
    counts.set(workflow.status, (counts.get(workflow.status) ?? 0) + 1);
  }
  const total = workflows.size;
  const hasFilters = activeFilters.size > 0;
  const filterClass = (status: WorkflowStatus) => {
    const baseClasses = 'px-2 py-0.5 text-xs rounded-full cursor-pointer select-none transition-opacity duration-75';
    if (!hasFilters) return `${baseClasses} hover:brightness-125`;
    return `${baseClasses} ${activeFilters.has(status) ? 'ring-1 ring-current' : 'opacity-60'}`;
  };
  const visibleStatuses = [
    ...ALWAYS_VISIBLE,
    ...OPTIONAL_VISIBLE.filter((status) => (counts.get(status) ?? 0) > 0),
  ];

  return (
    <div className="flex items-center gap-6 px-4 py-2 bg-gray-800 border-t border-gray-700 text-sm">
      <span className="text-gray-400">
        Total: <span className="text-gray-100 font-medium">{total}</span>
      </span>
      {visibleStatuses.map((status) => {
        const count = counts.get(status) ?? 0;
        return (
          <button
            key={status}
            type="button"
            data-testid={`workflow-status-pill-${status}`}
            onClick={(event) => onStatusClick(status, event)}
            className={`${getStatusVisual(status).text} ${filterClass(status)}`}
          >
            {STATUS_LABELS[status]}: <span className="font-medium">{count}</span>
          </button>
        );
      })}
    </div>
  );
}
