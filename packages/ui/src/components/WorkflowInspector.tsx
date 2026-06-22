import { useEffect, useMemo, useState } from 'react';
import type { TaskState, WorkflowMeta } from '../types.js';
import { getEffectiveVisualStatus, getStatusColor } from '../lib/colors.js';
import { workflowStatusVisual } from '../lib/workflow-status.js';
import type { ActionGraphNode } from '@invoker/contracts';

type MergeMode = 'manual' | 'automatic' | 'external_review';

interface WorkflowInspectorProps {
  workflow: WorkflowMeta | null;
  task: TaskState | null;
  workflowTasks?: Map<string, TaskState>;
  remoteTargets?: string[];
  executionPools?: string[];
  executionAgents?: string[];
  actionNode?: ActionGraphNode | null;
  collapsed: boolean;
  advancedExpanded: boolean;
  onEditType?: (taskId: string, runnerKind: string, poolMemberId?: string) => void;
  onEditPool?: (taskId: string, poolId: string) => void;
  onEditAgent?: (taskId: string, agentName: string) => void;
  onEditPrompt?: (taskId: string, newPrompt: string) => void;
  onEditCommand?: (taskId: string, newCommand: string) => void;
  onApprove?: (task: TaskState) => void;
  onReject?: (task: TaskState) => void;
  onSetMergeBranch?: (workflowId: string, baseBranch: string) => Promise<void>;
  onSetMergeMode?: (workflowId: string, mergeMode: MergeMode) => Promise<void>;
  onToggleCollapsed: () => void;
  onToggleAdvanced: () => void;
}

