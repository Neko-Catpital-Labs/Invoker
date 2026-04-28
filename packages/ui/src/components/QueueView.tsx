/**
 * QueueView — Displays the Action Queue and Backlog.
 *
 * Action Queue shows all actionable tasks:
 * - scheduler-running and scheduler-queued tasks
 * - tasks in manual-action states (fixing_with_ai, needs_input,
 *   review_ready, awaiting_approval)
 *
 * Backlog shows blocked or otherwise non-actionable tasks.
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import type { TaskState } from '../types.js';
import {
  getRunningPhaseLabel,
  getStatusColor,
  getEffectiveVisualStatus,
  formatStatusLabel,
} from '../lib/colors.js';

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
  if (taskId.startsWith('__merge__')) return 'merge gate';
  const slash = taskId.lastIndexOf('/');
  return slash >= 0 ? taskId.slice(slash + 1) : taskId;
}

function displayDependencies(taskIds: readonly string[]): string {
  return taskIds.map(displayTaskId).join(', ');
}

/** Statuses that represent manual-action states — always actionable. */
const MANUAL_ACTION_STATUSES = new Set([
  'fixing_with_ai',
  'needs_input',
  'review_ready',
  'awaiting_approval',
]);

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
    const schedulerTaskIds = new Set<string>();

    const running = (queueStatus?.running ?? []).map((job, idx) => {
      schedulerTaskIds.add(job.taskId);
      return { ...job, order: idx + 1 };
    });

    const queued = (queueStatus?.queued ?? []).map((job, idx) => {
      schedulerTaskIds.add(job.taskId);
      return { taskId: job.taskId, description: job.description, priority: job.priority, order: running.length + idx + 1 };
    });

    // Manual-action tasks not already in the scheduler queue
    const manualAction = Array.from(tasks.values())
      .filter((t) => MANUAL_ACTION_STATUSES.has(t.status) && !schedulerTaskIds.has(t.id))
      .map((t, idx) => ({
        taskId: t.id,
        description: t.description,
        order: running.length + queued.length + idx + 1,
      }));

    return [...running, ...queued, ...manualAction];
  }, [queueStatus, tasks]);

  const actionTaskIds = useMemo(
    () => new Set(actionRows.map((a) => a.taskId)),
    [actionRows],
  );

  const backlogTasks = useMemo(
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
          Running and scheduled actions, plus tasks awaiting manual action.
        </div>
        {queueStatus && (
          <div className="text-xs text-gray-400 mb-2">
            Running {queueStatus.runningCount} / {queueStatus.maxConcurrency}
          </div>
        )}

        {actionRows.map((job) => {
          const task = tasks.get(job.taskId);
          const visualStatus = task
            ? getEffectiveVisualStatus(task.status, task.execution)
            : 'pending';
          const statusLabel = task ? formatStatusLabel(task.status) : 'Pending';
          const colors = getStatusColor(visualStatus);
          const phaseLabel = task?.status === 'running' ? getRunningPhaseLabel(task.execution.phase) : null;
          return (
            <div
              key={`action-${job.taskId}`}
              onClick={() => task && onTaskClick(task)}
              className={`flex items-center justify-between p-2 rounded mb-1 cursor-pointer ${
                selectedTaskId === job.taskId ? 'bg-gray-600' : 'bg-gray-800 hover:bg-gray-700'
              }`}
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-gray-500">#{job.order}</span>
                  <span className="text-sm text-gray-100 truncate">{displayTaskId(job.taskId)}</span>
                  <span className={`text-xs px-2 py-0.5 rounded shrink-0 ${colors.bg} ${colors.text}`}>
                    {statusLabel}
                  </span>
                </div>
                <span className="text-xs text-gray-400 truncate block">{job.description}</span>
                {phaseLabel && (
                  <span className="text-xs text-amber-300 truncate block">phase: {phaseLabel}</span>
                )}
                {'priority' in job && typeof (job as Record<string, unknown>).priority === 'number' && (
                  <span className="text-xs text-cyan-300 truncate block">priority: {(job as Record<string, unknown>).priority as number}</span>
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
          Backlog ({backlogTasks.length})
        </h3>
        {backlogTasks.map((task) => (
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
        {backlogTasks.length === 0 && (
          <div className="text-xs text-gray-500 italic">No pending or blocked tasks outside the queue</div>
        )}
      </div>
    </div>
  );
}
