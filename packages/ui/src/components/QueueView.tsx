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
  running: Array<{ taskId: string; description: string }>;
  queued: Array<{ taskId: string; priority: number; description: string }>;
}

type QueueSubTab = 'running' | 'queued' | 'pending' | 'enqueuedActions';

type AutoFixPhase = 'schedule-enqueue' | 'auto-fix-start' | 'schedule-skip' | 'drain-skip';

interface AutoFixEventRow {
  id: string;
  taskId: string;
  createdAt: string;
  phase: AutoFixPhase;
  payload: Record<string, unknown>;
}

const AUTO_FIX_PHASES = new Set<AutoFixPhase>([
  'schedule-enqueue',
  'auto-fix-start',
  'schedule-skip',
  'drain-skip',
]);
const MAX_ENQUEUED_ROWS = 200;

function displayTaskId(taskId: string): string {
  const slash = taskId.lastIndexOf('/');
  return slash >= 0 ? taskId.slice(slash + 1) : taskId;
}

function displayDependencies(taskIds: readonly string[]): string {
  return taskIds.map(displayTaskId).join(', ');
}

export function QueueView({ tasks, onTaskClick, onCancel, selectedTaskId }: QueueViewProps) {
  const [queueStatus, setQueueStatus] = useState<QueueStatus | null>(null);
  const [activeTab, setActiveTab] = useState<QueueSubTab>('running');
  const [enqueuedActions, setEnqueuedActions] = useState<AutoFixEventRow[]>([]);

  const pendingTasks = useMemo(
    () =>
      Array.from(tasks.values()).filter(
        (t) => t.status === 'pending' || t.status === 'blocked',
      ),
    [tasks],
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

  useEffect(() => {
    let cancelled = false;

    const pollEnqueuedActions = async () => {
      try {
        const rows: AutoFixEventRow[] = [];
        const taskIds = Array.from(tasks.keys());
        const eventBatches = await Promise.all(
          taskIds.map(async (taskId) => {
            try {
              return { taskId, events: await window.invoker?.getEvents(taskId) };
            } catch {
              return { taskId, events: [] };
            }
          }),
        );
        for (const batch of eventBatches) {
          for (const event of batch.events ?? []) {
            if (event.eventType !== 'debug.auto-fix') continue;
            if (!event.payload) continue;
            let parsedPayload: Record<string, unknown>;
            try {
              parsedPayload = JSON.parse(event.payload) as Record<string, unknown>;
            } catch {
              continue;
            }
            const phase = parsedPayload.phase;
            if (!phase || typeof phase !== 'string' || !AUTO_FIX_PHASES.has(phase as AutoFixPhase)) {
              continue;
            }
            rows.push({
              id: `${event.id}`,
              taskId: batch.taskId,
              createdAt: event.createdAt,
              phase: phase as AutoFixPhase,
              payload: parsedPayload,
            });
          }
        }

        rows.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
        if (!cancelled) setEnqueuedActions(rows.slice(0, MAX_ENQUEUED_ROWS));
      } catch {
        if (!cancelled) setEnqueuedActions([]);
      }
    };

    pollEnqueuedActions();
    const interval = setInterval(pollEnqueuedActions, 2000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [tasks]);

  const handleCancel = useCallback(
    (taskId: string) => {
      const confirmed = window.confirm(`Cancel task "${taskId}" and all downstream dependents?`);
      if (confirmed) onCancel(taskId);
    },
    [onCancel],
  );

  const tabButtonClass = (tab: QueueSubTab): string =>
    `px-3 py-1 text-xs font-medium transition-colors ${
      activeTab === tab
        ? 'bg-indigo-600 text-white'
        : 'bg-gray-700 hover:bg-gray-600 text-gray-300'
    }`;

  const renderAutoFixMeta = (row: AutoFixEventRow): string => {
    const p = row.payload;
    if (row.phase === 'schedule-enqueue') {
      return `status=${String(p.status ?? 'unknown')} attempts=${String(p.autoFixAttempts ?? 'n/a')}`;
    }
    if (row.phase === 'auto-fix-start') {
      return `attempt=${String(p.attemptsAfter ?? '?')}/${String(p.maxRetries ?? '?')} hasMergeConflict=${String(p.hasMergeConflict ?? false)}`;
    }
    if (row.phase === 'schedule-skip' || row.phase === 'drain-skip') {
      return `status=${String(p.status ?? 'unknown')} inProgress=${String(p.inProgress ?? false)} queued=${String(p.queued ?? false)} shouldAutoFix=${String(p.shouldAutoFix ?? false)}`;
    }
    return '';
  };

  return (
    <div className="h-full overflow-y-auto bg-gray-900 p-4 flex flex-col gap-4">
      <div className="flex rounded overflow-hidden border border-gray-600 w-fit">
        <button onClick={() => setActiveTab('running')} className={tabButtonClass('running')}>
          Running ({queueStatus?.running.length ?? 0})
        </button>
        <button onClick={() => setActiveTab('queued')} className={tabButtonClass('queued')}>
          Queued ({queueStatus?.queued.length ?? 0})
        </button>
        <button onClick={() => setActiveTab('pending')} className={tabButtonClass('pending')}>
          Pending ({pendingTasks.length})
        </button>
        <button
          onClick={() => setActiveTab('enqueuedActions')}
          className={tabButtonClass('enqueuedActions')}
        >
          Action History ({enqueuedActions.length})
        </button>
      </div>

      {/* Section A: Concurrency Status */}
      {queueStatus && (
        <div className="text-xs text-gray-400 mb-1">
          Running {queueStatus.runningCount} / {queueStatus.maxConcurrency}
        </div>
      )}

      {/* Section B: Running Tasks */}
      {activeTab === 'running' && (
      <div>
        <h3 className="text-sm font-semibold text-yellow-400 mb-2">
          Running ({queueStatus?.running.length ?? 0})
        </h3>
        {queueStatus?.running.map((job) => {
          const task = tasks.get(job.taskId);
          const phaseLabel = task?.status === 'running' ? getRunningPhaseLabel(task.execution.phase) : null;
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
                {phaseLabel && (
                  <span className="text-xs text-amber-300 truncate block">phase: {phaseLabel}</span>
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
        {queueStatus?.running.length === 0 && (
          <div className="text-xs text-gray-500 italic">No running tasks</div>
        )}
      </div>
      )}

      {/* Section C: Queued Tasks */}
      {activeTab === 'queued' && (
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
      )}

      {/* Section D: Pending Tasks (from props) */}
      {activeTab === 'pending' && (
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
      )}

      {activeTab === 'enqueuedActions' && (
        <div>
          <h3 className="text-sm font-semibold text-violet-400 mb-2">
            Action History ({enqueuedActions.length})
          </h3>
          {enqueuedActions.map((row) => {
            const task = tasks.get(row.taskId);
            return (
              <div
                key={row.id}
                onClick={() => task && onTaskClick(task)}
                className={`p-2 rounded mb-1 cursor-pointer ${
                  selectedTaskId === row.taskId ? 'bg-gray-600' : 'bg-gray-800 hover:bg-gray-700'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm text-gray-100 truncate">{displayTaskId(row.taskId)}</span>
                  <span className="text-xs bg-violet-900 text-violet-300 px-2 py-0.5 rounded shrink-0">
                    {row.phase}
                  </span>
                </div>
                <div className="text-xs text-gray-400 truncate">{new Date(row.createdAt).toLocaleTimeString()}</div>
                <div className="text-xs text-gray-500 truncate">{renderAutoFixMeta(row)}</div>
              </div>
            );
          })}
          {enqueuedActions.length === 0 && (
            <div className="text-xs text-gray-500 italic">No auto-fix action history yet</div>
          )}
        </div>
      )}
    </div>
  );
}
