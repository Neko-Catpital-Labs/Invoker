import type { KeyboardEvent, MouseEvent } from 'react';
import type { WorkflowMeta, WorkflowStatus } from '../types.js';
import { isWorkflowStatusActive, workflowStatusVisual } from '../lib/workflow-status.js';

interface WorkflowNodeProps {
  workflow: WorkflowMeta;
  selected: boolean;
  dimmed: boolean;
  onClick: () => void;
  onContextMenu: (event: MouseEvent<HTMLDivElement>) => void;
}

function statusLabel(status: WorkflowStatus): string {
  return status.replaceAll('_', ' ');
}

function selectedRingClass(status: WorkflowStatus): string {
  switch (status) {
    case 'running':
      return 'ring-2 ring-blue-400/80';
    case 'fixing_with_ai':
      return 'ring-2 ring-orange-400/80';
    case 'completed':
      return 'ring-2 ring-green-500/80';
    case 'failed':
      return 'ring-2 ring-red-500/80';
    case 'review_ready':
      return 'ring-2 ring-sky-400/80';
    case 'awaiting_approval':
      return 'ring-2 ring-purple-400/80';
    case 'blocked':
      return 'ring-2 ring-slate-500/80';
    case 'stale':
      return 'ring-2 ring-slate-600/80';
    case 'pending':
    default:
      return 'ring-2 ring-slate-400/80';
  }
}

export function WorkflowNode({
  workflow,
  selected,
  dimmed,
  onClick,
  onContextMenu,
}: WorkflowNodeProps): JSX.Element {
  const visual = workflowStatusVisual(workflow.status);

  return (
    <div
      data-testid={`workflow-node-${workflow.id}`}
      role="button"
      tabIndex={0}
      onClick={onClick}
      onContextMenu={onContextMenu}
      onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onClick();
        }
      }}
      className={[
        'relative w-[220px] rounded-lg border bg-gray-900/95 pl-4 pr-3 py-3 text-left transition-all',
        visual.borderClass,
        selected ? selectedRingClass(workflow.status) : '',
        dimmed ? 'opacity-35' : 'opacity-100',
        'hover:bg-gray-800/95',
      ].join(' ')}
    >
      <div className={`absolute left-0 top-0 h-full w-1 rounded-l-lg ${visual.railClass}`} />
      {isWorkflowStatusActive(workflow.status) && visual.pulse && (
        <div className={`absolute -left-1 top-1/2 h-2 w-2 -translate-y-1/2 rounded-full ${visual.railClass} animate-ping`} />
      )}

      <div className="text-[13px] font-semibold text-gray-100 truncate">{workflow.name || workflow.id}</div>
      <div className={`mt-2 text-[10px] uppercase tracking-wide ${visual.textClass}`}>{statusLabel(workflow.status)}</div>
    </div>
  );
}