function formatStatus(value: string | undefined): string {
  return value?.replaceAll('_', ' ') ?? 'unknown';
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function mergeModeValue(value: string | undefined): MergeMode {
  return value === 'automatic' || value === 'external_review' ? value : 'manual';
}

function getReviewReadyMergeNodeReviewUrl(
  tasks: Map<string, TaskState> | undefined,
): string | undefined {
  if (!tasks) return undefined;
  for (const candidate of tasks.values()) {
    if (
      candidate.config.isMergeNode &&
      candidate.status === 'review_ready' &&
      candidate.execution.reviewUrl
    ) {
      return candidate.execution.reviewUrl;
    }
  }
  return undefined;
}

export function WorkflowInspector({
  workflow,
  task,
  workflowTasks,
  executionPools,
  executionAgents,
  actionNode,
  collapsed,
  advancedExpanded,
  onEditPool,
  onEditAgent,
  onEditPrompt,
  onEditCommand,
  onApprove,
  onReject,
  onSetMergeBranch,
  onSetMergeMode,
  onToggleCollapsed,
  onToggleAdvanced,
}: WorkflowInspectorProps): JSX.Element {
  const [isEditingPrompt, setIsEditingPrompt] = useState(false);
  const [editPromptValue, setEditPromptValue] = useState('');
  const [isEditingCommand, setIsEditingCommand] = useState(false);
  const [editCommandValue, setEditCommandValue] = useState('');
  const [branchValue, setBranchValue] = useState('');

  useEffect(() => {
    setIsEditingPrompt(false);
    setEditPromptValue(task?.config.prompt ?? '');
    setIsEditingCommand(false);
    setEditCommandValue(task?.config.command ?? '');
  }, [task?.id, task?.config.prompt, task?.config.command]);

  useEffect(() => {
    setBranchValue(workflow?.baseBranch ?? task?.config.featureBranch ?? '');
  }, [workflow?.baseBranch, task?.config.featureBranch, task?.id]);

  const taskVisualStatus = task ? getEffectiveVisualStatus(task.status, task.execution) : null;
  const taskColors = taskVisualStatus ? getStatusColor(taskVisualStatus) : null;
  const workflowVisual = workflow ? workflowStatusVisual(workflow.status) : null;
  const reviewUrl =
    workflow?.status === 'review_ready'
      ? task
        ? task.config.isMergeNode && task.status === 'review_ready'
          ? task.execution.reviewUrl
          : undefined
        : getReviewReadyMergeNodeReviewUrl(workflowTasks)
      : undefined;
  const workflowTitle = workflow ? workflow.name || workflow.id : null;
  const nodeTitle = task?.description ?? workflowTitle ?? 'No node selected';
  const showsWorkflowMergeDetails = Boolean(!task && workflow?.id && workflow.onFinish === 'pull_request');
  const isMergeNode = Boolean((task?.config.isMergeNode || showsWorkflowMergeDetails) && workflow?.id);
  const currentAgent = task?.config.executionAgent ?? task?.execution.agentName ?? 'claude';
  const agentOptions = useMemo(() => {
    const names = new Set(executionAgents ?? []);
    names.add(currentAgent);
    return [...names].filter(Boolean);
  }, [currentAgent, executionAgents]);
  const poolOptions = useMemo(() => {
    const ids = new Set(executionPools ?? []);
    if (task?.config.poolId) ids.add(task.config.poolId);
    return [...ids].filter(Boolean);
  }, [executionPools, task?.config.poolId]);
  const isTaskBusy = task?.status === 'running' || task?.status === 'fixing_with_ai';
  const hasPrompt = task?.config.prompt !== undefined;
  const hasCommand = task?.config.command !== undefined;
  const hasExecutableContent = Boolean(hasPrompt || hasCommand);
  const canEditPrompt = Boolean(task?.config.prompt !== undefined && onEditPrompt && !isTaskBusy);
  const canEditCommand = Boolean(task?.config.command !== undefined && onEditCommand && !isTaskBusy);
  const statusBorder = taskColors?.border ?? workflowVisual?.borderClass ?? 'border-gray-700';
  const statusText = taskColors?.text ?? workflowVisual?.textClass ?? 'text-gray-300';
  const statusDot = taskColors?.dot ?? '';
  const isFixApproval = Boolean(task?.execution.pendingFixError);
  const showApprovalActions = Boolean(
    task
    && (task.status === 'awaiting_approval' || task.status === 'review_ready')
    && onApprove
    && onReject,
  );
  const statusHeading = task ? 'Task Status' : 'Status';

  const savePrompt = () => {
    if (task && onEditPrompt && editPromptValue !== (task.config.prompt ?? '')) {
      onEditPrompt(task.id, editPromptValue);
    }
    setIsEditingPrompt(false);
  };

  const saveCommand = () => {
    if (task && onEditCommand && editCommandValue !== (task.config.command ?? '')) {
      onEditCommand(task.id, editCommandValue);
    }
    setIsEditingCommand(false);
  };

  const startEditingPromptOrCommand = () => {
    if (task?.config.prompt !== undefined && canEditPrompt) {
      setEditPromptValue(task.config.prompt);
      setIsEditingPrompt(true);
    } else if (task?.config.command !== undefined && canEditCommand) {
      setEditCommandValue(task.config.command);
      setIsEditingCommand(true);
    }
  };

  const saveBranch = () => {
    const trimmed = branchValue.trim();
    if (workflow?.id && trimmed && trimmed !== (workflow.baseBranch ?? '')) {
      void onSetMergeBranch?.(workflow.id, trimmed);
    }
  };

  if (collapsed) {
    return (
      <aside className="h-full w-full border-l border-gray-800 bg-gray-900 flex items-start justify-center pt-3">
        <button
          onClick={onToggleCollapsed}
          aria-label="Maximize inspector"
          data-sidebar-nav-item
          data-sidebar-nav-order="10"
          className="rounded border border-gray-700 px-2 py-1 text-xs text-gray-300 hover:bg-gray-800"
        >
          Show
        </button>
      </aside>
    );
  }

  return (
    <aside className="h-full w-full border-l border-gray-800 bg-gray-900 flex flex-col">
      <div className="flex items-center justify-between border-b border-gray-800 px-3 py-2">
        <div className="min-w-0">
          <h2 data-testid="workflow-inspector-title" className="text-sm font-medium text-gray-100 truncate max-w-[270px]">{nodeTitle}</h2>
          {workflow && task && (
            <div className="text-[11px] text-gray-400 truncate max-w-[270px]">{workflow.name}</div>
          )}
        </div>
        <button
          onClick={onToggleCollapsed}
          aria-label="Minimize inspector"
          data-sidebar-nav-item
          data-sidebar-nav-order="10"
          className="rounded border border-gray-700 px-2 py-1 text-[11px] text-gray-300 hover:bg-gray-800"
        >
          Minimize
        </button>
      </div>

      <div className="flex-1 overflow-auto p-3 space-y-3 text-sm">
        <section className={`rounded border p-3 ${statusBorder} bg-gray-800/70`}>
          <h3 className="text-[11px] uppercase tracking-wide text-gray-400">{statusHeading}</h3>
          <div data-testid="workflow-inspector-status-label" className={`mt-1 inline-flex items-center gap-2 text-xs ${statusText}`}>
            {taskColors && (
              <span className={`h-2 w-2 rounded-full ${statusDot} ${task?.status === 'running' ? 'animate-pulse' : ''}`} />
            )}
            {formatStatus(task?.status ?? workflow?.status)}
          </div>
          {task?.execution.error && (
            <div className="mt-3 border-t border-red-500/30 pt-2">
              <h3 className="text-[11px] uppercase tracking-wide text-red-300">Error</h3>
              <p className="mt-1 text-xs text-red-300 break-words">{task.execution.error}</p>
              {task.execution.exitCode !== undefined && task.execution.exitCode !== 0 && (
                <p className="mt-2 text-xs text-red-300">Exit code: {task.execution.exitCode}</p>
              )}
            </div>
          )}
          {!task?.execution.error && task?.execution.exitCode !== undefined && task.execution.exitCode !== 0 && (
            <p className="mt-2 text-xs text-red-300">Exit code: {task.execution.exitCode}</p>
          )}
          {showApprovalActions && task && (
            <div className="mt-3 flex gap-2 border-t border-gray-700 pt-3">
              <button
                type="button"
                onClick={() => onApprove?.(task)}
                data-testid="inspector-approve-button"
                data-sidebar-nav-item
                data-sidebar-nav-order="15"
                className="flex-1 rounded bg-green-600 px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-green-500"
              >
                {isFixApproval ? 'Approve Fix' : task.config.isMergeNode ? 'Approve Merge' : 'Approve'}
              </button>
              <button
                type="button"
                onClick={() => onReject?.(task)}
                data-testid="inspector-reject-button"
                data-sidebar-nav-item
                data-sidebar-nav-order="16"
                className="flex-1 rounded bg-red-600 px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-red-500"
              >
                {isFixApproval ? 'Reject Fix' : task.config.isMergeNode ? 'Reject Merge' : 'Reject'}
              </button>
            </div>
          )}
        </section>

        {actionNode && (
          <section data-testid="workflow-inspector-action-node" className="rounded border border-blue-500/40 bg-blue-950/20 p-3">
            <h3 className="text-[11px] uppercase tracking-wide text-blue-200">Action Graph Detail</h3>
            <div className="mt-1 text-sm font-medium text-gray-100 break-words">{actionNode.label}</div>
            <div data-testid="workflow-inspector-action-node-status" className="mt-2 inline-flex rounded border border-blue-300/40 px-2 py-1 text-[10px] font-semibold uppercase text-blue-100">
              {actionNode.status.toUpperCase()}
            </div>
            <dl className="mt-3 space-y-1 text-xs">
              {[
                ['type', actionNode.type],
                ['status', actionNode.status],
                ['taskId', actionNode.taskId],
                ['attemptId', actionNode.attemptId],
                ['intentId', actionNode.intentId],
                ['ownerId', actionNode.ownerId],
                ['createdAt', actionNode.createdAt],
                ['startedAt', actionNode.startedAt],
                ['completedAt', actionNode.completedAt],
                ['heartbeatAt', actionNode.heartbeatAt],
                ['leaseExpiresAt', actionNode.leaseExpiresAt],
              ].filter(([, value]) => value !== undefined && value !== '').map(([key, value]) => (
                <div key={String(key)} className="flex justify-between gap-3">
                  <dt className="shrink-0 text-gray-500">{key}</dt>
                  <dd className="min-w-0 break-all text-right text-gray-200">{String(value)}</dd>
                </div>
              ))}
              {actionNode.durations && Object.entries(actionNode.durations).map(([key, value]) => (
                <div key={`duration-${key}`} className="flex justify-between gap-3">
                  <dt className="shrink-0 text-gray-500">{key}</dt>
                  <dd className="min-w-0 break-all text-right text-gray-200">{String(value)}</dd>
                </div>
              ))}
            </dl>
            {actionNode.latestError && (
              <div className="mt-3 text-xs text-red-300 break-words">{actionNode.latestError}</div>
            )}
            {actionNode.suggestedNextAction && (
              <div className="mt-3 text-xs text-blue-100 break-words">{actionNode.suggestedNextAction}</div>
            )}
            {actionNode.history && actionNode.history.length > 0 && (
              <div className="mt-3 space-y-1 border-t border-blue-400/20 pt-2">
                {[...actionNode.history].reverse().map((entry) => (
                  <div key={entry.id} className="text-[11px] text-gray-300">
                    <span className="text-gray-500">{entry.timestamp}</span> {entry.source}: {entry.message}
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

        {task && !task.config.isMergeNode && onEditPool && (
          <section className="rounded border border-gray-700 bg-gray-800/70 p-3">
            <label className="flex items-center justify-between gap-3">
              <span className="text-xs uppercase tracking-wide text-gray-400">Executor Pool</span>
              <select
                value={task.config.poolId ?? ''}
                onChange={(event) => {
                  if (event.target.value) onEditPool(task.id, event.target.value);
                }}
                disabled={isTaskBusy || poolOptions.length === 0}
                className="min-w-0 max-w-[190px] rounded border border-gray-600 bg-gray-700 px-2 py-1 text-xs text-gray-100 disabled:cursor-not-allowed disabled:opacity-50"
                data-testid="executor-pool-select"
              >
                {!task.config.poolId && <option value="">No pool</option>}
                {poolOptions.map((poolId) => (
                  <option key={poolId} value={poolId}>{poolId}</option>
                ))}
              </select>
            </label>
          </section>
        )}

        {task?.config.prompt && onEditAgent && (
          <section className="rounded border border-gray-700 bg-gray-800/70 p-3">
            <label className="flex items-center justify-between gap-3">
              <span className="text-xs uppercase tracking-wide text-gray-400">AI Agent</span>
              <select
                value={currentAgent}
                onChange={(event) => onEditAgent(task.id, event.target.value)}
                disabled={isTaskBusy || agentOptions.length === 0}
                className="min-w-0 max-w-[190px] rounded border border-gray-600 bg-gray-700 px-2 py-1 text-xs text-gray-100 disabled:cursor-not-allowed disabled:opacity-50"
                data-testid="execution-agent-select"
              >
                {agentOptions.map((agentName) => (
                  <option key={agentName} value={agentName}>{capitalize(agentName)}</option>
                ))}
              </select>
            </label>
          </section>
        )}

        {isMergeNode && (onSetMergeBranch || onSetMergeMode) && (
          <section className="rounded border border-gray-700 bg-gray-800/70 p-3 space-y-3">
            {onSetMergeBranch && (
              <label className="flex items-center justify-between gap-3">
                <span className="text-xs uppercase tracking-wide text-gray-400">Target Branch</span>
                <input
                  data-testid="target-branch-input"
                  value={branchValue}
                  onChange={(event) => setBranchValue(event.target.value)}
                  onBlur={saveBranch}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      (event.target as HTMLInputElement).blur();
                    }
                    if (event.key === 'Escape') {
                      setBranchValue(workflow?.baseBranch ?? '');
                    }
                  }}
                  className="min-w-0 max-w-[190px] rounded border border-gray-600 bg-gray-700 px-2 py-1 text-right font-mono text-xs text-gray-100 focus:border-blue-500 focus:outline-none"
                />
              </label>
            )}
            {onSetMergeMode && workflow?.id && (
              <label className="flex items-center justify-between gap-3">
                <span className="text-xs uppercase tracking-wide text-gray-400">Merge mode</span>
                <select
                  value={mergeModeValue(workflow.mergeMode)}
                  onChange={(event) => void onSetMergeMode(workflow.id, event.target.value as MergeMode)}
                  disabled={isTaskBusy}
                  className="min-w-0 max-w-[190px] rounded border border-gray-600 bg-gray-700 px-2 py-1 text-xs text-gray-100 disabled:cursor-not-allowed disabled:opacity-50"
                  data-testid="merge-mode-select"
                >
                  <option value="manual">Manual</option>
                  <option value="automatic">Automatic</option>
                  <option value="external_review">External review (GitHub)</option>
                </select>
              </label>
            )}
            {workflow?.repoUrl && (
              <div className="flex items-start justify-between gap-3">
                <span className="text-xs uppercase tracking-wide text-gray-400">PR target repo</span>
                <span className="max-w-[210px] break-all text-right text-xs text-gray-200">
                  {workflow.repoUrl.replace(/^https?:\/\//, '')}
                </span>
              </div>
            )}
          </section>
        )}

        {hasExecutableContent && (
          <section className="rounded border border-gray-700 bg-gray-800/70 p-3">
            <div className="text-[11px] uppercase tracking-wide text-gray-400">
              {hasPrompt ? 'Prompt' : 'Command'}
            </div>
            {isEditingPrompt && task?.config.prompt !== undefined ? (
              <div className="mt-2 space-y-2">
                <textarea
                  value={editPromptValue}
                  onChange={(event) => setEditPromptValue(event.target.value)}
                  rows={5}
                  className="w-full resize-y rounded border border-blue-500 bg-gray-950 p-2 text-xs text-gray-100 focus:outline-none"
                  data-testid="edit-prompt-input"
                />
                <div className="flex gap-2">
                  <button data-testid="save-prompt-btn" onClick={savePrompt} className="flex-1 rounded bg-blue-600 px-2 py-1 text-xs text-white hover:bg-blue-500">
                    Save & Re-run
                  </button>
                  <button onClick={() => setIsEditingPrompt(false)} className="flex-1 rounded bg-gray-700 px-2 py-1 text-xs text-gray-100 hover:bg-gray-600">
                    Cancel
                  </button>
                </div>
              </div>
            ) : isEditingCommand && task?.config.command !== undefined ? (
              <div className="mt-2 space-y-2">
                <textarea
                  value={editCommandValue}
                  onChange={(event) => setEditCommandValue(event.target.value)}
                  rows={4}
                  className="w-full resize-y rounded border border-blue-500 bg-gray-950 p-2 font-mono text-xs text-green-300 focus:outline-none"
                  data-testid="edit-command-input"
                />
                <div className="flex gap-2">
                  <button data-testid="save-command-btn" onClick={saveCommand} className="flex-1 rounded bg-blue-600 px-2 py-1 text-xs text-white hover:bg-blue-500">
                    Save & Re-run
                  </button>
                  <button onClick={() => setIsEditingCommand(false)} className="flex-1 rounded bg-gray-700 px-2 py-1 text-xs text-gray-100 hover:bg-gray-600">
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div
                className={`mt-2 rounded border p-2 text-xs leading-relaxed ${
                  canEditPrompt || canEditCommand
                    ? 'cursor-pointer border-gray-600 bg-gray-950 hover:border-blue-500'
                    : 'cursor-text border-gray-700 bg-gray-950'
                }`}
                onClick={startEditingPromptOrCommand}
                onDoubleClick={startEditingPromptOrCommand}
                onDoubleClickCapture={startEditingPromptOrCommand}
                data-testid="command-display"
                data-sidebar-nav-item
                data-sidebar-nav-order="20"
                tabIndex={0}
              >
                <div data-testid="prompt-command-display" onClick={startEditingPromptOrCommand} onDoubleClick={startEditingPromptOrCommand}>
                  {hasPrompt ? (
                    <p className="whitespace-pre-wrap break-words text-gray-200">{task?.config.prompt}</p>
                  ) : (
                    <code className="whitespace-pre-wrap break-words font-mono text-green-300">{task?.config.command}</code>
                  )}
                </div>
              </div>
            )}
          </section>
        )}

        {reviewUrl && (
          <section className="rounded border border-gray-700 bg-gray-800/70 p-3">
            <div className="text-[11px] uppercase tracking-wide text-gray-400">Pull Request</div>
            <a
              href={reviewUrl}
              target="_blank"
              rel="noreferrer"
              data-testid="inspector-pr-link"
              data-sidebar-nav-item
              data-sidebar-nav-order="30"
              className="mt-1 block text-xs text-blue-300 underline break-all"
            >
              {reviewUrl}
            </a>
          </section>
        )}

        <section className="rounded border border-gray-700 bg-gray-800/70">
          <button
            onClick={onToggleAdvanced}
            data-testid="inspector-advanced-disclosure"
            data-sidebar-nav-item
            data-sidebar-nav-order="90"
            data-sidebar-expandable="true"
            aria-expanded={advancedExpanded}
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
              <div>pool id: {task?.config.poolId ?? 'n/a'}</div>
            </div>
          )}
        </section>
      </div>
    </aside>
  );
}
