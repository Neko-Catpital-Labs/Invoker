import type { MouseEvent } from 'react';
import type { QueueStatus, WorkflowMeta, WorkflowStatus } from '../types.js';
import { workflowStatusVisual } from '../lib/workflow-status.js';

interface WorkflowStatusChipsProps {
  workflows: Map<string, WorkflowMeta>;
  activeFilters: Set<WorkflowStatus>;
  onStatusClick: (status: WorkflowStatus, event: MouseEvent<HTMLButtonElement>) => void;
  keyboardActiveKey?: WorkflowStatus | null;
  queueStatus?: QueueStatus | null;
  onOpenRunningSurface?: () => void;
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
  queueStatus = null,
  onOpenRunningSurface,
}: WorkflowStatusChipsProps): JSX.Element {
  const counts = new Map<WorkflowStatus, number>();
  for (const status of DISPLAY_ORDER) counts.set(status, 0);
  for (const workflow of workflows.values()) {
    counts.set(workflow.status, (counts.get(workflow.status) ?? 0) + 1);
  }

  const hasFilters = activeFilters.size > 0;
  const queueRunning = queueStatus?.runningCount ?? 0;
  const queueMax = queueStatus?.maxConcurrency ?? 0;
  const queueQueued = queueStatus?.queued.length ?? 0;

  return (
    <div data-testid="workflow-status-chips" className="flex items-center gap-6 px-4 py-2 bg-secondary border-t border-border text-sm">
      {queueStatus && (
        <div data-testid="queue-capacity-chips" className="flex items-center gap-3 border-r border-border pr-6">
          <button
            type="button"
            data-testid="queue-chip-running"
            onClick={() => onOpenRunningSurface?.()}
            className="px-2 py-0.5 text-xs rounded-full cursor-pointer select-none text-blue-300 hover:brightness-125"
          >
            Executing ({queueRunning}/{queueMax})
          </button>
          <button
            type="button"
            data-testid="queue-chip-queued"
            onClick={() => onOpenRunningSurface?.()}
            className="px-2 py-0.5 text-xs rounded-full cursor-pointer select-none text-amber-300 hover:brightness-125"
          >
            Queued ({queueQueued})
          </button>
        </div>
      )}
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
              keyboardActiveKey === status ? 'ring-2 ring-ring/90 ring-offset-1 ring-offset-background' : '',
            ].join(' ')}
          >
            {status.replaceAll('_', ' ')} ({count})
          </button>
        );
      })}
    </div>
  );
}
