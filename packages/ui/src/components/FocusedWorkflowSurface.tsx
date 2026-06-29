import type { MouseEvent } from 'react';
import type { TaskState, WorkflowMeta, WorkflowStatus } from '../types.js';
import type { GraphCameraCommand } from '../lib/graph-camera.js';
import { workflowStatusVisual } from '../lib/workflow-status.js';
import { formatStatusLabel } from '../lib/colors.js';
import { TaskDAG } from './TaskDAG.js';
import { CollapsibleGuideButton } from './CollapsibleGuideButton.js';

interface FocusedWorkflowSurfaceProps {
  workflow: WorkflowMeta;
  tasks: Map<string, TaskState>;
  workflows: Map<string, WorkflowMeta>;
  selectedTaskId: string | null;
  cameraCommand?: GraphCameraCommand | null;
  runningTaskIds: ReadonlySet<string>;
  isRefreshing?: boolean;
  onBackToRuns: () => void;
  onTaskClick: (task: TaskState) => void;
  onTaskDoubleClick: (task: TaskState) => void;
  onTaskContextMenu: (task: TaskState, event: MouseEvent) => void;
  onManualViewport: () => void;
}

const ATTENTION_STATUSES: ReadonlySet<WorkflowStatus | TaskState['status']> = new Set([
  'awaiting_approval',
  'blocked',
  'failed',
  'needs_input',
  'review_ready',
]);
const FOCUSED_RUN_GUIDE_ITEMS = [
  'Use All runs to return to the workflow map.',
  'Select a task in the local graph to inspect gates, logs, and available actions.',
  'Use task terminals when you need the live output behind a node.',
];
const EMPTY_STATUS_FILTERS = new Set<TaskState['status']>();

function workflowStatusLabel(status: WorkflowStatus): string {
  return status.replaceAll('_', ' ');
}

function countTasksByStatus(tasks: Iterable<TaskState>): Map<TaskState['status'], number> {
  const counts = new Map<TaskState['status'], number>();
  for (const task of tasks) {
    counts.set(task.status, (counts.get(task.status) ?? 0) + 1);
  }
  return counts;
}

function taskStatusCountLabel(status: TaskState['status'], count: number): string {
  const label = formatStatusLabel(status).toLowerCase();
  return `${count} ${label}`;
}

function summarizeProgress(tasks: TaskState[]): string {
  if (tasks.length === 0) return 'No tasks yet';
  const completed = tasks.filter((task) => task.status === 'completed' || task.status === 'closed').length;
  return `${completed}/${tasks.length} tasks complete`;
}

