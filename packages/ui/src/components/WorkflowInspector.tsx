import { useEffect, useMemo, useState } from 'react';
import type { TaskState, WorkflowMeta, WorkflowRollupTaskIssue } from '../types.js';
import { workflowStatusVisual } from '../lib/workflow-status.js';
import { getEffectiveVisualStatus, getStatusColor } from '../lib/colors.js';

interface WorkflowInspectorProps {
  workflow: WorkflowMeta | null;
  task: TaskState | null;
  workflowTasks?: ReadonlyMap<string, TaskState>;
  remoteTargets?: string[];
  executionAgents: string[];
  collapsed: boolean;
  advancedExpanded: boolean;
  onEditType?: (taskId: string, executorType: string, remoteTargetId?: string) => void;
  onEditAgent?: (taskId: string, agentName: string) => void;
  onEditPrompt?: (taskId: string, newPrompt: string) => void;
  onEditCommand?: (taskId: string, newCommand: string) => void;
  onSetMergeBranch?: (workflowId: string, baseBranch: string) => Promise<void>;
  onToggleCollapsed: () => void;
  onToggleAdvanced: () => void;
}

function summarizePrompt(task: TaskState | null): string {
  if (!task) return 'No task selected.';
  return task.config.prompt ?? task.config.command ?? 'No prompt or command available.';
}

function effectiveExecutorSelectValue(task: TaskState | null): string {
  if (!task) return 'worktree';
  if (task.config.executorType === 'ssh' && task.config.remoteTargetId) {
    return `ssh:${task.config.remoteTargetId}`;
  }
  return task.config.executorType ?? 'worktree';
}

function InspectorToggleIcon({ collapsed }: { collapsed: boolean }): JSX.Element {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.7"
    >
      <path d="M3 3.5h10v9H3z" />
      <path d="M10 3.5v9" />
      {collapsed ? <path d="M5.5 6 7.5 8l-2 2" /> : <path d="M7.5 6 5.5 8l2 2" />}
    </svg>
  );
}

function primaryIssueText(issue: WorkflowRollupTaskIssue): string {
  return issue.error
    ?? issue.protocolErrorMessage
    ?? issue.pendingFixError
    ?? issue.inputPrompt
    ?? issue.reviewUrl
    ?? 'No detail recorded';
}

function formatRepoUrl(url: string): string {
  const sshMatch = url.match(/^git@([^:]+):(.+?)(?:\.git)?$/);
  if (sshMatch) return `${sshMatch[1]}/${sshMatch[2]}`;

  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/^\//, '').replace(/\.git$/, '');
    return `${parsed.host}/${path}`;
  } catch {
    return url;
  }
}

