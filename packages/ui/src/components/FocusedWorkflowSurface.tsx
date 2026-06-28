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
      className="h-full w-full overflow-auto bg-[radial-gradient(circle_at_50%_0%,rgba(59,130,246,0.14),rgba(15,23,42,0)_34%),linear-gradient(135deg,#030712_0%,#08111f_58%,#050712_100%)] px-4 py-4 text-slate-200"
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

        <section className="rounded-md border border-slate-700/70 bg-slate-950/75 p-4 shadow-2xl shadow-black/25">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-xs font-semibold uppercase tracking-wide text-blue-200">
              Invoker terminal
            </div>
            <div className="rounded border border-slate-700 px-2 py-1 text-[11px] text-slate-500">
              Local graph selected
            </div>
          </div>
          <div className="mt-3 rounded-md border border-blue-400/60 bg-slate-950 px-4 py-3 font-mono text-sm shadow-[0_0_28px_rgba(37,99,235,0.18)]">
            <div className="text-emerald-300">invoker&gt; inspect run "{workflow.name || workflow.id}"</div>
            <div className="mt-2 text-slate-400">
              {workflowTasks.length > 0
                ? `${workflowTasks.length} tasks loaded. Select a node to inspect logs, gates, checks, and available actions.`
                : 'Waiting for tasks to appear for this run.'}
            </div>
          </div>
        </section>

        <div className="grid flex-1 gap-3 xl:grid-cols-[minmax(0,1fr)_320px]">
          <section className="min-h-[460px] rounded-md border border-slate-700/70 bg-slate-950/65 p-3 shadow-2xl shadow-black/20">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-300">
                  Local task graph
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
              className="h-[390px] rounded-md border border-slate-800 bg-slate-950 outline-none focus:ring-2 focus:ring-blue-300/60"
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
                statusFilters={new Set()}
                runningTaskIds={runningTaskIds}
                nodeIdPrefix="focused:"
              />
            </div>
          </section>

          <aside className="rounded-md border border-slate-700/70 bg-slate-950/65 p-4 shadow-2xl shadow-black/20">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-300">
              Needs attention
            </div>
            {needsAttention.length > 0 ? (
              <div className="mt-3 space-y-2">
                {needsAttention.map((task) => (
                  <button
                    key={task.id}
                    type="button"
                    onClick={() => onTaskClick(task)}
                    className="w-full rounded-md border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-left hover:border-amber-300/60"
                  >
                    <div className="truncate text-sm font-medium text-amber-100">{task.description || task.id}</div>
                    <div className="mt-1 text-xs text-amber-200/80">
                      {formatStatusLabel(task.status)}
                    </div>
                  </button>
                ))}
              </div>
            ) : (
              <div className="mt-3 rounded-md border border-slate-800 bg-slate-900/70 p-3 text-sm text-slate-400">
                Nothing needs attention right now.
              </div>
            )}

            <div className="mt-4 text-xs font-semibold uppercase tracking-wide text-slate-300">
              Run summary
            </div>
            <dl className="mt-3 space-y-2 text-xs">
              {[...counts.entries()].map(([status, count]) => (
                <div key={status} className="flex justify-between gap-3">
                  <dt className="text-slate-500">{formatStatusLabel(status)}</dt>
                  <dd className="font-medium text-slate-200">{count}</dd>
                </div>
              ))}
              {workflow.repoUrl && (
                <div className="border-t border-slate-800 pt-2">
                  <dt className="text-slate-500">Repo</dt>
                  <dd className="mt-1 break-all text-slate-300">{workflow.repoUrl.replace(/^https?:\/\//, '')}</dd>
                </div>
              )}
            </dl>
          </aside>
        </div>

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
