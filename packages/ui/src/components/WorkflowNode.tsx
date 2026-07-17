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
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      onContextMenu={onContextMenu}
      onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onClick();
        }
      }}
      className={[
        'relative w-[340px] rounded-xl border bg-background pl-5 pr-4 py-4 text-left transition-all shadow-sm',
        visual.borderClass,
        selected ? 'ring-2 ring-ring/70' : '',
        dimmed ? 'opacity-35' : 'opacity-100',
        'hover:bg-secondary/95',
      ].join(' ')}
    >
      <div className={`absolute left-0 top-0 h-full w-1.5 rounded-l-xl ${visual.railClass}`} />
      {isWorkflowStatusActive(workflow.status) && visual.pulse && (
        <div className={`absolute -left-1.5 top-1/2 h-2.5 w-2.5 -translate-y-1/2 rounded-full ${visual.railClass} animate-ping`} />
      )}
      {detachedDependencyCount > 0 && (
        <div
          data-testid={`workflow-node-${workflow.id}-detached-lineage`}
          title={`Detached from ${detachedDependencyCount} upstream workflow${detachedDependencyCount === 1 ? '' : 's'}`}
          className="absolute right-2.5 top-2.5 rounded border border-amber-400/35 bg-amber-950/45 px-1.5 py-0.5 text-[11px] font-medium uppercase leading-none text-amber-300"
        >
          Detached
        </div>
      )}

      <div className={`text-[22px] font-semibold leading-snug text-foreground truncate ${detachedDependencyCount > 0 ? 'pr-16' : ''}`}>
        {workflow.name || workflow.id}
      </div>
      <div className="mt-1 text-base text-muted-foreground truncate">{workflow.id}</div>
      <div className={`mt-2 text-[15px] uppercase tracking-wide ${visual.textClass}`}>{statusLabel(workflow.status)}</div>
      {showRunningTaskLine && (
        <div
          data-testid={`workflow-node-${workflow.id}-running-tasks`}
          className="mt-1 text-[15px] text-muted-foreground"
        >
          {runningTaskLabel(runningCount)}
        </div>
      )}
      {coreActivity && (
        <div
          data-testid={`workflow-node-${workflow.id}-core-activity`}
          className={[
            'mt-2 inline-flex items-center gap-1.5 rounded border px-2 py-1 text-[15px] font-medium',
            coreActivity.status === 'running'
              ? 'border-border-strong text-muted-foreground'
              : coreActivity.status === 'pending'
                ? 'border-amber-400/60 text-amber-200'
                : 'border-red-400/70 text-red-200',
          ].join(' ')}
        >
          {coreActivity.status === 'running' && (
            <span className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse" />
          )}
          {coreActivity.label}
        </div>
      )}
    </div>
  );
}
