/**
 * StatusBar — Bottom bar showing workflow status counts.
 *
 * Displays: Total | Completed | Running | Failed | Pending
 * Updates reactively from the task map.
 * Status labels are clickable to filter DAG nodes by status.
 */

import type { QueueStatus, TaskState } from '../types.js';
import { getStatusVisual } from '../lib/status-colors.js';

interface StatusBarProps {
  tasks: Map<string, TaskState>;
  queueStatus?: QueueStatus | null;
  activeFilters?: Set<string>;
  keyboardActiveKey?: string | null;
  onStatusClick?: (filterKey: string, event: React.MouseEvent) => void;
}

export function StatusBar({ tasks, queueStatus, activeFilters, keyboardActiveKey, onStatusClick }: StatusBarProps) {
  let completed = 0;
  const runningEntries = queueStatus?.running ?? [];
  const runningTaskIds = new Set(runningEntries.map((entry) => entry.taskId));
  const assigningTaskIds = new Set(
    runningEntries
      .filter((entry) => tasks.get(entry.taskId)?.execution.phase === 'launching')
      .map((entry) => entry.taskId),
  );
  let assigning = assigningTaskIds.size;
  let running = queueStatus ? Math.max(0, queueStatus.runningCount - assigning) : 0;
  let failed = 0;
  let closed = 0;
  let pending = 0;
  let needsInput = 0;
  let reviewReady = 0;
  let awaitingApproval = 0;
  let blocked = 0;
  let fixing = 0;
  let fixApproval = 0;

  for (const task of tasks.values()) {
    switch (task.status) {
      case 'completed':
        completed++;
        break;
      case 'running':
        if (task.execution.isFixingWithAI) {
          fixing++;
        } else if (!queueStatus && task.execution.phase === 'launching') {
          assigning++;
        } else if (!queueStatus) {
          running++;
        }
        break;
      case 'fixing_with_ai':
        fixing++;
        break;
      case 'failed':
        failed++;
        break;
      case 'closed':
        closed++;
        break;
      case 'pending':
        if (!runningTaskIds.has(task.id)) {
          pending++;
        }
        break;
      case 'needs_input':
        needsInput++;
        break;
      case 'awaiting_approval':
        if (task.execution.pendingFixError) {
          fixApproval++;
        } else {
          awaitingApproval++;
        }
        break;
      case 'review_ready':
        reviewReady++;
        break;
      case 'blocked':
        blocked++;
        break;
    }
  }

  const total = tasks.size;

  const hasFilters = activeFilters && activeFilters.size > 0;
  const filterClass = (key: string) => {
    const baseClasses = 'px-1.5 py-0.5 text-xs rounded-md cursor-pointer select-none transition-opacity duration-100';
    const keyboardClass = keyboardActiveKey === key ? ' ring-1 ring-ring/70' : '';
    if (!hasFilters) return `${baseClasses}${keyboardClass} hover:brightness-125`;
    const isActive = activeFilters!.has(key);
    return `${baseClasses} ${
      isActive ? 'ring-1 ring-current' : 'opacity-60'
    }${keyboardClass}`;
  };
  const statusTextClass = (key: string) => getStatusVisual(key).text;

  return (
    <div className="flex items-center gap-4 px-4 py-1.5 bg-card border-t border-border text-xs font-medium">
      <span className="text-muted-foreground">
        Total <span className="text-foreground font-semibold">{total}</span>
      </span>
      <span
        data-testid="status-bar-pill-completed"
        data-status-key="completed"
        className={`${statusTextClass('completed')} ${filterClass('completed')}`}
        onClick={(e) => onStatusClick?.('completed', e)}
      >
        <span data-testid="workflow-status-pill-completed" className="sr-only" />
        Completed: <span className="font-medium">{completed}</span>
      </span>
      <span
        data-testid="status-bar-pill-running"
        data-status-key="running"
        className={`${statusTextClass('running')} ${filterClass('running')}`}
        onClick={(e) => onStatusClick?.('running', e)}
      >
        <span data-testid="workflow-status-pill-running" className="sr-only" />
        Running: <span className="font-medium">{running}</span>
      </span>
      {assigning > 0 && (
        <span
          data-testid="status-bar-pill-assigning"
          data-status-key="assigning"
          className={`${statusTextClass('assigning')} ${filterClass('assigning')}`}
          onClick={(e) => onStatusClick?.('assigning', e)}
        >
          Assigning: <span className="font-medium">{assigning}</span>
        </span>
      )}
      <span
        data-testid="status-bar-pill-failed"
        data-status-key="failed"
        className={`${statusTextClass('failed')} ${filterClass('failed')}`}
        onClick={(e) => onStatusClick?.('failed', e)}
      >
        <span data-testid="workflow-status-pill-failed" className="sr-only" />
        Failed: <span className="font-medium">{failed}</span>
      </span>
      {closed > 0 && (
        <span
          data-testid="status-bar-pill-closed"
          data-status-key="closed"
          className={`${statusTextClass('closed')} ${filterClass('closed')}`}
          onClick={(e) => onStatusClick?.('closed', e)}
        >
          Closed: <span className="font-medium">{closed}</span>
        </span>
      )}
      <span
        data-testid="status-bar-pill-pending"
        data-status-key="pending"
        className={`${statusTextClass('pending')} ${filterClass('pending')}`}
        onClick={(e) => onStatusClick?.('pending', e)}
      >
        <span data-testid="workflow-status-pill-pending" className="sr-only" />
        Pending: <span className="font-medium">{pending}</span>
      </span>
      {needsInput > 0 && (
        <span
          data-testid="status-bar-pill-needs_input"
          data-status-key="needs_input"
          className={`${statusTextClass('needs_input')} ${filterClass('needs_input')}`}
          onClick={(e) => onStatusClick?.('needs_input', e)}
        >
          Input: <span className="font-medium">{needsInput}</span>
        </span>
      )}
      {reviewReady > 0 && (
        <span
          data-testid="status-bar-pill-review_ready"
          data-status-key="review_ready"
          className={`${statusTextClass('review_ready')} ${filterClass('review_ready')}`}
          onClick={(e) => onStatusClick?.('review_ready', e)}
        >
          Review Ready: <span className="font-medium">{reviewReady}</span>
        </span>
      )}
      {awaitingApproval > 0 && (
        <span
          data-testid="status-bar-pill-awaiting_approval"
          data-status-key="awaiting_approval"
          className={`${statusTextClass('awaiting_approval')} ${filterClass('awaiting_approval')}`}
          onClick={(e) => onStatusClick?.('awaiting_approval', e)}
        >
          Approval: <span className="font-medium">{awaitingApproval}</span>
        </span>
      )}
      {blocked > 0 && (
        <span
          data-testid="status-bar-pill-blocked"
          data-status-key="blocked"
          className={`${statusTextClass('blocked')} ${filterClass('blocked')}`}
          onClick={(e) => onStatusClick?.('blocked', e)}
        >
          Blocked: <span className="font-medium">{blocked}</span>
        </span>
      )}
      {fixing > 0 && (
        <span
          data-testid="status-bar-pill-fixing_with_ai"
          data-status-key="fixing_with_ai"
          className={`${statusTextClass('fixing_with_ai')} ${filterClass('fixing_with_ai')}`}
          onClick={(e) => onStatusClick?.('fixing_with_ai', e)}
        >
          Fixing: <span className="font-medium">{fixing}</span>
        </span>
      )}
      {queueStatus && (
        <span className="text-[11px] text-muted-foreground">
          Queue capacity includes assigning and AI-fix work.
        </span>
      )}
      {fixApproval > 0 && (
        <span
          data-testid="status-bar-pill-fix_approval"
          data-status-key="fix_approval"
          className={`${statusTextClass('fix_approval')} ${filterClass('fix_approval')}`}
          onClick={(e) => onStatusClick?.('fix_approval', e)}
        >
          Fix Approval: <span className="font-medium">{fixApproval}</span>
        </span>
      )}
    </div>
  );
}
