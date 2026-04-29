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

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
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
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  /** Reverse index: taskId → list of task IDs that depend on it. */
  const dependentsMap = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const [, task] of tasks) {
      for (const dep of task.dependencies) {
        let list = map.get(dep);
        if (!list) {
          list = [];
          map.set(dep, list);
        }
        list.push(task.id);
      }
    }
    return map;
  }, [tasks]);

  const toggleExpanded = useCallback((taskId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  }, []);

  const handleRelatedClick = useCallback(
    (taskId: string, e: React.MouseEvent) => {
      e.stopPropagation();
      const task = tasks.get(taskId);
      if (task) onTaskClick(task);
      // Scroll to the row if it exists in the current view
      const el = rowRefs.current.get(taskId);
      if (el?.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    },
    [tasks, onTaskClick],
  );

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
      const confirmed = window.confirm(`Terminate task "${displayTaskId(taskId)}" and all downstream dependents?`);
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
          const isExpanded = expandedRows.has(job.taskId);
          const upstream = task?.dependencies ?? [];
          const downstream = dependentsMap.get(job.taskId) ?? [];
          const hasRelationships = upstream.length > 0 || downstream.length > 0;
          return (
            <div
              key={`action-${job.taskId}`}
              ref={(el) => { if (el) rowRefs.current.set(job.taskId, el); }}
              data-row-id={job.taskId}
              className={`rounded mb-1 ${
                selectedTaskId === job.taskId ? 'bg-gray-600' : 'bg-gray-800 hover:bg-gray-700'
              }`}
            >
              <div
                onClick={() => task && onTaskClick(task)}
                className="flex items-center justify-between p-2 cursor-pointer"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-gray-500">#{job.order}</span>
                    <span className="text-sm text-gray-100 truncate">{displayTaskId(job.taskId)}</span>
                    <span className={`text-xs px-2 py-0.5 rounded shrink-0 ${colors.bg} ${colors.text}`}>
                      {statusLabel}
                    </span>
                    {hasRelationships && (
                      <button
                        onClick={(e) => toggleExpanded(job.taskId, e)}
                        className="text-xs text-gray-400 hover:text-gray-200 shrink-0"
                        aria-label={isExpanded ? 'Collapse relationships' : 'Expand relationships'}
                        aria-expanded={isExpanded}
                        data-testid={`queue-rels-toggle-action-${job.taskId}`}
                      >
                        {isExpanded ? '▾' : '▸'} rels
                      </button>
                    )}
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
                  Terminate
                </button>
              </div>
              {isExpanded && (
                <div className="mx-2 mb-2 pt-1 pb-1 border-t border-gray-700 text-xs" data-testid={`rels-${job.taskId}`}>
                  {upstream.length > 0 && (
                    <div className="mb-1">
                      <span className="text-gray-500">upstream: </span>
                      {upstream.map((depId) => (
                        <button
                          key={depId}
                          onClick={(e) => handleRelatedClick(depId, e)}
                          className="inline-block mr-1 px-1.5 py-0.5 rounded bg-blue-900 text-blue-300 hover:bg-blue-800 cursor-pointer"
                        >
                          {displayTaskId(depId)}
                        </button>
                      ))}
                    </div>
                  )}
                  {downstream.length > 0 && (
                    <div>
                      <span className="text-gray-500">downstream: </span>
                      {downstream.map((depId) => (
                        <button
                          key={depId}
                          onClick={(e) => handleRelatedClick(depId, e)}
                          className="inline-block mr-1 px-1.5 py-0.5 rounded bg-green-900 text-green-300 hover:bg-green-800 cursor-pointer"
                        >
                          {displayTaskId(depId)}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
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
        {backlogTasks.map((task) => {
          const isExpanded = expandedRows.has(task.id);
          const upstream = task.dependencies;
          const downstream = dependentsMap.get(task.id) ?? [];
          const hasRelationships = upstream.length > 0 || downstream.length > 0;
          const backlogVisualStatus = getEffectiveVisualStatus(task.status, task.execution);
          const backlogStatusLabel = formatStatusLabel(task.status);
          const backlogColors = getStatusColor(backlogVisualStatus);
          return (
            <div
              key={task.id}
              ref={(el) => { if (el) rowRefs.current.set(task.id, el); }}
              data-row-id={task.id}
              className={`rounded mb-1 ${
                selectedTaskId === task.id ? 'bg-gray-600' : 'bg-gray-800 hover:bg-gray-700'
              }`}
            >
              <div
                onClick={() => onTaskClick(task)}
                className="flex items-center justify-between p-2 cursor-pointer"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-gray-100 truncate">{displayTaskId(task.id)}</span>
                    <span className={`text-xs px-2 py-0.5 rounded shrink-0 ${backlogColors.bg} ${backlogColors.text}`}>
                      {backlogStatusLabel}
                    </span>
                    {hasRelationships && (
                      <button
                        onClick={(e) => toggleExpanded(task.id, e)}
                        className="text-xs text-gray-400 hover:text-gray-200 shrink-0"
                        aria-label={isExpanded ? 'Collapse relationships' : 'Expand relationships'}
                        aria-expanded={isExpanded}
                        data-testid={`queue-rels-toggle-backlog-${task.id}`}
                      >
                        {isExpanded ? '▾' : '▸'} rels
                      </button>
                    )}
                  </div>
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
                  Terminate
                </button>
              </div>
              {isExpanded && (
                <div className="mx-2 mb-2 pt-1 pb-1 border-t border-gray-700 text-xs" data-testid={`rels-${task.id}`}>
                  {upstream.length > 0 && (
                    <div className="mb-1">
                      <span className="text-gray-500">upstream: </span>
                      {upstream.map((depId) => (
                        <button
                          key={depId}
                          onClick={(e) => handleRelatedClick(depId, e)}
                          className="inline-block mr-1 px-1.5 py-0.5 rounded bg-blue-900 text-blue-300 hover:bg-blue-800 cursor-pointer"
                        >
                          {displayTaskId(depId)}
                        </button>
                      ))}
                    </div>
                  )}
                  {downstream.length > 0 && (
                    <div>
                      <span className="text-gray-500">downstream: </span>
                      {downstream.map((depId) => (
                        <button
                          key={depId}
                          onClick={(e) => handleRelatedClick(depId, e)}
                          className="inline-block mr-1 px-1.5 py-0.5 rounded bg-green-900 text-green-300 hover:bg-green-800 cursor-pointer"
                        >
                          {displayTaskId(depId)}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {backlogTasks.length === 0 && (
          <div className="text-xs text-gray-500 italic">No pending or blocked tasks outside the queue</div>
        )}
      </div>
    </div>
  );
}
