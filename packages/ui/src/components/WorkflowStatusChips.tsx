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

  return (
    <div className="flex items-center gap-2 px-3 py-2 border-t border-gray-800 bg-gray-900/95">
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
              'rounded border px-2 py-1 text-[11px] uppercase tracking-wide transition-colors',
              visual.borderClass,
              visual.textClass,
              active ? 'bg-gray-800' : 'bg-gray-900/70 hover:bg-gray-800/80',
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
