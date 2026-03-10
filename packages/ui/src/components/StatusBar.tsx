/**
 * StatusBar — Bottom bar showing workflow status counts.
 *
 * Displays: Total | Completed | Running | Failed | Pending
 * Updates reactively from the task map.
 */

import type { TaskState } from '../types.js';

interface StatusBarProps {
  tasks: Map<string, TaskState>;
  onSystemLog?: () => void;
}

export function StatusBar({ tasks, onSystemLog }: StatusBarProps) {
  let completed = 0;
  let running = 0;
  let failed = 0;
  let pending = 0;
  let needsInput = 0;
  let awaitingApproval = 0;
  let blocked = 0;

  for (const task of tasks.values()) {
    switch (task.status) {
      case 'completed':
        completed++;
        break;
      case 'running':
        running++;
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
        awaitingApproval++;
        break;
      case 'blocked':
        blocked++;
        break;
    }
  }

  const total = tasks.size;

  return (
    <div className="flex items-center gap-6 px-4 py-2 bg-gray-800 border-t border-gray-700 text-sm">
      {onSystemLog && (
        <button
          onClick={onSystemLog}
          className="text-cyan-400 hover:text-cyan-300 font-medium cursor-pointer"
        >
          System Log
        </button>
      )}
      <span className="text-gray-400">
        Total: <span className="text-gray-100 font-medium">{total}</span>
      </span>
      <span className="text-green-400">
        Completed: <span className="font-medium">{completed}</span>
      </span>
      <span className="text-blue-400">
        Running: <span className="font-medium">{running}</span>
      </span>
      <span className="text-red-400">
        Failed: <span className="font-medium">{failed}</span>
      </span>
      <span className="text-gray-400">
        Pending: <span className="font-medium">{pending}</span>
      </span>
      {needsInput > 0 && (
        <span className="text-amber-400">
          Input: <span className="font-medium">{needsInput}</span>
        </span>
      )}
      {awaitingApproval > 0 && (
        <span className="text-purple-400">
          Approval: <span className="font-medium">{awaitingApproval}</span>
        </span>
      )}
      {blocked > 0 && (
        <span className="text-gray-500">
          Blocked: <span className="font-medium">{blocked}</span>
        </span>
      )}
    </div>
  );
}
