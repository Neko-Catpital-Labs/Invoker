/**
 * QueueView — Displays scheduler queue status with cancel capability.
 *
 * Shows three sections:
 * - Running tasks (from scheduler)
 * - Queued tasks (from scheduler, with priority)
 * - Pending tasks (from task state map, not yet scheduled)
 *
 * Polls getQueueStatus() every 2 seconds.
 */

import { useState, useEffect, useCallback } from 'react';
import type { TaskState } from '../types.js';

interface QueueViewProps {
  tasks: Map<string, TaskState>;
  onTaskClick: (task: TaskState) => void;
  onCancel: (taskId: string) => void;
  selectedTaskId: string | null;
}

interface QueueStatus {
  maxConcurrency: number;
  runningCount: number;
  running: Array<{ taskId: string; description: string }>;
  queued: Array<{ taskId: string; priority: number; description: string }>;
}

function displayTaskId(taskId: string): string {
  const slash = taskId.lastIndexOf('/');
  return slash >= 0 ? taskId.slice(slash + 1) : taskId;
}

function displayDependencies(taskIds: string[]): string {
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

  // Pending tasks from the task map (not yet in scheduler)
  const pendingTasks = Array.from(tasks.values()).filter(
    (t) => t.status === 'pending' || t.status === 'blocked',
  );

  return (
    <div className="h-full overflow-y-auto bg-gray-900 p-4 flex flex-col gap-4">
      {/* Section A: Concurrency Status */}
      {queueStatus && (
        <div className="text-xs text-gray-400 mb-1">
          Running {queueStatus.runningCount} / {queueStatus.maxConcurrency}
        </div>
      )}

      {/* Section B: Running Tasks */}
      <div>
        <h3 className="text-sm font-semibold text-yellow-400 mb-2">
          Running ({queueStatus?.running.length ?? 0})
        </h3>
        {queueStatus?.running.map((job) => {
          const task = tasks.get(job.taskId);
          return (
            <div
              key={job.taskId}
              onClick={() => task && onTaskClick(task)}
              className={`flex items-center justify-between p-2 rounded mb-1 cursor-pointer ${
                selectedTaskId === job.taskId ? 'bg-gray-600' : 'bg-gray-800 hover:bg-gray-700'
              }`}
            >
              <div className="flex-1 min-w-0">
                <span className="text-sm font-bold text-gray-100 truncate block">{displayTaskId(job.taskId)}</span>
                <span className="text-xs text-gray-400 truncate block">{job.description}</span>
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
        {queueStatus?.running.length === 0 && (
          <div className="text-xs text-gray-500 italic">No running tasks</div>
        )}
      </div>

      {/* Section C: Queued Tasks */}
      <div>
        <h3 className="text-sm font-semibold text-cyan-400 mb-2">
          Queued ({queueStatus?.queued.length ?? 0})
        </h3>
        {queueStatus?.queued.map((job) => {
          const task = tasks.get(job.taskId);
          return (
            <div
              key={job.taskId}
              onClick={() => task && onTaskClick(task)}
              className={`flex items-center justify-between p-2 rounded mb-1 cursor-pointer ${
                selectedTaskId === job.taskId ? 'bg-gray-600' : 'bg-gray-800 hover:bg-gray-700'
              }`}
            >
              <div className="flex-1 min-w-0">
                <span className="text-sm text-gray-100 truncate block">{displayTaskId(job.taskId)}</span>
                <span className="text-xs text-gray-400 truncate block">{job.description}</span>
              </div>
              <span className="text-xs bg-cyan-900 text-cyan-300 px-2 py-0.5 rounded ml-2 shrink-0">
                pri: {job.priority}
              </span>
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
        {queueStatus?.queued.length === 0 && (
          <div className="text-xs text-gray-500 italic">No queued tasks</div>
        )}
      </div>

      {/* Section D: Pending Tasks (from props) */}
      <div>
        <h3 className="text-sm font-semibold text-gray-400 mb-2">
          Pending ({pendingTasks.length})
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
          <div className="text-xs text-gray-500 italic">No pending tasks</div>
        )}
      </div>
    </div>
  );
}
