/**
 * TaskPanel — Side panel showing selected task details and actions.
 *
 * Displays:
 * - Task ID, description, status
 * - Timing info (created, started, completed)
 * - Error details if failed
 * - Action buttons based on status
 */

import { useState, useEffect } from 'react';
import type { TaskState, ExternalDependency, ExternalGatePolicyUpdate, TaskStatus } from '../types.js';
import {
  getStatusColor,
  getEffectiveVisualStatus,
  formatStatusLabel,
  getRunningPhaseLabel,
} from '../lib/colors.js';
import { mergeGatePanelHeading } from '../lib/merge-gate.js';

function formatElapsed(dateVal: Date | string | undefined): string {
  if (!dateVal) return '--';
  const d = dateVal instanceof Date ? dateVal : new Date(dateVal);
  const ms = Date.now() - d.getTime();
  if (ms < 1_000) return '<1s ago';
  if (ms < 60_000) return `${Math.floor(ms / 1_000)}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  return `${Math.floor(ms / 3_600_000)}h ago`;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function normalizeExternalDepTaskId(dep: Pick<ExternalDependency, 'taskId'>): string {
  return dep.taskId?.trim() || '__merge__';
}

function externalDepDisplayId(dep: ExternalDependency): string {
  const normalizedTaskId = normalizeExternalDepTaskId(dep);
  if (normalizedTaskId === '__merge__') return `__merge__${dep.workflowId}`;
  if (normalizedTaskId.includes('/')) return normalizedTaskId;
  return `${dep.workflowId}/${normalizedTaskId}`;
}

function externalDepKey(dep: ExternalDependency): string {
  return `${dep.workflowId}::${normalizeExternalDepTaskId(dep)}`;
}

function resolveExternalDepStatus(dep: ExternalDependency, allTasks?: Map<string, TaskState>): string {
  if (!allTasks) return 'unknown';
  const normalizedTaskId = normalizeExternalDepTaskId(dep);
  if (normalizedTaskId === '__merge__') {
    return allTasks.get(`__merge__${dep.workflowId}`)?.status ?? 'missing';
  }
  if (normalizedTaskId.includes('/')) {
    return allTasks.get(normalizedTaskId)?.status ?? 'missing';
  }
  return allTasks.get(`${dep.workflowId}/${normalizedTaskId}`)?.status ?? allTasks.get(normalizedTaskId)?.status ?? 'missing';
}

interface TaskPanelProps {
  task: TaskState | null;
  allTasks?: Map<string, TaskState>;
  baseBranch?: string;
  remoteTargets?: string[];
  executionAgents?: string[];
  onProvideInput: (task: TaskState) => void;
  onApprove: (task: TaskState) => void;
  onReject: (task: TaskState) => void;
  onSelectExperiment: (task: TaskState) => void;
  onEditCommand?: (taskId: string, newCommand: string) => void;
  onEditType?: (taskId: string, executorType: string, remoteTargetId?: string) => void;
  onEditAgent?: (taskId: string, agentName: string) => void;
  onSetExternalGatePolicies?: (taskId: string, updates: ExternalGatePolicyUpdate[]) => Promise<void>;
  onSetMergeBranch?: (workflowId: string, baseBranch: string) => Promise<void>;
  mergeMode?: string;
  onSetMergeMode?: (workflowId: string, mergeMode: string) => Promise<void>;
}

function formatDate(date?: Date | string): string {
  if (!date) return '--';
  const d = typeof date === 'string' ? new Date(date) : date;
  return d.toLocaleTimeString();
}

/**
 * Display value when task.config.executorType is unset: matches orchestrator
 * loadPlan default worktree. SSH tasks encode the remote target ID as
 * "ssh:<targetId>" for the compound select. Merge nodes hide the selector.
 */
function effectiveExecutorSelectValue(task: TaskState): string {
  if (task.config.executorType === 'ssh' && task.config.remoteTargetId) {
    return `ssh:${task.config.remoteTargetId}`;
  }
  if (task.config.executorType) return task.config.executorType;
  return 'worktree';
}

function HeartbeatTimingSection({ task, formatDate: fmtDate }: { task: TaskState; formatDate: (d?: Date | string) => string }) {
  const [, setTick] = useState(0);

  useEffect(() => {
    if (task.status !== 'running' || !task.execution.lastHeartbeatAt) return;
    const timer = setInterval(() => setTick(t => t + 1), 5_000);
    return () => clearInterval(timer);
  }, [task.status, task.execution.lastHeartbeatAt]);

  const heartbeatAge = task.execution.lastHeartbeatAt
    ? Date.now() - (task.execution.lastHeartbeatAt instanceof Date ? task.execution.lastHeartbeatAt : new Date(task.execution.lastHeartbeatAt as unknown as string)).getTime()
    : null;
  const isHeartbeatStale = heartbeatAge !== null && heartbeatAge > 60_000;

  return (
    <div className="space-y-1 text-sm">
      <div className="flex justify-between">
        <span className="text-gray-400">Created</span>
        <span className="text-gray-200">{fmtDate(task.createdAt)}</span>
      </div>
      {task.execution.startedAt && (
        <div className="flex justify-between">
          <span className="text-gray-400">Started</span>
          <span className="text-gray-200">{fmtDate(task.execution.startedAt)}</span>
        </div>
      )}
      {task.execution.completedAt && (
        <div className="flex justify-between">
          <span className="text-gray-400">Completed</span>
          <span className="text-gray-200">{fmtDate(task.execution.completedAt)}</span>
        </div>
      )}
      {task.execution.launchStartedAt && (
        <div className="flex justify-between">
          <span className="text-gray-400">Launch started</span>
          <span className="text-gray-200">{fmtDate(task.execution.launchStartedAt)}</span>
        </div>
      )}
      {task.execution.launchCompletedAt && (
        <div className="flex justify-between">
          <span className="text-gray-400">Launch completed</span>
          <span className="text-gray-200">{fmtDate(task.execution.launchCompletedAt)}</span>
        </div>
      )}
      {task.status === 'running' && task.execution.phase && (
        <div className="flex justify-between">
          <span className="text-gray-400">Running phase</span>
          <span className="text-gray-200">{getRunningPhaseLabel(task.execution.phase)}</span>
        </div>
      )}
      {task.status === 'running' && task.execution.lastHeartbeatAt && (
        <div className="flex justify-between">
          <span className="text-gray-400">Last heartbeat</span>
          <span className={isHeartbeatStale ? 'text-red-400 font-medium' : 'text-gray-200'}>
            {formatElapsed(task.execution.lastHeartbeatAt)}
          </span>
        </div>
      )}
    </div>
  );
}

export function TaskPanel({
  task,
  allTasks,
  baseBranch,
  remoteTargets,
  executionAgents,
  onProvideInput,
  onApprove,
  onReject,
  onSelectExperiment,
  onEditCommand,
  onEditType,
  onEditAgent,
  onSetExternalGatePolicies,
  onSetMergeBranch,
  mergeMode,
  onSetMergeMode,
}: TaskPanelProps) {
  const [isEditingCommand, setIsEditingCommand] = useState(false);
  const [editCommandValue, setEditCommandValue] = useState('');
  const [branchValue, setBranchValue] = useState(baseBranch ?? '');
  const [showAdvanced, setShowAdvanced] = useState(true);
  const [isEditingGatePolicies, setIsEditingGatePolicies] = useState(false);
  const [isSavingGatePolicies, setIsSavingGatePolicies] = useState(false);
  const [gatePolicyDraft, setGatePolicyDraft] = useState<Record<string, 'completed' | 'review_ready'>>({});
  const [isSatisfiedListExpanded, setIsSatisfiedListExpanded] = useState(false);

  useEffect(() => {
    setIsEditingCommand(false);
    setEditCommandValue(task?.config.command ?? '');
    setBranchValue(baseBranch ?? '');
    setIsEditingGatePolicies(false);
    setIsSavingGatePolicies(false);
    setIsSatisfiedListExpanded(false);
    const nextDraft: Record<string, 'completed' | 'review_ready'> = {};
    for (const dep of task?.config.externalDependencies ?? []) {
      nextDraft[externalDepKey(dep)] = dep.gatePolicy ?? 'review_ready';
    }
    setGatePolicyDraft(nextDraft);
  }, [task?.id, baseBranch]);

  if (!task) {
    return (
      <div className="h-full flex items-center justify-center text-gray-500 p-4">
        <p>Select a task from the graph to view details</p>
      </div>
    );
  }

  const canEditCommand = task.config.command !== undefined && task.status !== 'running' && onEditCommand;

  const handleSaveCommand = () => {
    if (onEditCommand && editCommandValue !== task.config.command) {
      onEditCommand(task.id, editCommandValue);
    }
    setIsEditingCommand(false);
  };

  const handleCancelEdit = () => {
    setEditCommandValue(task.config.command ?? '');
    setIsEditingCommand(false);
  };

  const visualStatus = getEffectiveVisualStatus(task.status, task.execution);
  const colors = getStatusColor(visualStatus);
  const phaseLabel = task.status === 'running'
    ? getRunningPhaseLabel(task.execution.phase)
    : null;
  const executorSelectValue = effectiveExecutorSelectValue(task);

  const mergeGateDisplayTitle = mergeGatePanelHeading(task, mergeMode);
  const isFixApproval = Boolean(task.execution.pendingFixError);
  const externalDeps = task.config.externalDependencies ?? [];
  const canEditGatePolicies = Boolean(
    onSetExternalGatePolicies
    && externalDeps.length > 0
    && task.status !== 'running'
    && task.status !== 'fixing_with_ai',
  );
  const changedGatePolicyCount = externalDeps.filter((dep) => {
    const key = externalDepKey(dep);
    const draft = gatePolicyDraft[key] ?? dep.gatePolicy ?? 'review_ready';
    const current = dep.gatePolicy ?? 'review_ready';
    return draft !== current;
  }).length;

  const handleSaveGatePolicies = async () => {
    if (!onSetExternalGatePolicies || changedGatePolicyCount === 0) {
      setIsEditingGatePolicies(false);
      return;
    }
    const updates: ExternalGatePolicyUpdate[] = externalDeps
      .filter((dep) => {
        const key = externalDepKey(dep);
        const draft = gatePolicyDraft[key] ?? dep.gatePolicy ?? 'review_ready';
        const current = dep.gatePolicy ?? 'review_ready';
        return draft !== current;
      })
      .map((dep) => ({
        workflowId: dep.workflowId,
        taskId: dep.taskId,
        gatePolicy: gatePolicyDraft[externalDepKey(dep)] ?? dep.gatePolicy ?? 'review_ready',
      }));

    const confirmed = window.confirm(
      `Apply gate policy changes to ${updates.length} external dependenc${updates.length === 1 ? 'y' : 'ies'}? This re-evaluates the task immediately.`,
    );
    if (!confirmed) return;

    try {
      setIsSavingGatePolicies(true);
      await onSetExternalGatePolicies(task.id, updates);
      setIsEditingGatePolicies(false);
    } finally {
      setIsSavingGatePolicies(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto p-4 space-y-4">
      {/* Header */}
      <div>
        <h2 className="text-lg font-semibold text-gray-100 truncate">
          {mergeGateDisplayTitle}
        </h2>
        <p className="text-xs font-mono text-gray-400 mt-1">{task.id}</p>
      </div>

      {/* Status badge */}
      <div className="flex items-center gap-2">
        <span
          className={`inline-flex items-center gap-1.5 px-2 py-1 rounded text-xs font-medium ${colors.bg} ${colors.text}`}
        >
          <span
            className={`w-2 h-2 rounded-full ${colors.dot} ${
              task.status === 'running' ? 'animate-pulse' : ''
            }`}
          />
          {visualStatus === 'fixing_with_ai'
            ? ((task.config.autoFixRetries ?? 0) > 0 ? 'AUTO-FIXING' : 'FIXING WITH AI')
            : visualStatus === 'fix_approval'
              ? 'APPROVE FIX'
              : phaseLabel
                ? `RUNNING · ${phaseLabel.toUpperCase()}`
              : task.status.toUpperCase().replace('_', ' ')}
        </span>
      </div>

      {/* Auto-fix retry counter */}
      {(task.config.autoFixRetries ?? 0) > 0 && (task.execution.autoFixAttempts ?? 0) > 0 && (
        <div className="flex items-center justify-between">
          <span className="text-sm text-gray-400">Auto-fix</span>
          <span className="text-xs text-gray-200">
            attempt {task.execution.autoFixAttempts}/{task.config.autoFixRetries}
          </span>
        </div>
      )}

      {/* Target branch (merge gates only) */}
      {task.config.isMergeNode && onSetMergeBranch && task.config.workflowId && (
        <div className="flex items-center justify-between">
          <span className="text-sm text-gray-400">Target Branch</span>
          <input
            data-testid="target-branch-input"
            value={branchValue}
            onChange={(e) => setBranchValue(e.target.value)}
            onBlur={() => {
              const trimmed = branchValue.trim();
              if (trimmed && trimmed !== baseBranch) {
                onSetMergeBranch(task.config.workflowId!, trimmed);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                (e.target as HTMLInputElement).blur();
              }
              if (e.key === 'Escape') {
                setBranchValue(baseBranch ?? '');
              }
            }}
            className="bg-gray-700 text-gray-200 text-xs font-mono rounded px-2 py-1 border border-gray-600 focus:outline-none focus:border-blue-500 w-28 text-right"
          />
        </div>
      )}

      {/* Review link (merge gates only) */}
      {task.config.isMergeNode && task.execution?.reviewUrl && (
        <div className="flex items-center justify-between">
          <span className="text-sm text-gray-400">Review link</span>
          <a
            href={task.execution.reviewUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs font-mono text-blue-400 hover:text-blue-300 underline truncate max-w-[200px]"
            title={task.execution.reviewUrl}
            data-testid="pr-url-link"
          >
            {task.execution.reviewUrl.replace(/^https?:\/\/[^/]+\//, '')}
          </a>
        </div>
      )}
      {task.config.isMergeNode && task.execution?.reviewStatus && (
        <div className="flex items-center justify-between">
          <span className="text-sm text-gray-400">Review Status</span>
          <span className="text-xs text-gray-200" data-testid="pr-status-text">
            {task.execution.reviewStatus}
          </span>
        </div>
      )}

      {/* Advanced section (collapsed by default) */}
      {(
        (onEditType && !task.config.isMergeNode) ||
        (task.config.prompt && onEditAgent) ||
        (task.config.isMergeNode && onSetMergeMode && task.config.workflowId)
      ) && (
        <div className="border-t border-gray-700 pt-3">
          <button
            onClick={() => setShowAdvanced(!showAdvanced)}
            className="flex items-center gap-2 text-sm text-gray-300 hover:text-gray-100 transition-colors w-full"
            data-testid="advanced-toggle"
          >
            <span className="text-gray-500">{showAdvanced ? '▼' : '▶'}</span>
            <span>Advanced</span>
          </button>

          {showAdvanced && (
            <div className="mt-3 space-y-3">
              {/* Executor type selector (for non-merge tasks) */}
              {onEditType && !task.config.isMergeNode && (
                <div className="flex items-center justify-between">
                  <span className="text-sm text-gray-400">Run on</span>
                  <select
                    value={executorSelectValue}
                    onChange={(e) => {
                      const val = e.target.value;
                      if (val.startsWith('ssh:')) {
                        onEditType(task.id, 'ssh', val.slice(4));
                      } else {
                        onEditType(task.id, val);
                      }
                    }}
                    disabled={task.status === 'running'}
                    className="bg-gray-700 text-gray-200 text-xs rounded px-2 py-1 border border-gray-600 focus:outline-none focus:border-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
                    data-testid="executor-type-select"
                  >
                    <option value="worktree">Worktree</option>
                    <option value="docker">Docker</option>
                    {remoteTargets?.map((targetId) => (
                      <option key={targetId} value={`ssh:${targetId}`}>
                        SSH: {targetId}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {/* Agent selector (for prompt tasks) */}
              {task.config.prompt && onEditAgent && (
                <div className="flex items-center justify-between">
                  <span className="text-sm text-gray-400">Agent</span>
                  <select
                    value={task.config.executionAgent ?? 'claude'}
                    onChange={(e) => onEditAgent(task.id, e.target.value)}
                    disabled={task.status === 'running'}
                    className="bg-gray-700 text-gray-200 text-xs rounded px-2 py-1 border border-gray-600 focus:outline-none focus:border-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
                    data-testid="execution-agent-select"
                  >
                    {(executionAgents ?? []).map(name => (
                      <option key={name} value={name}>{capitalize(name)} Task</option>
                    ))}
                  </select>
                </div>
              )}

              {/* Merge mode selector (merge gates only) */}
              {task.config.isMergeNode && onSetMergeMode && task.config.workflowId && (
                <div className="flex items-center justify-between">
                  <span className="text-sm text-gray-400">Merge mode</span>
                  <select
                    value={mergeMode ?? 'manual'}
                    onChange={(e) => onSetMergeMode(task.config.workflowId!, e.target.value)}
                    disabled={task.status === 'running' || task.status === 'fixing_with_ai'}
                    className="bg-gray-700 text-gray-200 text-xs rounded px-2 py-1 border border-gray-600 focus:outline-none focus:border-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
                    data-testid="merge-mode-select"
                  >
                    <option value="manual">Manual</option>
                    <option value="automatic">Automatic</option>
                    <option value="external_review">External review (GitHub)</option>
                  </select>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Task type + content */}
      {(task.config.prompt || task.config.command) && (
        <div>
          <div className="flex items-center justify-between">
            <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
              task.config.prompt
                ? 'bg-blue-900/40 text-blue-300'
                : 'bg-gray-700 text-gray-300'
            }`}>
              {task.config.prompt
                ? capitalize(task.config.executionAgent ?? 'claude') + ' Task'
                : 'Command'}
            </span>
          </div>

          {isEditingCommand && task.config.command !== undefined ? (
            <div className="mt-2 space-y-2">
              <textarea
                value={editCommandValue}
                onChange={(e) => setEditCommandValue(e.target.value)}
                className="w-full rounded p-3 text-xs font-mono text-green-300 bg-gray-800 border border-blue-500 focus:outline-none focus:border-blue-400 resize-y"
                rows={3}
                data-testid="edit-command-input"
              />
              <div className="flex gap-2">
                <button
                  onClick={handleSaveCommand}
                  className="flex-1 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded text-xs font-medium transition-colors"
                  data-testid="save-command-btn"
                >
                  Save & Re-run
                </button>
                <button
                  onClick={handleCancelEdit}
                  className="flex-1 px-3 py-1.5 bg-gray-600 hover:bg-gray-500 text-white rounded text-xs font-medium transition-colors"
                  data-testid="cancel-edit-btn"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div
              className={`mt-2 rounded p-3 text-xs select-text ${
                task.config.prompt
                  ? 'bg-blue-900/20 border border-blue-800 cursor-text'
                  : canEditCommand
                    ? 'bg-gray-800 border border-gray-700 cursor-pointer hover:border-gray-600 transition-colors'
                    : 'bg-gray-800 border border-gray-700 cursor-text'
              }`}
              onDoubleClick={() => {
                if (canEditCommand) {
                  setEditCommandValue(task.config.command ?? '');
                  setIsEditingCommand(true);
                }
              }}
              data-testid="command-display"
            >
              {task.config.prompt ? (
                <p className="text-gray-300 whitespace-pre-wrap">{task.config.prompt}</p>
              ) : (
                <code className="text-green-300 font-mono whitespace-pre-wrap">{task.config.command}</code>
              )}
            </div>
          )}
        </div>
      )}

      {/* Timing */}
      <HeartbeatTimingSection task={task} formatDate={formatDate} />

      {/* Dependencies */}
      {task.dependencies.length > 0 && (
        <div>
          <h3 className="text-sm font-medium text-gray-300 mb-1">Dependencies</h3>
          <div className="flex flex-wrap gap-1">
            {task.dependencies.map((depId) => (
              <span
                key={depId}
                className="text-xs bg-gray-700 text-gray-300 px-2 py-0.5 rounded"
              >
                {depId.length > 15 ? depId.slice(0, 15) + '...' : depId}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Error / Exit Code */}
      {(task.execution.error || (task.execution.exitCode !== undefined && task.execution.exitCode !== 0)) && (
        <div className="bg-red-900/30 border border-red-700 rounded p-3">
          <h3 className="text-sm font-medium text-red-400 mb-1">Error</h3>
          {task.execution.error && (
            <p className="text-xs text-red-300 whitespace-pre-wrap">{task.execution.error}</p>
          )}
          {task.execution.exitCode !== undefined && (
            <p className="text-xs text-red-400 mt-1">Exit code: {task.execution.exitCode}</p>
          )}
        </div>
      )}

      {/* Input prompt */}
      {task.execution.inputPrompt && task.status === 'needs_input' && (
        <div className="bg-amber-900/30 border border-amber-700 rounded p-3">
          <h3 className="text-sm font-medium text-amber-400 mb-1">Input Required</h3>
          <p className="text-xs text-amber-300">{task.execution.inputPrompt}</p>
        </div>
      )}

      {/* Blocked info */}
      {task.execution.blockedBy && (
        <div className="bg-gray-700/50 border border-gray-600 rounded p-3">
          <h3 className="text-sm font-medium text-gray-400 mb-1">Blocked By</h3>
          <p className="text-xs text-gray-300">{task.execution.blockedBy}</p>
        </div>
      )}

      {/* External dependencies + gate policy */}
      {externalDeps.length > 0 && (() => {
        // Status ladder for gate evaluation
        const statusLadder: TaskStatus[] = ['pending', 'running', 'review_ready', 'awaiting_approval', 'completed'];

        // Helper: compute steps between current and threshold
        const computeSteps = (current: TaskStatus, threshold: TaskStatus): number => {
          const currentIdx = statusLadder.indexOf(current);
          const thresholdIdx = statusLadder.indexOf(threshold);
          if (currentIdx === -1 || thresholdIdx === -1) return Infinity;
          return thresholdIdx - currentIdx;
        };

        // Helper: check if a dep is satisfied (matches orchestrator logic)
        const isSatisfied = (dep: ExternalDependency): boolean => {
          const status = resolveExternalDepStatus(dep, allTasks);
          if (status === 'missing') return false;
          const gatePolicy = dep.gatePolicy ?? 'review_ready';
          const requiredStatus = dep.requiredStatus ?? 'completed';
          const normalizedTaskId = normalizeExternalDepTaskId(dep);
          const isMergeGateDep = normalizedTaskId === '__merge__';

          // Match orchestrator.ts:2599-2606 satisfaction logic
          return (
            status === requiredStatus
            || (
              gatePolicy === 'review_ready'
              && isMergeGateDep
              && requiredStatus === 'completed'
              && (status === 'review_ready' || status === 'awaiting_approval')
            )
          );
        };

        // Group deps by workflow to detect mixed policies
        const workflowGroups = new Map<string, ExternalDependency[]>();
        for (const dep of externalDeps) {
          const wfId = dep.workflowId;
          if (!workflowGroups.has(wfId)) workflowGroups.set(wfId, []);
          workflowGroups.get(wfId)!.push(dep);
        }

        // Partition into offenders and satisfied
        const offenders: ExternalDependency[] = [];
        const satisfied: ExternalDependency[] = [];

        for (const dep of externalDeps) {
          const group = workflowGroups.get(dep.workflowId) ?? [];
          const policies = new Set(group.map(d => d.gatePolicy ?? 'review_ready'));
          const hasMixedPolicy = policies.size > 1;

          if (hasMixedPolicy || !isSatisfied(dep)) {
            offenders.push(dep);
          } else {
            satisfied.push(dep);
          }
        }

        const offenderCount = offenders.length;
        const satisfiedCount = satisfied.length;
        const totalCount = externalDeps.length;

        // Auto-expand satisfied list when editing
        const effectiveExpanded = isEditingGatePolicies || isSatisfiedListExpanded;

        return (
          <div className="space-y-3 border border-gray-700 rounded p-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium text-gray-200">Gate Policy</h3>
              {canEditGatePolicies && !isEditingGatePolicies && (
                <button
                  onClick={() => {
                    setIsEditingGatePolicies(true);
                    setIsSatisfiedListExpanded(true);
                  }}
                  className="text-xs text-blue-400 hover:text-blue-300"
                  data-testid="gate-policy-edit-btn"
                >
                  Edit
                </button>
              )}
            </div>

            {/* Summary line */}
            <div className={`text-xs font-medium ${offenderCount > 0 ? 'text-amber-300' : 'text-emerald-300'}`}>
              {offenderCount > 0 ? (
                <>⚠ {offenderCount} gate{offenderCount === 1 ? '' : 's'} {offenderCount === 1 ? 'blocking' : 'need attention'}</>
              ) : (
                <>✓ All {totalCount} gate{totalCount === 1 ? '' : 's'} satisfied</>
              )}
            </div>

            {/* Offender cards */}
            {offenders.length > 0 && (
              <div className="space-y-2">
                {offenders.map((dep, index) => {
                  const key = externalDepKey(dep);
                  const currentPolicy = dep.gatePolicy ?? 'review_ready';
                  const draftPolicy = gatePolicyDraft[key] ?? currentPolicy;
                  const status = resolveExternalDepStatus(dep, allTasks);
                  const normalizedTaskId = normalizeExternalDepTaskId(dep);
                  const isMergeGate = normalizedTaskId === '__merge__';

                  // Detect mixed policy
                  const group = workflowGroups.get(dep.workflowId) ?? [];
                  const policies = new Set(group.map(d => d.gatePolicy ?? 'review_ready'));
                  const hasMixedPolicy = policies.size > 1;

                  // Compute impact
                  const steps = status !== 'missing' && !hasMixedPolicy
                    ? computeSteps(status as TaskStatus, draftPolicy as TaskStatus)
                    : Infinity;
                  let impactText = '';
                  if (isEditingGatePolicies && !hasMixedPolicy && status !== 'missing') {
                    if (steps === 0) {
                      impactText = 'would unblock now';
                    } else if (steps > 0) {
                      impactText = `still ${steps} step${steps === 1 ? '' : 's'} away`;
                    } else {
                      impactText = 'satisfied';
                    }
                  } else if (!isEditingGatePolicies && !hasMixedPolicy && status !== 'missing') {
                    if (steps === 1) {
                      impactText = '1 step away';
                    } else if (steps > 1) {
                      impactText = `${steps} steps away`;
                    }
                  }

                  // Get reviewUrl from merge node if it's a merge gate
                  let reviewUrl = '';
                  if (isMergeGate && allTasks) {
                    const mergeNode = allTasks.get(`__merge__${dep.workflowId}`);
                    reviewUrl = mergeNode?.execution?.reviewUrl ?? '';
                  }

                  const dotColor = status !== 'missing' ? getStatusColor(status as TaskStatus).dot : 'bg-slate-500';

                  return (
                    <div key={`${key}-${index}`} className="rounded border border-gray-700 bg-gray-800/40 p-2 space-y-1" data-testid={`gate-policy-offender-${index}`}>
                      <div className="flex items-start gap-1">
                        <span className="text-amber-400 flex-shrink-0">⚠</span>
                        <div className="flex-1 min-w-0">
                          <div className="text-xs text-red-300 font-medium break-all">
                            {externalDepDisplayId(dep)}
                            {reviewUrl && (
                              <a
                                href={reviewUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="ml-2 text-blue-400 hover:text-blue-300"
                              >
                                PR #{reviewUrl.split('/').pop()} ↗
                              </a>
                            )}
                          </div>
                        </div>
                      </div>

                      {hasMixedPolicy ? (
                        <div className="text-xs text-gray-400 ml-4">
                          <div>Mixed thresholds across {group.length} dep{group.length === 1 ? '' : 's'}</div>
                          {!isEditingGatePolicies && <div className="mt-0.5">Unblock at <span className="text-amber-400">⚠ mixed</span></div>}
                        </div>
                      ) : (
                        <div className="text-xs ml-4 space-y-0.5">
                          <div className="flex items-center gap-1.5 text-gray-300">
                            <span className="text-gray-400">Currently</span>
                            <span className={`inline-block w-1.5 h-1.5 rounded-full ${status !== 'missing' ? dotColor : 'bg-slate-500'}`} />
                            <span>{status !== 'missing' ? formatStatusLabel(status as TaskStatus) : 'Missing'}</span>
                          </div>

                          <div className="flex items-center gap-1.5">
                            <span className="text-gray-400">Unblock at</span>
                            {isEditingGatePolicies ? (
                              <select
                                value={draftPolicy}
                                onChange={(e) => {
                                  const next = e.target.value as 'completed' | 'review_ready';
                                  setGatePolicyDraft((prev) => ({ ...prev, [key]: next }));
                                }}
                                className="bg-gray-700 text-gray-200 text-xs rounded px-2 py-0.5 border border-gray-600 focus:outline-none focus:border-blue-500"
                                data-testid={`gate-policy-select-${index}`}
                              >
                                <option value="review_ready">Review Ready</option>
                                <option value="completed">Completed</option>
                              </select>
                            ) : (
                              <>
                                <span className={`inline-block w-1.5 h-1.5 rounded-full ${getStatusColor(draftPolicy as TaskStatus).dot}`} />
                                <span className="text-gray-300">{formatStatusLabel(draftPolicy as TaskStatus)}</span>
                              </>
                            )}
                            {impactText && <span className="text-gray-400 ml-1">{impactText}</span>}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Satisfied gates disclosure */}
            {satisfied.length > 0 && (
              <div className="space-y-1">
                <button
                  onClick={() => setIsSatisfiedListExpanded(!isSatisfiedListExpanded)}
                  className="text-xs text-gray-400 hover:text-gray-300 w-full text-left"
                >
                  {effectiveExpanded ? '▾' : '▸'} {satisfied.length} satisfied gate{satisfied.length === 1 ? '' : 's'}
                </button>

                {effectiveExpanded && (
                  <div className="space-y-1 ml-3">
                    {satisfied.map((dep, index) => {
                      const key = externalDepKey(dep);
                      const currentPolicy = dep.gatePolicy ?? 'review_ready';
                      const draftPolicy = gatePolicyDraft[key] ?? currentPolicy;
                      const status = resolveExternalDepStatus(dep, allTasks);
                      const normalizedTaskId = normalizeExternalDepTaskId(dep);
                      const isMergeGate = normalizedTaskId === '__merge__';

                      let reviewUrl = '';
                      if (isMergeGate && allTasks) {
                        const mergeNode = allTasks.get(`__merge__${dep.workflowId}`);
                        reviewUrl = mergeNode?.execution?.reviewUrl ?? '';
                      }

                      const dotColor = status !== 'missing' ? getStatusColor(status as TaskStatus).dot : 'bg-slate-500';

                      return (
                        <div key={`satisfied-${key}-${index}`} className="flex items-center gap-1.5 text-xs text-slate-400">
                          {isEditingGatePolicies ? (
                            <>
                              <span className="flex-shrink-0">{externalDepDisplayId(dep)}</span>
                              <select
                                value={draftPolicy}
                                onChange={(e) => {
                                  const next = e.target.value as 'completed' | 'review_ready';
                                  setGatePolicyDraft((prev) => ({ ...prev, [key]: next }));
                                }}
                                className="ml-auto bg-gray-700 text-gray-200 text-xs rounded px-2 py-0.5 border border-gray-600 focus:outline-none focus:border-blue-500"
                                data-testid={`gate-policy-select-${externalDeps.indexOf(dep)}`}
                              >
                                <option value="review_ready">Review Ready</option>
                                <option value="completed">Completed</option>
                              </select>
                              {reviewUrl && (
                                <a
                                  href={reviewUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="ml-1 text-blue-400 hover:text-blue-300"
                                >
                                  PR#{reviewUrl.split('/').pop()} ↗
                                </a>
                              )}
                            </>
                          ) : (
                            <>
                              <span className="flex-shrink-0">✓</span>
                              <span className="flex-shrink-0">{externalDepDisplayId(dep)}</span>
                              <span className={`inline-block w-1.5 h-1.5 rounded-full ${dotColor} ml-auto`} />
                              <span>{formatStatusLabel(status as TaskStatus)}</span>
                              {reviewUrl && (
                                <a
                                  href={reviewUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="ml-1 text-blue-400 hover:text-blue-300"
                                >
                                  PR#{reviewUrl.split('/').pop()}
                                </a>
                              )}
                            </>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* Edit mode controls */}
            {isEditingGatePolicies && (
              <div className="space-y-2">
                <div className="text-xs text-gray-400" data-testid="gate-policy-impact-text">
                  {changedGatePolicyCount > 0
                    ? `${changedGatePolicyCount} change${changedGatePolicyCount === 1 ? '' : 's'} pending. Apply to re-evaluate immediately.`
                    : 'No changes yet.'}
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={handleSaveGatePolicies}
                    disabled={isSavingGatePolicies || changedGatePolicyCount === 0}
                    className="flex-1 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:bg-blue-900/40 disabled:text-gray-400 text-white rounded text-xs font-medium transition-colors"
                    data-testid="gate-policy-apply-btn"
                  >
                    {isSavingGatePolicies ? 'Applying...' : 'Apply & Re-evaluate'}
                  </button>
                  <button
                    onClick={() => {
                      const resetDraft: Record<string, 'completed' | 'review_ready'> = {};
                      for (const dep of externalDeps) {
                        resetDraft[externalDepKey(dep)] = dep.gatePolicy ?? 'review_ready';
                      }
                      setGatePolicyDraft(resetDraft);
                      setIsEditingGatePolicies(false);
                    }}
                    disabled={isSavingGatePolicies}
                    className="flex-1 px-3 py-1.5 bg-gray-600 hover:bg-gray-500 disabled:opacity-50 text-white rounded text-xs font-medium transition-colors"
                    data-testid="gate-policy-cancel-btn"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })()}

      {/* Git info */}
      {(task.execution.branch || task.execution.commit) && (
        <div className="space-y-1 text-sm">
          {task.execution.branch && (
            <div className="flex justify-between">
              <span className="text-gray-400">Branch</span>
              <span className="text-gray-200 font-mono text-xs">{task.execution.branch}</span>
            </div>
          )}
          {task.execution.commit && (
            <div className="flex justify-between">
              <span className="text-gray-400">Commit</span>
              <span className="text-gray-200 font-mono text-xs">
                {task.execution.commit.slice(0, 8)}
              </span>
            </div>
          )}
        </div>
      )}

      {/* Summary */}
      {task.config.summary && (
        <div>
          <h3 className="text-sm font-medium text-gray-300 mb-1">Summary</h3>
          <p className="text-xs text-gray-400 whitespace-pre-wrap">{task.config.summary}</p>
        </div>
      )}

      {/* Experiment results */}
      {task.execution.experimentResults && task.execution.experimentResults.length > 0 && (
        <div>
          <h3 className="text-sm font-medium text-gray-300 mb-1">Experiment Results</h3>
          <div className="space-y-1">
            {task.execution.experimentResults.map((result) => (
              <div
                key={result.id}
                className={`text-xs p-2 rounded ${
                  result.status === 'completed'
                    ? 'bg-green-900/30 text-green-300'
                    : 'bg-red-900/30 text-red-300'
                }`}
              >
                <div className="font-medium">{result.id}</div>
                {result.summary && (
                  <div className="mt-1 opacity-80">{result.summary}</div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Action buttons */}
      <div className="space-y-2 pt-2">
        {task.status === 'needs_input' && !task.config.isReconciliation && (
          <button
            onClick={() => onProvideInput(task)}
            className="w-full px-4 py-2 bg-amber-600 hover:bg-amber-500 text-white rounded text-sm font-medium transition-colors"
          >
            Provide Input
          </button>
        )}

        {(task.status === 'awaiting_approval' || task.status === 'review_ready') && (
          <div className="flex gap-2">
            <button
              onClick={() => onApprove(task)}
              className="flex-1 px-4 py-2 bg-green-600 hover:bg-green-500 text-white rounded text-sm font-medium transition-colors"
            >
              {isFixApproval ? 'Approve Fix' : task.config.isMergeNode ? 'Approve Merge' : 'Approve'}
            </button>
            <button
              onClick={() => onReject(task)}
              className="flex-1 px-4 py-2 bg-red-600 hover:bg-red-500 text-white rounded text-sm font-medium transition-colors"
            >
              {isFixApproval ? 'Reject Fix' : task.config.isMergeNode ? 'Reject Merge' : 'Reject'}
            </button>
          </div>
        )}

        {task.config.isReconciliation && task.status === 'needs_input' && (
          <button
            onClick={() => onSelectExperiment(task)}
            className="w-full px-4 py-2 bg-purple-600 hover:bg-purple-500 text-white rounded text-sm font-medium transition-colors"
          >
            Select Experiment
          </button>
        )}

      </div>
    </div>
  );
}
