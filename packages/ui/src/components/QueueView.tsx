/**
 * QueueView — Displays live action queue with cancel capability.
 *
 * Action Queue mirrors `headless query queue`:
 * - running actions (currently executing)
 * - queued actions (next in scheduler order)
 *
 * Pending/blocked tasks are shown separately as backlog.
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import type { TaskState } from '../types.js';
import { getRunningPhaseLabel } from '../lib/colors.js';

interface QueueViewProps {
  tasks: Map<string, TaskState>;
  onTaskClick: (task: TaskState) => void;
  onCancel: (taskId: string) => void;
  selectedTaskId: string | null;
}

interface QueueStatus {
  maxConcurrency: number;
  runningCount: number;
  running: Array<{ taskId: string; description: string; attemptId?: string }>;
  queued: Array<{ taskId: string; priority: number; description: string }>;
}

function displayTaskId(taskId: string): string {
  const slash = taskId.lastIndexOf('/');
  return slash >= 0 ? taskId.slice(slash + 1) : taskId;
}

function displayDependencies(taskIds: readonly string[]): string {
  return taskIds.map(displayTaskId).join(', ');
}

export function QueueView({ tasks, onTaskClick, onCancel, selectedTaskId }: QueueViewProps) {
  const [queueStatus, setQueueStatus] = useState<QueueStatus | null>(null);

  useEffect(() => {
    let cancelled = false;

    const poll = async () => {
      try {
        const status = await window.invoker?.getQueueStatus();
        if (!cancelled && status) setQueueStatus(status);
      } catch {
        // ignore polling errors
      }
    };

    poll();
    const interval = setInterval(poll, 2000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  const handleCancel = useCallback(
    (taskId: string) => {
      const confirmed = window.confirm(`Cancel task "${taskId}" and all downstream dependents?`);
      if (confirmed) onCancel(taskId);
    },
    [onCancel],
  );

  const actionRows = useMemo(() => {
    const running = (queueStatus?.running ?? []).map((job, idx) => ({
      ...job,
      state: 'running' as const,
      order: idx + 1,
    }));
    const queued = (queueStatus?.queued ?? []).map((job, idx) => ({
      ...job,
      state: 'queued' as const,
      order: running.length + idx + 1,
    }));
    return [...running, ...queued];
  }, [queueStatus]);

  const actionTaskIds = useMemo(
    () => new Set(actionRows.map((a) => a.taskId)),
    [actionRows],
  );

  const pendingTasks = useMemo(
    () =>
      Array.from(tasks.values()).filter(
        (t) =>
          (t.status === 'pending' || t.status === 'blocked')
          && !actionTaskIds.has(t.id),
      ),
    [tasks, actionTaskIds],
  );

  return (
    <div className="h-full overflow-y-auto bg-gray-900 p-4 flex flex-col gap-4">
      <div>
        <h3 className="text-sm font-semibold text-cyan-300 mb-1">
          Action Queue ({actionRows.length})
        </h3>
        <div className="text-xs text-gray-400 mb-2">
          Mirrors headless query queue: running actions first, then queued actions.
        </div>
        {queueStatus && (
          <div className="text-xs text-gray-400 mb-2">
            Running {queueStatus.runningCount} / {queueStatus.maxConcurrency}
          </div>
        )}

        {actionRows.map((job) => {
          const task = tasks.get(job.taskId);
          const phaseLabel = task?.status === 'running' ? getRunningPhaseLabel(task.execution.phase) : null;
          const stateStyle = job.state === 'running'
            ? 'bg-amber-900 text-amber-300'
            : 'bg-cyan-900 text-cyan-300';
          return (
            <div
              key={`${job.state}-${job.taskId}`}
              onClick={() => task && onTaskClick(task)}
              className={`flex items-center justify-between p-2 rounded mb-1 cursor-pointer ${
                selectedTaskId === job.taskId ? 'bg-gray-600' : 'bg-gray-800 hover:bg-gray-700'
              }`}
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-gray-500">#{job.order}</span>
                  <span className="text-sm text-gray-100 truncate">{displayTaskId(job.taskId)}</span>
                  <span className={`text-xs px-2 py-0.5 rounded shrink-0 ${stateStyle}`}>
                    {job.state}
                  </span>
                </div>
                <span className="text-xs text-gray-400 truncate block">{job.description}</span>
                {phaseLabel && (
                  <span className="text-xs text-amber-300 truncate block">phase: {phaseLabel}</span>
                )}
                {job.state === 'queued' && 'priority' in job && (
                  <span className="text-xs text-cyan-300 truncate block">priority: {job.priority}</span>
                )}
              </div>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handleCancel(job.taskId);
                }}
                className="ml-2 px-2 py-0.5 text-xs bg-red-700 hover:bg-red-600 text-white rounded shrink-0"
              >
                Cancel
              </button>
            </div>
          );
        })}
        {actionRows.length === 0 && (
          <div className="text-xs text-gray-500 italic">No running or queued actions</div>
        )}
      </div>

      <div>
        <h3 className="text-sm font-semibold text-gray-300 mb-2">
          Backlog (Pending/Blocked, not in queue) ({pendingTasks.length})
        </h3>
        {pendingTasks.map((task) => (
          <div
            key={task.id}
            onClick={() => onTaskClick(task)}
            className={`flex items-center justify-between p-2 rounded mb-1 cursor-pointer ${
              selectedTaskId === task.id ? 'bg-gray-600' : 'bg-gray-800 hover:bg-gray-700'
            }`}
          >
            <div className="flex-1 min-w-0">
              <span className="text-sm text-gray-100 truncate block">{displayTaskId(task.id)}</span>
              <span className="text-xs text-gray-400 truncate block">{task.description}</span>
              {task.dependencies.length > 0 && (
                <span className="text-xs text-gray-500 truncate block">
                  deps: {displayDependencies(task.dependencies)}
                </span>
              )}
            </div>
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleCancel(task.id);
              }}
              className="ml-2 px-2 py-0.5 text-xs bg-red-700 hover:bg-red-600 text-white rounded shrink-0"
            >
              Cancel
            </button>
          </div>
        ))}
        {pendingTasks.length === 0 && (
          <div className="text-xs text-gray-500 italic">No pending or blocked tasks outside the queue</div>
        )}
      </div>
    </div>
  );
}
