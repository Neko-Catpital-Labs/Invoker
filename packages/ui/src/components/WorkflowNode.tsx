import type { KeyboardEvent, MouseEvent } from 'react';
import type { WorkflowMeta, WorkflowStatus } from '../types.js';
import { isWorkflowStatusActive, workflowStatusVisual } from '../lib/workflow-status.js';
import type { WorkflowCoreActivity } from '../lib/workflow-core-activity.js';

interface WorkflowNodeProps {
  workflow: WorkflowMeta;
  selected: boolean;
  dimmed: boolean;
  coreActivity?: WorkflowCoreActivity;
  onClick: () => void;
  onContextMenu: (event: MouseEvent<HTMLDivElement>) => void;
}

function statusLabel(status: WorkflowStatus): string {
  return status.replaceAll('_', ' ');
}
function runningTaskLabel(count: number): string {
  return count === 1 ? '1 running task' : `${count} running tasks`;
}


export function WorkflowNode({
  workflow,
  selected,
  dimmed,
  coreActivity,
  onClick,
  onContextMenu,
}: WorkflowNodeProps): JSX.Element {
  const visual = workflowStatusVisual(workflow.status);
  const detachedDependencyCount = workflow.detachedExternalDependencies?.length ?? 0;
  const runningCount = workflow.rollup?.countsByStatus.running ?? 0;
  const showRunningTaskLine = workflow.status !== 'running' && runningCount > 0;

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
        'relative w-[220px] rounded-lg border bg-gray-900 pl-4 pr-3 py-3 text-left transition-all shadow-sm',
        visual.borderClass,
        selected ? 'ring-2 ring-blue-400/80' : '',
        dimmed ? 'opacity-35' : 'opacity-100',
        'hover:bg-gray-800/95',
      ].join(' ')}
    >
      <div className={`absolute left-0 top-0 h-full w-1 rounded-l-lg ${visual.railClass}`} />
      {isWorkflowStatusActive(workflow.status) && visual.pulse && (
        <div className={`absolute -left-1 top-1/2 h-2 w-2 -translate-y-1/2 rounded-full ${visual.railClass} animate-ping`} />
      )}
      {detachedDependencyCount > 0 && (
        <div
          data-testid={`workflow-node-${workflow.id}-detached-lineage`}
          title={`Detached from ${detachedDependencyCount} upstream workflow${detachedDependencyCount === 1 ? '' : 's'}`}
          className="absolute right-2 top-2 rounded border border-amber-400/35 bg-amber-950/45 px-1.5 py-0.5 text-[9px] font-medium uppercase leading-none text-amber-300"
        >
          Detached
        </div>
      )}

      <div className={`text-[13px] font-semibold text-gray-100 truncate ${detachedDependencyCount > 0 ? 'pr-16' : ''}`}>
        {workflow.name || workflow.id}
      </div>
      <div className="mt-1 text-[11px] text-gray-400 truncate">{workflow.id}</div>
      <div className={`mt-2 text-[10px] uppercase tracking-wide ${visual.textClass}`}>{statusLabel(workflow.status)}</div>
      {showRunningTaskLine && (
        <div
          data-testid={`workflow-node-${workflow.id}-running-tasks`}
          className="mt-1 text-[10px] text-gray-300"
        >
          {runningTaskLabel(runningCount)}
        </div>
      )}
      {coreActivity && (
        <div
          data-testid={`workflow-node-${workflow.id}-core-activity`}
          className={[
            'mt-2 inline-flex items-center gap-1 rounded border px-2 py-1 text-[10px] font-medium',
            coreActivity.status === 'running'
              ? 'border-blue-400/60 text-blue-200'
              : coreActivity.status === 'pending'
                ? 'border-amber-400/60 text-amber-200'
                : 'border-red-400/70 text-red-200',
          ].join(' ')}
        >
          {coreActivity.status === 'running' && (
            <span className="h-1.5 w-1.5 rounded-full bg-blue-300 animate-pulse" />
          )}
          {coreActivity.label}
        </div>
      )}
    </div>
  );
}
