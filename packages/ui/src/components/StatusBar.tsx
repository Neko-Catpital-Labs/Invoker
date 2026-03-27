/**
 * StatusBar — Bottom bar showing workflow status counts.
 *
 * Displays: Total | Completed | Running | Failed | Pending
 * Updates reactively from the task map.
 * Status labels are clickable to filter DAG nodes by status.
 */

import { useRef, useCallback } from 'react';
import type { TaskState } from '../types.js';

interface StatusBarProps {
  tasks: Map<string, TaskState>;
  activeFilters?: Set<string>;
  onStatusClick?: (filterKey: string) => void;
  onStatusDoubleClick?: (filterKey: string) => void;
}

export function StatusBar({ tasks, activeFilters, onStatusClick, onStatusDoubleClick }: StatusBarProps) {
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

  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleClick = useCallback((key: string) => {
    if (clickTimer.current) clearTimeout(clickTimer.current);
    clickTimer.current = setTimeout(() => onStatusClick?.(key), 250);
  }, [onStatusClick]);

  const handleDoubleClick = useCallback((key: string) => {
    if (clickTimer.current) clearTimeout(clickTimer.current);
    onStatusDoubleClick?.(key);
  }, [onStatusDoubleClick]);

  const hasFilters = activeFilters && activeFilters.size > 0;
  const filterClass = (key: string) => {
    if (!hasFilters) return 'cursor-pointer hover:brightness-125 select-none';
    const isActive = activeFilters!.has(key);
    return `cursor-pointer select-none transition-opacity duration-200 ${
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
        onClick={() => handleClick('completed')}
        onDoubleClick={() => handleDoubleClick('completed')}
      >
        Completed: <span className="font-medium">{completed}</span>
      </span>
      <span
        className={`text-blue-400 ${filterClass('running')}`}
        onClick={() => handleClick('running')}
        onDoubleClick={() => handleDoubleClick('running')}
      >
        Running: <span className="font-medium">{running}</span>
      </span>
      <span
        className={`text-red-400 ${filterClass('failed')}`}
        onClick={() => handleClick('failed')}
        onDoubleClick={() => handleDoubleClick('failed')}
      >
        Failed: <span className="font-medium">{failed}</span>
      </span>
      <span
        className={`text-gray-400 ${filterClass('pending')}`}
        onClick={() => handleClick('pending')}
        onDoubleClick={() => handleDoubleClick('pending')}
      >
        Pending: <span className="font-medium">{pending}</span>
      </span>
      {needsInput > 0 && (
        <span
          className={`text-amber-400 ${filterClass('needs_input')}`}
          onClick={() => handleClick('needs_input')}
          onDoubleClick={() => handleDoubleClick('needs_input')}
        >
          Input: <span className="font-medium">{needsInput}</span>
        </span>
      )}
      {awaitingApproval > 0 && (
        <span
          className={`text-purple-400 ${filterClass('awaiting_approval')}`}
          onClick={() => handleClick('awaiting_approval')}
          onDoubleClick={() => handleDoubleClick('awaiting_approval')}
        >
          Approval: <span className="font-medium">{awaitingApproval}</span>
        </span>
      )}
      {blocked > 0 && (
        <span
          className={`text-gray-500 ${filterClass('blocked')}`}
          onClick={() => handleClick('blocked')}
          onDoubleClick={() => handleDoubleClick('blocked')}
        >
          Blocked: <span className="font-medium">{blocked}</span>
        </span>
      )}
      {fixing > 0 && (
        <span
          className={`text-orange-400 ${filterClass('fixing_with_ai')}`}
          onClick={() => handleClick('fixing_with_ai')}
          onDoubleClick={() => handleDoubleClick('fixing_with_ai')}
        >
          Fixing: <span className="font-medium">{fixing}</span>
        </span>
      )}
      {fixApproval > 0 && (
        <span
          className={`text-amber-500 ${filterClass('fix_approval')}`}
          onClick={() => handleClick('fix_approval')}
          onDoubleClick={() => handleDoubleClick('fix_approval')}
        >
          Fix Approval: <span className="font-medium">{fixApproval}</span>
        </span>
      )}
    </div>
  );
}
