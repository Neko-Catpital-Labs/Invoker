/**
 * StatusBar — Bottom bar showing workflow status counts.
 *
 * Displays: Total | Completed | Running | Failed | Pending
 * Updates reactively from the task map.
 * Status labels are clickable to filter DAG nodes by status.
 */

import type { TaskState } from '../types.js';

interface StatusBarProps {
  tasks: Map<string, TaskState>;
  activeFilters?: Set<string>;
  onStatusClick?: (filterKey: string, event: React.MouseEvent) => void;
}

export function StatusBar({ tasks, activeFilters, onStatusClick }: StatusBarProps) {
  let completed = 0;
  let running = 0;
  let failed = 0;
  let pending = 0;
  let needsInput = 0;
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
        } else {
          running++;
        }
        break;
      case 'fixing_with_ai':
        fixing++;
        break;
      case 'failed':
        failed++;
        break;
      case 'pending':
        pending++;
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
      case 'blocked':
        blocked++;
        break;
    }
  }

  const total = tasks.size;

  const hasFilters = activeFilters && activeFilters.size > 0;
  const filterClass = (key: string) => {
    if (!hasFilters) return 'cursor-pointer hover:brightness-125 select-none';
    const isActive = activeFilters!.has(key);
    return `cursor-pointer select-none transition-opacity duration-75 ${
      isActive ? 'brightness-125 underline underline-offset-4' : 'opacity-40'
    }`;
  };

  return (
    <div className="flex items-center gap-6 px-4 py-2 bg-gray-800 border-t border-gray-700 text-sm">
      <span className="text-gray-400">
        Total: <span className="text-gray-100 font-medium">{total}</span>
      </span>
      <span
        className={`text-green-400 ${filterClass('completed')}`}
        onClick={(e) => onStatusClick?.('completed', e)}
      >
        Completed: <span className="font-medium">{completed}</span>
      </span>
      <span
        className={`text-blue-400 ${filterClass('running')}`}
        onClick={(e) => onStatusClick?.('running', e)}
      >
        Running: <span className="font-medium">{running}</span>
      </span>
      <span
        className={`text-red-400 ${filterClass('failed')}`}
        onClick={(e) => onStatusClick?.('failed', e)}
      >
        Failed: <span className="font-medium">{failed}</span>
      </span>
      <span
        className={`text-gray-400 ${filterClass('pending')}`}
        onClick={(e) => onStatusClick?.('pending', e)}
      >
        Pending: <span className="font-medium">{pending}</span>
      </span>
      {needsInput > 0 && (
        <span
          className={`text-cyan-400 ${filterClass('needs_input')}`}
          onClick={(e) => onStatusClick?.('needs_input', e)}
        >
          Input: <span className="font-medium">{needsInput}</span>
        </span>
      )}
      {awaitingApproval > 0 && (
        <span
          className={`text-purple-400 ${filterClass('awaiting_approval')}`}
          onClick={(e) => onStatusClick?.('awaiting_approval', e)}
        >
          Approval: <span className="font-medium">{awaitingApproval}</span>
        </span>
      )}
      {blocked > 0 && (
        <span
          className={`text-gray-500 ${filterClass('blocked')}`}
          onClick={(e) => onStatusClick?.('blocked', e)}
        >
          Blocked: <span className="font-medium">{blocked}</span>
        </span>
      )}
      {fixing > 0 && (
        <span
          className={`text-orange-400 ${filterClass('fixing_with_ai')}`}
          onClick={(e) => onStatusClick?.('fixing_with_ai', e)}
        >
          Fixing: <span className="font-medium">{fixing}</span>
        </span>
      )}
      {fixApproval > 0 && (
        <span
          className={`text-fuchsia-400 ${filterClass('fix_approval')}`}
          onClick={(e) => onStatusClick?.('fix_approval', e)}
        >
          Fix Approval: <span className="font-medium">{fixApproval}</span>
        </span>
      )}
    </div>
  );
}
