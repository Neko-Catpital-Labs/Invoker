/**
 * TimelineView — Gantt-style horizontal timeline of task execution.
 *
 * Shows each task as a horizontal bar on a time axis, with live elapsed
 * timers for running tasks. Useful for spotting which tasks are taking
 * long and understanding execution parallelism.
 */

import { useState, useEffect } from 'react';
import type { TaskState } from '../types.js';
import { getStatusInlineColors } from '../lib/colors.js';

// ── Exported helpers (tested independently) ─────────────────

/** Format a duration in milliseconds to a human-readable string. */
export function formatElapsed(ms: number): string {
  if (ms < 0) return '0s';
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}

/** Sort tasks for timeline display: running first, then by startedAt, pending last. */
export function sortTasksForTimeline(tasks: TaskState[]): TaskState[] {
  const statusOrder: Record<string, number> = {
    running: 0,
    needs_input: 1,
    awaiting_approval: 2,
    failed: 3,
    completed: 4,
    pending: 5,
    blocked: 6,
    stale: 7,
  };

  return [...tasks].sort((a, b) => {
    const orderA = statusOrder[a.status] ?? 9;
    const orderB = statusOrder[b.status] ?? 9;
    if (orderA !== orderB) return orderA - orderB;
    const timeA = a.execution.startedAt ? new Date(a.execution.startedAt).getTime() : Infinity;
    const timeB = b.execution.startedAt ? new Date(b.execution.startedAt).getTime() : Infinity;
    return timeA - timeB;
  });
}

export interface BarInfo {
  taskId: string;
  offsetPercent: number;
  widthPercent: number;
  durationMs: number;
}

/**
 * Compute bar positions as percentages of the total timeline span.
 * Tasks without startedAt get zero width at the end.
 */
export function computeBarWidths(tasks: TaskState[], now: number): BarInfo[] {
  const started = tasks.filter((t) => t.execution.startedAt);
  if (started.length === 0) {
    return tasks.map((t) => ({
      taskId: t.id,
      offsetPercent: 0,
      widthPercent: 0,
      durationMs: 0,
    }));
  }

  const earliest = Math.min(...started.map((t) => new Date(t.execution.startedAt!).getTime()));
  const latest = Math.max(
    ...started.map((t) => {
      const end = t.execution.completedAt ? new Date(t.execution.completedAt).getTime() : now;
      return end;
    }),
  );
  const span = latest - earliest || 1;

  return tasks.map((t) => {
    if (!t.execution.startedAt) {
      return { taskId: t.id, offsetPercent: 0, widthPercent: 0, durationMs: 0 };
    }
    const start = new Date(t.execution.startedAt).getTime();
    const end = t.execution.completedAt ? new Date(t.execution.completedAt).getTime() : now;
    const duration = end - start;
    return {
      taskId: t.id,
      offsetPercent: ((start - earliest) / span) * 100,
      widthPercent: Math.max((duration / span) * 100, 0.5),
      durationMs: duration,
    };
  });
}

// ── Component ───────────────────────────────────────────────

interface TimelineViewProps {
  tasks: Map<string, TaskState>;
  onTaskClick: (task: TaskState) => void;
  selectedTaskId: string | null;
}

export function TimelineView({ tasks, onTaskClick, selectedTaskId }: TimelineViewProps) {
  const [now, setNow] = useState(Date.now());

  const hasRunning = Array.from(tasks.values()).some((t) => t.status === 'running');
  useEffect(() => {
    if (!hasRunning) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [hasRunning]);

  const taskList = sortTasksForTimeline(Array.from(tasks.values()));
  const bars = computeBarWidths(taskList, now);
  const barMap = new Map(bars.map((b) => [b.taskId, b]));

  if (taskList.length === 0) {
    return (
      <div className="h-full flex items-center justify-center text-gray-500 text-sm">
        No tasks to display
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto p-4" data-testid="timeline-view">
      <div className="space-y-1">
        {taskList.map((task) => {
          const bar = barMap.get(task.id)!;
          const colors = getStatusInlineColors(task.status);
          const isSelected = selectedTaskId === task.id;
          const elapsed = task.execution.startedAt
            ? formatElapsed(
                task.execution.completedAt
                  ? new Date(task.execution.completedAt).getTime() - new Date(task.execution.startedAt).getTime()
                  : now - new Date(task.execution.startedAt).getTime(),
              )
            : null;

          return (
            <button
              key={task.id}
              data-testid={`timeline-bar-${task.id}`}
              onClick={() => onTaskClick(task)}
              className={`w-full text-left rounded transition-all ${
                isSelected ? 'ring-2 ring-indigo-400 ring-offset-1 ring-offset-gray-900' : ''
              }`}
              style={{ background: 'transparent' }}
            >
              <div className="flex items-center gap-3 px-2 py-1.5">
                {/* Task label */}
                <div className="w-40 shrink-0 truncate text-xs text-gray-300" title={task.description}>
                  {task.id}
                </div>

                {/* Bar area */}
                <div className="flex-1 h-6 relative bg-gray-800 rounded overflow-hidden">
                  {bar.widthPercent > 0 && (
                    <div
                      className={`absolute top-0 bottom-0 rounded ${
                        task.status === 'running' ? 'animate-pulse' : ''
                      }`}
                      style={{
                        left: `${bar.offsetPercent}%`,
                        width: `${bar.widthPercent}%`,
                        background: colors.bg,
                        minWidth: '4px',
                      }}
                    />
                  )}
                </div>

                {/* Duration label */}
                <div className="w-16 shrink-0 text-right text-xs tabular-nums" style={{ color: colors.bg }}>
                  {elapsed ?? '—'}
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
