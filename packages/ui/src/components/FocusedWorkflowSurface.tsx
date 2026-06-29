import { useState, type MouseEvent } from 'react';
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
  onApprove: (task: TaskState) => void;
  onReject: (task: TaskState) => void;
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
const TASK_DETAIL_TABS = ['Details', 'Logs', 'Changes', 'Artifacts'] as const;
type TaskDetailTab = typeof TASK_DETAIL_TABS[number];

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

function taskAttentionLabel(task: TaskState): string {
  if (task.execution.pendingFixError) return 'Fix approval required';
  if (task.status === 'awaiting_approval') return task.config.isMergeNode ? 'Merge approval required' : 'Approval required';
  if (task.status === 'review_ready') return task.config.isMergeNode ? 'Ready to merge' : 'Review ready';
  if (task.status === 'failed') return 'Failed';
  if (task.status === 'blocked') return 'Blocked';
  if (task.status === 'needs_input') return 'Input needed';
  return formatStatusLabel(task.status);
}

function taskSummary(task: TaskState): string {
  if (task.execution.pendingFixError) return task.execution.pendingFixError;
  if (task.execution.error) return task.execution.error;
  if (task.config.summary) return task.config.summary;
  if (task.config.problem) return task.config.problem;
  if (task.config.command) return task.config.command;
  if (task.config.prompt) return task.config.prompt;
  return 'Select actions below or open the task terminal for live output.';
}