export function FocusedWorkflowSurface({
  workflow,
  tasks,
  workflows,
  selectedTaskId,
  cameraCommand,
  runningTaskIds,
  isRefreshing = false,
  onBackToRuns,
  onTaskClick,
  onTaskDoubleClick,
  onTaskContextMenu,
  onManualViewport,
}: FocusedWorkflowSurfaceProps): JSX.Element {
  const workflowTasks = [...tasks.values()];
  const counts = countTasksByStatus(workflowTasks);
  const attentionTasks = workflowTasks.filter((task) => ATTENTION_STATUSES.has(task.status));
  const needsAttention = attentionTasks.slice(0, 4);
  const runningCount = counts.get('running') ?? 0;
  const completedCount = (counts.get('completed') ?? 0) + (counts.get('closed') ?? 0);
  const visual = workflowStatusVisual(workflow.status);
  const statusCards = [
    { label: 'Progress', value: summarizeProgress(workflowTasks), tone: 'text-slate-100' },
    { label: 'Running', value: String(runningCount), tone: runningCount > 0 ? 'text-blue-200' : 'text-slate-400' },
    { label: 'Done', value: String(completedCount), tone: completedCount > 0 ? 'text-emerald-200' : 'text-slate-400' },
    { label: 'Needs attention', value: String(attentionTasks.length), tone: attentionTasks.length > 0 ? 'text-amber-200' : 'text-slate-400' },
  ];

  return (
    <div
      data-testid="focused-workflow-surface"
      onClick={(event) => event.stopPropagation()}
      className="h-full w-full overflow-auto bg-[radial-gradient(circle_at_50%_0%,rgba(59,130,246,0.12),rgba(15,23,42,0)_36%),linear-gradient(135deg,#030712_0%,#07111f_58%,#050712_100%)] px-4 py-4 text-slate-200"
    >
      <div className="mx-auto flex min-h-full w-full max-w-7xl flex-col gap-3">
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-800 pb-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2 text-xs uppercase tracking-wide text-slate-500">
              <span>Focused run</span>
              <span className={`rounded border px-2 py-0.5 text-[10px] ${visual.borderClass} ${visual.textClass}`}>
                {workflowStatusLabel(workflow.status)}
              </span>
              {isRefreshing && (
                <span data-testid="focused-workflow-refreshing" className="text-amber-200">
                  Refreshing graph
                </span>
              )}
            </div>
            <h1 className="mt-1 truncate text-2xl font-semibold text-white">
              {workflow.name || workflow.id}
            </h1>
            <div className="mt-1 truncate text-xs text-slate-500">
              {workflow.id}
              {workflow.baseBranch ? ` -> ${workflow.baseBranch}` : ''}
            </div>
          </div>
          <button
            type="button"
            onClick={onBackToRuns}
            data-testid="focused-workflow-back"
            className="rounded-md border border-slate-700 bg-slate-950/80 px-3 py-2 text-xs font-medium text-slate-200 hover:border-slate-500 hover:bg-slate-900"
          >
            All runs
          </button>
        </header>

        <section
          data-testid="focused-workflow-terminal"
          className="rounded-md border border-slate-700/70 bg-slate-950/75 shadow-2xl shadow-black/25"
        >
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 px-4 py-3">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-200">
              <span>Invoker terminal</span>
              <span className="rounded border border-blue-400/40 bg-blue-500/10 px-1.5 py-0.5 text-[10px] text-blue-200">
                Beta
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
              <span className={`rounded border px-2 py-1 ${visual.borderClass} ${visual.textClass}`}>
                {workflowStatusLabel(workflow.status)}
              </span>
              <span className="rounded border border-slate-700 px-2 py-1">
                Run selected
              </span>
            </div>
          </div>
          <div className="p-4">
            <div className="rounded-md border border-blue-400/60 bg-slate-950 px-4 py-3 font-mono text-sm shadow-[0_0_28px_rgba(37,99,235,0.18)]">
              <div className="text-emerald-300">invoker&gt; inspect run "{workflow.name || workflow.id}"</div>
              {selectedTaskId ? (
                <div className="mt-2 text-blue-200">invoker&gt; inspect task "{selectedTaskId}"</div>
              ) : null}
              <div className="mt-3 text-slate-400">
                {workflowTasks.length > 0
                  ? `${workflowTasks.length} tasks loaded. Select a node to inspect logs, gates, checks, and available actions.`
                  : 'Waiting for tasks to appear for this run.'}
              </div>
            </div>
          </div>
        </section>

        {needsAttention.length > 0 && (
          <section
            data-testid="focused-workflow-attention-strip"
            className="rounded-md border border-amber-400/30 bg-amber-500/10 px-4 py-3"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-xs font-semibold uppercase tracking-wide text-amber-100">
                  Needs attention
                </div>
                <div className="mt-1 text-xs text-amber-200/80">
                  {attentionTasks.length} task{attentionTasks.length === 1 ? '' : 's'} waiting on action.
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                {needsAttention.map((task) => (
                  <button
                    key={task.id}
                    type="button"
                    onClick={() => onTaskClick(task)}
                    className="max-w-[220px] rounded-md border border-amber-400/30 bg-slate-950/70 px-3 py-2 text-left hover:border-amber-300/70"
                  >
                    <div className="truncate text-xs font-medium text-amber-100">{task.description || task.id}</div>
                    <div className="mt-1 text-[11px] text-amber-200/80">
                      {formatStatusLabel(task.status)}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          </section>
        )}

        <section
          data-testid="focused-workflow-graph-section"
          className="min-h-[460px] rounded-md border border-slate-700/70 bg-slate-950/65 p-3 shadow-2xl shadow-black/20"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-300">
                Execution graph
              </div>
              <div className="mt-1 text-xs text-slate-500">
                Dependencies for the selected run stay visible while you inspect tasks.
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              {statusCards.map((card) => (
                <div key={card.label} className="rounded border border-slate-800 bg-slate-900/70 px-3 py-2">
                  <div className="text-[10px] uppercase tracking-wide text-slate-500">{card.label}</div>
                  <div className={`mt-1 text-xs font-medium ${card.tone}`}>{card.value}</div>
                </div>
              ))}
            </div>
          </div>
          <div
            data-testid="focused-workflow-task-dag"
            tabIndex={0}
            className="mt-3 h-[390px] rounded-md border border-slate-800 bg-slate-950 outline-none focus:ring-2 focus:ring-blue-300/60"
          >
            {isRefreshing && (
              <div data-testid="focused-workflow-task-dag-refreshing" className="px-2 py-1 text-xs text-amber-200">
                Refreshing graph...
              </div>
            )}
            <TaskDAG
              tasks={tasks}
              workflows={workflows}
              selectedTaskId={selectedTaskId}
              cameraCommand={cameraCommand}
              onTaskClick={onTaskClick}
              onTaskDoubleClick={onTaskDoubleClick}
              onTaskContextMenu={onTaskContextMenu}
              onManualViewport={onManualViewport}
              statusFilters={EMPTY_STATUS_FILTERS}
              runningTaskIds={runningTaskIds}
            />
          </div>
        </section>

        <section className="rounded-md border border-slate-700/70 bg-slate-950/65 p-4 shadow-2xl shadow-black/20">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-300">
                Task terminals
              </div>
              <div className="mt-1 text-xs text-slate-500">
                Double-click a task node to open its attached terminal. Live sessions stay in the drawer below.
              </div>
            </div>
            <div className="rounded border border-slate-800 bg-slate-900/70 px-3 py-2 text-xs text-slate-400">
              {taskStatusCountLabel('running', runningCount)}
            </div>
          </div>
        </section>
      </div>
      <CollapsibleGuideButton title="Run guide" items={FOCUSED_RUN_GUIDE_ITEMS} />
    </div>
  );
}