export function WorkflowInspector({
  workflow,
  task,
  workflowTasks,
  remoteTargets,
  executionAgents,
  collapsed,
  advancedExpanded,
  onEditType,
  onEditAgent,
  onEditPrompt,
  onEditCommand,
  onSetMergeBranch,
  onToggleCollapsed,
  onToggleAdvanced,
}: WorkflowInspectorProps): JSX.Element {
  const [promptValue, setPromptValue] = useState('');
  const [promptDirty, setPromptDirty] = useState(false);
  const [editingTaskContent, setEditingTaskContent] = useState(false);
  const [branchValue, setBranchValue] = useState('');

  const promptText = summarizePrompt(task);
  const agent = task?.config.executionAgent ?? task?.execution.agentName ?? '';
  const agentOptions = useMemo(() => {
    const options = new Set(executionAgents);
    if (agent) options.add(agent);
    return [...options].filter(Boolean).sort();
  }, [agent, executionAgents]);

  useEffect(() => {
    setPromptValue(promptText);
    setPromptDirty(false);
    setEditingTaskContent(false);
  }, [task?.id, promptText]);

  useEffect(() => {
    setBranchValue(workflow?.baseBranch ?? '');
  }, [workflow?.baseBranch, workflow?.id]);

  const savePrompt = () => {
    if (!task || !promptDirty) return;
    if (task.config.prompt !== undefined) {
      onEditPrompt?.(task.id, promptValue);
    } else if (task.config.command !== undefined) {
      onEditCommand?.(task.id, promptValue);
    }
    setPromptDirty(false);
  };

  const saveTaskContentEdit = () => {
    if (!task || !showTaskControls) return;
    if (task.config.prompt !== undefined) {
      onEditPrompt?.(task.id, promptValue);
    } else if (task.config.command !== undefined) {
      onEditCommand?.(task.id, promptValue);
    }
    setPromptDirty(false);
    setEditingTaskContent(false);
  };

  if (collapsed) {
    return (
      <aside className="h-full w-full border-l border-gray-800 bg-gray-900 flex items-start justify-center pt-3">
        <button
          onClick={onToggleCollapsed}
          className="inline-flex h-7 w-7 items-center justify-center rounded border border-gray-700 text-gray-300 hover:bg-gray-800 hover:text-white"
          aria-label="Maximize inspector"
          title="Maximize inspector"
        >
          <InspectorToggleIcon collapsed={collapsed} />
        </button>
      </aside>
    );
  }

  const visual = workflow ? workflowStatusVisual(workflow.status) : null;
  const rollup = workflow?.rollup;
  const nonZeroCounts = rollup
    ? Object.entries(rollup.countsByStatus).filter(([, count]) => count > 0)
    : [];
  const workflowTaskList = workflowTasks ? [...workflowTasks.values()] : [];
  const mergeGateReviewUrl = workflowTaskList.find((workflowTask) => workflowTask.config.isMergeNode)?.execution.reviewUrl;
  const fallbackWorkflowReviewUrl = workflowTaskList.find((workflowTask) => workflowTask.execution.reviewUrl)?.execution.reviewUrl;
  const reviewUrl = task ? task.execution.reviewUrl : mergeGateReviewUrl ?? fallbackWorkflowReviewUrl;
  const executorSelectValue = effectiveExecutorSelectValue(task);
  const canEditExecutor = Boolean(task && onEditType && !task.config.isMergeNode);
  const showTaskControls = Boolean(task && !task.config.isMergeNode);
  const canEditPrompt = Boolean(showTaskControls && task && ((task.config.prompt !== undefined && onEditPrompt) || (task.config.command !== undefined && onEditCommand)));
  const showMergeGateMetadata = Boolean(task?.config.isMergeNode);
  const taskVisualStatus = task ? getEffectiveVisualStatus(task.status, task.execution) : null;
  const taskStatusColors = taskVisualStatus ? getStatusColor(taskVisualStatus) : null;
  const failedStatusColors = getStatusColor('failed');
  const fixingStatusColors = getStatusColor('fixing_with_ai');
  const statusBorderClass = taskStatusColors?.border ?? visual?.borderClass ?? 'border-gray-700';
  const statusTextClass = taskStatusColors?.text ?? visual?.textClass ?? 'text-gray-300';
  const statusLabel = task
    ? taskVisualStatus?.replaceAll('_', ' ') ?? task.status.replaceAll('_', ' ')
    : workflow?.status?.replaceAll('_', ' ') ?? 'unknown';
  const workflowTitle = workflow?.name ?? workflow?.id;
  const inspectorTitle = task?.description ?? (workflowTitle ? `${workflowTitle} task DAG` : 'No workflow selected');

  return (
    <aside className="h-full w-full border-l border-gray-800 bg-gray-900 flex flex-col">
      <div className="flex items-center justify-between border-b border-gray-800 px-3 py-2">
        <div className="min-w-0 pr-2">
          <h2 className="text-sm font-semibold leading-snug text-gray-100" data-testid="workflow-inspector-title">
            {inspectorTitle}
          </h2>
        </div>
        <button
          onClick={onToggleCollapsed}
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded border border-gray-700 text-gray-300 hover:bg-gray-800 hover:text-white"
          aria-label="Minimize inspector"
          title="Minimize inspector"
        >
          <InspectorToggleIcon collapsed={collapsed} />
        </button>
      </div>

      <div className="flex-1 overflow-auto p-3 space-y-3 text-sm">
        <section className={`rounded border p-3 ${statusBorderClass} bg-gray-800/70`}>
          <div className="text-[11px] uppercase tracking-wide text-gray-400">
            {task ? 'Task Status' : 'Workflow Status'}
          </div>
          <div
            className={`mt-1 text-xs ${statusTextClass}`}
            data-testid="workflow-inspector-status-label"
          >
            {statusLabel}
          </div>
          {rollup && !task && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {nonZeroCounts.map(([status, count]) => (
                <span
                  key={status}
                  className={`rounded border px-1.5 py-0.5 text-[10px] uppercase ${getStatusColor(status).border} ${getStatusColor(status).bg} ${getStatusColor(status).text}`}
                >
                  {status.replaceAll('_', ' ')} {count}
                </span>
              ))}
            </div>
          )}
          {(task?.execution.error || task?.execution.exitCode !== undefined) && (
            <div className="mt-3 rounded border border-red-500/60 bg-red-950/30 p-2">
              <h3 className="text-[11px] uppercase tracking-wide text-red-300">Error</h3>
              {task.execution.error && (
                <p className="mt-1 whitespace-pre-wrap break-words text-xs text-red-200">{task.execution.error}</p>
              )}
              {task.execution.exitCode !== undefined && (
                <p className="mt-1 text-xs text-red-200">Exit code: {task.execution.exitCode}</p>
              )}
            </div>
          )}
          {!task && rollup?.failedTasks.length ? (
            <div className="mt-3 space-y-2">
              <div className={`text-[11px] uppercase tracking-wide ${failedStatusColors.text}`}>Failed Tasks</div>
              {rollup.failedTasks.map((failedTask) => (
                <div key={failedTask.taskId} className={`rounded border p-2 ${failedStatusColors.border} ${failedStatusColors.bg}`}>
                  <div className={`truncate text-xs font-medium ${failedStatusColors.text}`}>{failedTask.description}</div>
                  <div className={`mt-1 break-words text-[11px] ${failedStatusColors.text}`}>{primaryIssueText(failedTask)}</div>
                </div>
              ))}
            </div>
          ) : null}
          {!task && rollup?.fixingTasks.length ? (
            <div className="mt-3 space-y-2">
              <div className={`text-[11px] uppercase tracking-wide ${fixingStatusColors.text}`}>Fixing with AI</div>
              {rollup.fixingTasks.map((fixingTask) => (
                <div key={fixingTask.taskId} className={`rounded border p-2 ${fixingStatusColors.border} ${fixingStatusColors.bg}`}>
                  <div className={`truncate text-xs font-medium ${fixingStatusColors.text}`}>{fixingTask.description}</div>
                  <div className={`mt-1 text-[11px] ${fixingStatusColors.text}`}>
                    {fixingTask.agentName ?? fixingTask.agentSessionId ?? 'Agent session pending'}
                  </div>
                </div>
              ))}
            </div>
          ) : null}
          {!task && rollup?.waitingTasks.length ? (
            <div className="mt-3 space-y-2">
              <div className="text-[11px] uppercase tracking-wide text-gray-300">Waiting Tasks</div>
              {rollup.waitingTasks.map((waitingTask) => (
                <div key={waitingTask.taskId} className={`rounded border p-2 ${getStatusColor(waitingTask.status).border} ${getStatusColor(waitingTask.status).bg}`}>
                  <div className={`truncate text-xs font-medium ${getStatusColor(waitingTask.status).text}`}>{waitingTask.description}</div>
                  <div className={`mt-1 break-words text-[11px] ${getStatusColor(waitingTask.status).text}`}>
                    {waitingTask.status.replaceAll('_', ' ')} · {primaryIssueText(waitingTask)}
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </section>

        {showTaskControls && task && (
          <section className="rounded border border-gray-700 bg-gray-800/70 p-3">
            <div className="text-[11px] uppercase tracking-wide text-gray-400">AI Agent</div>
            {onEditAgent && agentOptions.length > 0 ? (
              <select
                data-testid="workflow-inspector-agent-select"
                value={agent}
                onChange={(event) => onEditAgent(task.id, event.target.value)}
                className="mt-1 w-full rounded border border-gray-700 bg-gray-900 px-2 py-1.5 text-xs text-gray-100 outline-none focus:border-blue-500"
              >
                {!agent && <option value="">Select agent</option>}
                {agentOptions.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            ) : (
              <div className="mt-1 text-gray-100">{agent || 'n/a'}</div>
            )}
            {canEditExecutor && (
              <>
                <div className="mt-2 text-[11px] uppercase tracking-wide text-gray-400">Run on</div>
                <select
                  data-testid="workflow-inspector-executor-select"
                  value={executorSelectValue}
                  onChange={(event) => {
                    const value = event.target.value;
                    if (value.startsWith('ssh:')) {
                      onEditType?.(task.id, 'ssh', value.slice(4));
                    } else {
                      onEditType?.(task.id, value);
                    }
                  }}
                  disabled={task.status === 'running' || task.status === 'fixing_with_ai'}
                  className="mt-1 w-full rounded border border-gray-700 bg-gray-900 px-2 py-1.5 text-xs text-gray-100 outline-none focus:border-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <option value="worktree">Worktree</option>
                  <option value="docker">Docker</option>
                  {remoteTargets?.map((targetId) => (
                    <option key={targetId} value={`ssh:${targetId}`}>
                      SSH: {targetId}
                    </option>
                  ))}
                </select>
              </>
            )}
            <div className="mt-2 text-[11px] uppercase tracking-wide text-gray-400">Prompt</div>
            {editingTaskContent ? (
              <div className="mt-1 space-y-2">
                <textarea
                  data-testid={task.config.prompt !== undefined ? 'edit-prompt-input' : 'edit-command-input'}
                  value={promptValue}
                  onChange={(event) => {
                    setPromptValue(event.target.value);
                    setPromptDirty(event.target.value !== promptText);
                  }}
                  onKeyDown={(event) => {
                    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                      event.preventDefault();
                      saveTaskContentEdit();
                    }
                    if (event.key === 'Escape') {
                      setPromptValue(promptText);
                      setPromptDirty(false);
                      setEditingTaskContent(false);
                    }
                  }}
                  className="min-h-28 w-full resize-y rounded border border-blue-500 bg-gray-900 px-2 py-2 text-xs leading-relaxed text-gray-100 outline-none focus:border-blue-400"
                />
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setPromptValue(promptText);
                      setPromptDirty(false);
                      setEditingTaskContent(false);
                    }}
                    className="rounded border border-gray-700 px-2 py-1 text-xs text-gray-300 hover:bg-gray-800"
                    data-testid="cancel-edit-btn"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={saveTaskContentEdit}
                    className="rounded bg-blue-600 px-2 py-1 text-xs font-medium text-white hover:bg-blue-500"
                    data-testid={task.config.prompt !== undefined ? 'save-prompt-btn' : 'save-command-btn'}
                  >
                    Save & Re-run
                  </button>
                </div>
              </div>
            ) : (
              <div
                data-testid="command-display"
                onDoubleClick={() => {
                  if (canEditPrompt) setEditingTaskContent(true);
                }}
                className="mt-1"
              >
                <textarea
                  data-testid="workflow-inspector-prompt-input"
                  value={promptValue}
                  onChange={(event) => {
                    setPromptValue(event.target.value);
                    setPromptDirty(event.target.value !== promptText);
                  }}
                  onBlur={savePrompt}
                  onKeyDown={(event) => {
                    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                      event.preventDefault();
                      savePrompt();
                    }
                    if (event.key === 'Escape') {
                      setPromptValue(promptText);
                      setPromptDirty(false);
                      event.currentTarget.blur();
                    }
                  }}
                  readOnly={!canEditPrompt}
                  className={`min-h-28 w-full resize-y rounded border px-2 py-2 text-xs leading-relaxed outline-none ${
                    canEditPrompt
                      ? 'border-gray-700 bg-gray-900 text-gray-100 focus:border-blue-500'
                      : 'border-gray-700 bg-gray-900/50 text-gray-400'
                  }`}
                />
              </div>
            )}
            {!editingTaskContent && promptDirty && canEditPrompt && (
              <div className="mt-2 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setPromptValue(promptText);
                    setPromptDirty(false);
                  }}
                  className="rounded border border-gray-700 px-2 py-1 text-xs text-gray-300 hover:bg-gray-800"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={savePrompt}
                  className="rounded bg-blue-600 px-2 py-1 text-xs font-medium text-white hover:bg-blue-500"
                >
                  Save
                </button>
              </div>
            )}
          </section>
        )}

        {showMergeGateMetadata && task && (
          <section className="rounded border border-gray-700 bg-gray-800/70 p-3 space-y-3">
            {onSetMergeBranch && task.config.workflowId && (
              <div className="flex items-center justify-between gap-3">
                <span className="text-[11px] uppercase tracking-wide text-gray-400">Target Branch</span>
                <input
                  data-testid="target-branch-input"
                  value={branchValue}
                  onChange={(event) => setBranchValue(event.target.value)}
                  onBlur={() => {
                    const trimmed = branchValue.trim();
                    if (trimmed && trimmed !== workflow?.baseBranch) {
                      onSetMergeBranch(task.config.workflowId!, trimmed);
                    }
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.currentTarget.blur();
                    }
                    if (event.key === 'Escape') {
                      setBranchValue(workflow?.baseBranch ?? '');
                    }
                  }}
                  className="w-32 rounded border border-gray-700 bg-gray-900 px-2 py-1 text-right font-mono text-xs text-gray-100 outline-none focus:border-blue-500"
                />
              </div>
            )}
            {task.execution.reviewStatus && (
              <div className="flex items-center justify-between gap-3">
                <span className="text-[11px] uppercase tracking-wide text-gray-400">Review Status</span>
                <span className="text-xs text-gray-200" data-testid="pr-status-text">
                  {task.execution.reviewStatus}
                </span>
              </div>
            )}
            {!task.execution.reviewUrl && workflow?.repoUrl && (
              <div className="flex items-center justify-between gap-3" data-testid="pr-target-repo">
                <span className="text-[11px] uppercase tracking-wide text-gray-400">PR target repo</span>
                <span className="max-w-[220px] break-all text-right font-mono text-xs text-gray-200" title={workflow.repoUrl}>
                  {formatRepoUrl(workflow.repoUrl)}
                </span>
              </div>
            )}
          </section>
        )}

        <section className="rounded border border-gray-700 bg-gray-800/70 p-3">
          <div className="text-[11px] uppercase tracking-wide text-gray-400">Pull Request</div>
          {reviewUrl ? (
            <a
              href={reviewUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-1 block text-xs text-blue-300 underline break-all"
            >
              {reviewUrl}
            </a>
          ) : (
            <div className="mt-1 text-xs text-gray-400">No PR linked</div>
          )}
        </section>

        <section className="rounded border border-gray-700 bg-gray-800/70">
          <button
            onClick={onToggleAdvanced}
            className="w-full px-3 py-2 text-left text-[11px] uppercase tracking-wide text-gray-300 hover:bg-gray-800"
          >
            Advanced metadata {advancedExpanded ? '▲' : '▼'}
          </button>
          {advancedExpanded && (
            <div className="border-t border-gray-700 px-3 py-2 space-y-1 text-xs text-gray-300">
              <div>workflow id: {workflow?.id ?? 'n/a'}</div>
              <div>task id: {task?.id ?? 'n/a'}</div>
              <div>target branch: {workflow?.featureBranch ?? task?.config.featureBranch ?? 'n/a'}</div>
              <div>base branch: {workflow?.baseBranch ?? 'n/a'}</div>
              <div>heartbeat: {String(task?.execution.lastHeartbeatAt ?? 'n/a')}</div>
            </div>
          )}
        </section>
      </div>
    </aside>
  );
}
