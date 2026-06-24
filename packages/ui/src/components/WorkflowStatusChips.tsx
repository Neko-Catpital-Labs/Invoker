import type { MouseEvent } from 'react';
import type { WorkflowMeta, WorkflowStatus } from '../types.js';
import { workflowStatusVisual } from '../lib/workflow-status.js';

interface WorkflowStatusChipsProps {
  workflows: Map<string, WorkflowMeta>;
  activeFilters: Set<WorkflowStatus>;
  onStatusClick: (status: WorkflowStatus, event: MouseEvent<HTMLButtonElement>) => void;
  keyboardActiveKey?: WorkflowStatus | null;
}

const DISPLAY_ORDER: WorkflowStatus[] = [
  'running',
  'failed',
  'closed',
  'blocked',
  'fixing_with_ai',
  'awaiting_approval',
  'review_ready',
  'pending',
  'stale',
  'completed',
];

export function WorkflowStatusChips({
  workflows,
  activeFilters,
  onStatusClick,
  keyboardActiveKey = null,
}: WorkflowStatusChipsProps): JSX.Element {
  const counts = new Map<WorkflowStatus, number>();
  for (const status of DISPLAY_ORDER) counts.set(status, 0);
  for (const workflow of workflows.values()) {
    counts.set(workflow.status, (counts.get(workflow.status) ?? 0) + 1);
  }

  const hasFilters = activeFilters.size > 0;

  return (
    <div className="flex items-center gap-6 px-4 py-2 bg-gray-800 border-t border-gray-700 text-sm">
      {DISPLAY_ORDER.map((status) => {
        const visual = workflowStatusVisual(status);
        const active = activeFilters.has(status);
        const count = counts.get(status) ?? 0;
        return (
          <button
            key={status}
            data-testid={`workflow-status-pill-${status}`}
            onClick={(event) => onStatusClick(status, event)}
            className={[
              'px-2 py-0.5 text-xs rounded-full cursor-pointer select-none transition-opacity duration-75',
              visual.textClass,
              active ? 'ring-1 ring-current' : hasFilters ? 'opacity-60' : 'hover:brightness-125',
              keyboardActiveKey === status ? 'ring-2 ring-blue-300/90 ring-offset-1 ring-offset-gray-800' : '',
            ].join(' ')}
          >
            {status.replaceAll('_', ' ')} ({count})
          </button>
        );
      })}
    </div>
  );
}