function taskKindLabel(task: TaskState): string {
  if (task.config.isMergeNode) return 'Merge gate';
  if (task.config.requiresManualApproval) return 'Manual gate';
  if (task.config.command) return 'Command task';
  if (task.config.prompt) return 'Agent task';
  return 'Task';
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
  onApprove,
  onReject,
}: FocusedWorkflowSurfaceProps): JSX.Element {
  const [activeDetailTab, setActiveDetailTab] = useState<TaskDetailTab>('Details');
  const workflowTasks = [...tasks.values()];
  const counts = countTasksByStatus(workflowTasks);
  const attentionTasks = workflowTasks.filter((task) => ATTENTION_STATUSES.has(task.status));
  const needsAttention = attentionTasks.slice(0, 4);
  const selectedTask = selectedTaskId ? tasks.get(selectedTaskId) ?? null : null;
  const selectedTaskPosition = selectedTask
    ? workflowTasks.findIndex((task) => task.id === selectedTask.id)
    : -1;
  const selectedTaskIndex = selectedTaskPosition >= 0 ? selectedTaskPosition + 1 : null;
  const canApproveSelectedTask = Boolean(
    selectedTask
    && (selectedTask.status === 'awaiting_approval' || selectedTask.status === 'review_ready')
  );
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

        <div className="grid flex-1 gap-3 lg:grid-cols-[minmax(0,1fr)_320px]">
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
            {selectedTask ? (
              <div data-testid="focused-task-detail">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-xs font-semibold uppercase tracking-wide text-slate-300">
                      Selected task
                    </div>
                    <h2 className="mt-2 truncate text-base font-semibold text-white">
                      {selectedTask.description || selectedTask.id}
                    </h2>
                  </div>
                  <span className="rounded border border-blue-400/40 bg-blue-500/10 px-2 py-1 text-[10px] font-semibold uppercase text-blue-100">
                    {taskKindLabel(selectedTask)}
                  </span>
                </div>

                <div className="mt-3 rounded-md border border-slate-800 bg-slate-900/70 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-[11px] uppercase tracking-wide text-slate-500">
                      Status
                    </span>
                    <span className={`rounded border px-2 py-1 text-[10px] font-semibold uppercase ${
                      canApproveSelectedTask
                        ? 'border-amber-300/50 bg-amber-400/10 text-amber-100'
                        : selectedTask.status === 'completed' || selectedTask.status === 'closed'
                          ? 'border-emerald-300/50 bg-emerald-400/10 text-emerald-100'
                          : selectedTask.status === 'failed'
                            ? 'border-red-300/50 bg-red-400/10 text-red-100'
                            : 'border-slate-700 bg-slate-950/70 text-slate-200'
                    }`}>
                      {taskAttentionLabel(selectedTask)}
                    </span>
                  </div>
                  <p className="mt-3 max-h-24 overflow-auto whitespace-pre-wrap text-xs leading-5 text-slate-300">
                    {taskSummary(selectedTask)}
                  </p>
                </div>

                <div className="mt-3 grid grid-cols-4 rounded-md border border-slate-800 bg-slate-900/60 p-1" role="tablist" aria-label="Selected task detail">
                  {TASK_DETAIL_TABS.map((tab) => (
                    <button
                      key={tab}
                      type="button"
                      role="tab"
                      aria-selected={activeDetailTab === tab}
                      data-testid={`focused-task-tab-${tab.toLowerCase()}`}
                      onClick={() => setActiveDetailTab(tab)}
                      className={`rounded px-2 py-1.5 text-[11px] font-medium ${
                        activeDetailTab === tab
                          ? 'bg-slate-100 text-slate-950'
                          : 'text-slate-400 hover:bg-slate-800 hover:text-slate-100'
                      }`}
                    >
                      {tab}
                    </button>
                  ))}
                </div>

                <div className="mt-3 min-h-[120px] rounded-md border border-slate-800 bg-slate-900/50 p-3 text-xs leading-5 text-slate-300">
                  {activeDetailTab === 'Details' && (
                    <dl className="space-y-2">
                      <div className="flex justify-between gap-3">
                        <dt className="text-slate-500">Task</dt>
                        <dd className="min-w-0 truncate text-right text-slate-200">
                          {selectedTaskIndex ? `${selectedTaskIndex}/${workflowTasks.length}` : selectedTask.id}
                        </dd>
                      </div>
                      <div className="flex justify-between gap-3">
                        <dt className="text-slate-500">Branch</dt>
                        <dd className="min-w-0 truncate text-right text-slate-200">
                          {selectedTask.execution.branch ?? selectedTask.config.featureBranch ?? 'Not created yet'}
                        </dd>
                      </div>
                      <div className="flex justify-between gap-3">
                        <dt className="text-slate-500">Agent</dt>
                        <dd className="min-w-0 truncate text-right text-slate-200">
                          {selectedTask.execution.agentName ?? selectedTask.config.executionAgent ?? 'Default'}
                        </dd>
                      </div>
                      <div className="flex justify-between gap-3">
                        <dt className="text-slate-500">Dependencies</dt>
                        <dd className="text-right text-slate-200">{selectedTask.dependencies.length}</dd>
                      </div>
                    </dl>
                  )}
                  {activeDetailTab === 'Logs' && (
                    <div>
                      <p>Open the task terminal for live logs and command output.</p>
                      <button
                        type="button"
                        onClick={() => onTaskDoubleClick(selectedTask)}
                        className="mt-3 w-full rounded border border-blue-400/50 bg-blue-500/10 px-3 py-2 text-xs font-medium text-blue-100 hover:bg-blue-500/20"
                      >
                        Open terminal
                      </button>
                    </div>
                  )}
                  {activeDetailTab === 'Changes' && (
                    <div>
                      {selectedTask.execution.reviewUrl ? (
                        <a
                          href={selectedTask.execution.reviewUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="text-blue-200 underline underline-offset-2"
                        >
                          Open review
                        </a>
                      ) : (
                        <p>No review artifact is attached to this task yet.</p>
                      )}
                      {selectedTask.execution.commit && (
                        <p className="mt-2 break-all text-slate-500">Commit: {selectedTask.execution.commit}</p>
                      )}
                    </div>
                  )}
                  {activeDetailTab === 'Artifacts' && (
                    <dl className="space-y-2">
                      <div className="flex justify-between gap-3">
                        <dt className="text-slate-500">Review status</dt>
                        <dd className="min-w-0 truncate text-right text-slate-200">
                          {selectedTask.execution.reviewStatus ?? 'None'}
                        </dd>
                      </div>
                      <div className="flex justify-between gap-3">
                        <dt className="text-slate-500">Workspace</dt>
                        <dd className="min-w-0 truncate text-right text-slate-200">
                          {selectedTask.execution.workspacePath ?? 'Not assigned'}
                        </dd>
                      </div>
                    </dl>
                  )}
                </div>

                {canApproveSelectedTask && (
                  <div className="mt-3 grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => onApprove(selectedTask)}
                      data-testid="focused-task-approve-button"
                      className="rounded border border-emerald-300/50 bg-emerald-500/10 px-3 py-2 text-xs font-semibold text-emerald-100 hover:bg-emerald-500/20"
                    >
                      {selectedTask.execution.pendingFixError ? 'Approve fix' : selectedTask.config.isMergeNode ? 'Approve merge' : 'Approve'}
                    </button>
                    <button
                      type="button"
                      onClick={() => onReject(selectedTask)}
                      data-testid="focused-task-reject-button"
                      className="rounded border border-red-300/50 bg-red-500/10 px-3 py-2 text-xs font-semibold text-red-100 hover:bg-red-500/20"
                    >
                      {selectedTask.execution.pendingFixError ? 'Reject fix' : selectedTask.config.isMergeNode ? 'Reject merge' : 'Reject'}
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <div>
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
                          {taskAttentionLabel(task)}
                        </div>
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="mt-3 rounded-md border border-slate-800 bg-slate-900/70 p-3 text-sm text-slate-400">
                    Nothing needs attention right now.
                  </div>
                )}
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
