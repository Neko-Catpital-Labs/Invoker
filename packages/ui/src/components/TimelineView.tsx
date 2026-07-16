/**
 * TimelineView — worker-history timeline plus task execution Gantt.
 *
 * Workers mode is the default surface. Tasks mode keeps the existing
 * task-duration view intact for execution debugging.
 */

import { useState } from 'react';
import type { TaskState, WorkflowMeta } from '../types.js';
import { useNow } from '../hooks/useNow.js';
import {
  getStatusInlineColors,
  getEffectiveVisualStatus,
  getRunningPhaseLabel,
} from '../lib/colors.js';
import { WorkerActionTimelinePane } from './WorkerActionTimelinePane.js';

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
    review_ready: 2,
    awaiting_approval: 2,
    failed: 3,
    closed: 4,
    completed: 5,
    pending: 6,
    blocked: 7,
    stale: 8,
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

type TimelineMode = 'workers' | 'tasks';

interface TimelineViewProps {
  tasks: Map<string, TaskState>;
  workflows: Map<string, WorkflowMeta>;
  selectedWorkflowId: string | null;
  onTaskClick: (task: TaskState) => void;
  selectedTaskId: string | null;
}

function TaskTimelinePane({
  tasks,
  onTaskClick,
  selectedTaskId,
}: Pick<TimelineViewProps, 'tasks' | 'onTaskClick' | 'selectedTaskId'>) {
  const hasRunning = Array.from(tasks.values()).some((task) => task.status === 'running');
  const now = useNow(1000, hasRunning);
  const taskList = sortTasksForTimeline(Array.from(tasks.values()));
  const bars = computeBarWidths(taskList, now);
  const barMap = new Map(bars.map((bar) => [bar.taskId, bar]));

  if (taskList.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        No tasks to display
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto p-4" data-testid="task-timeline-view">
      <div className="space-y-1">
        {taskList.map((task) => {
          const bar = barMap.get(task.id)!;
          const colors = getStatusInlineColors(getEffectiveVisualStatus(task.status, task.execution));
          const isSelected = selectedTaskId === task.id;
          const elapsed = task.execution.startedAt
            ? formatElapsed(
                task.execution.completedAt
                  ? new Date(task.execution.completedAt).getTime() - new Date(task.execution.startedAt).getTime()
                  : now - new Date(task.execution.startedAt).getTime(),
              )
            : null;
          const phaseLabel = task.status === 'running'
            ? getRunningPhaseLabel(task.execution.phase)
            : null;

          return (
            <div
              key={task.id}
              role="button"
              tabIndex={0}
              data-testid={`timeline-bar-${task.id}`}
              onClick={() => onTaskClick(task)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  if (event.key === ' ') event.preventDefault();
                  onTaskClick(task);
                }
              }}
              className={`w-full rounded text-left transition-all ${
                isSelected ? 'ring-2 ring-indigo-400 ring-offset-1 ring-offset-gray-900' : ''
              }`}
              style={{ background: 'transparent' }}
            >
              <div className="flex items-center gap-3 px-2 py-1.5">
                <div className="w-40 shrink-0 truncate text-xs text-muted-foreground select-text cursor-text" title={task.description}>
                  {task.id}
                </div>
                {phaseLabel ? (
                  <div className="w-20 shrink-0 text-xs uppercase text-amber-300 select-text cursor-text">
                    {phaseLabel}
                  </div>
                ) : null}
                <div className="relative h-6 flex-1 overflow-hidden rounded bg-secondary">
                  {bar.widthPercent > 0 ? (
                    <div
                      className={`absolute bottom-0 top-0 rounded ${task.status === 'running' ? 'animate-pulse' : ''}`}
                      style={{
                        left: `${bar.offsetPercent}%`,
                        width: `${bar.widthPercent}%`,
                        background: colors.bg,
                        minWidth: '4px',
                      }}
                    />
                  ) : null}
                </div>
                <div className="w-16 shrink-0 text-right text-xs tabular-nums select-text cursor-text" style={{ color: colors.bg }}>
                  {elapsed ?? '—'}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function TimelineView({
  tasks,
  workflows,
  selectedWorkflowId,
  onTaskClick,
  selectedTaskId,
}: TimelineViewProps) {
  const [mode, setMode] = useState<TimelineMode>('workers');

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="timeline-view">
      <div className="border-b border-gray-800 bg-gray-900/40 px-4 py-3">
        <div className="inline-flex overflow-hidden rounded-sm border border-border" role="group" aria-label="Timeline mode">
          <button
            type="button"
            data-testid="timeline-mode-workers"
            aria-pressed={mode === 'workers'}
            onClick={() => setMode('workers')}
            className={`px-3 py-1.5 text-sm ${mode === 'workers' ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-secondary'}`}
          >
            Workers
          </button>
          <button
            type="button"
            data-testid="timeline-mode-tasks"
            aria-pressed={mode === 'tasks'}
            onClick={() => setMode('tasks')}
            className={`px-3 py-1.5 text-sm ${mode === 'tasks' ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-secondary'}`}
          >
            Tasks
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1">
        {mode === 'workers' ? (
          <WorkerActionTimelinePane
            tasks={tasks}
            workflows={workflows}
            selectedTaskId={selectedTaskId}
            selectedWorkflowId={selectedWorkflowId}
            onTaskClick={onTaskClick}
          />
        ) : (
          <TaskTimelinePane
            tasks={tasks}
            onTaskClick={onTaskClick}
            selectedTaskId={selectedTaskId}
          />
        )}
      </div>
    </div>
  );
}
