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
import type { TaskState } from '../types.js';
import { getStatusColor, getEffectiveVisualStatus } from '../lib/colors.js';
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

interface TaskPanelProps {
  task: TaskState | null;
  baseBranch?: string;
  remoteTargets?: string[];
  onProvideInput: (task: TaskState) => void;
  onApprove: (task: TaskState) => void;
  onReject: (task: TaskState) => void;
  onSelectExperiment: (task: TaskState) => void;
  onEditCommand?: (taskId: string, newCommand: string) => void;
  onEditType?: (taskId: string, familiarType: string, remoteTargetId?: string) => void;
  onSetMergeBranch?: (workflowId: string, baseBranch: string) => Promise<void>;
  onNotifyBranchUpdated?: (taskId: string) => Promise<void>;
  mergeMode?: string;
  onSetMergeMode?: (workflowId: string, mergeMode: string) => Promise<void>;
}

function formatDate(date?: Date | string): string {
  if (!date) return '--';
  const d = typeof date === 'string' ? new Date(date) : date;
  return d.toLocaleTimeString();
}

/**
 * Display value when task.config.familiarType is unset: matches orchestrator
 * loadPlan default worktree; repoUrl alone implies worktree (TaskExecutor.selectFamiliar).
 * SSH tasks encode the remote target ID as "ssh:<targetId>" for the compound select.
 * Merge nodes hide the selector.
 */
function effectiveExecutorSelectValue(task: TaskState): string {
  if (task.config.familiarType === 'ssh' && task.config.remoteTargetId) {
    return `ssh:${task.config.remoteTargetId}`;
  }
  if (task.config.familiarType) return task.config.familiarType;
  if (task.config.repoUrl) return 'worktree';
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
  baseBranch,
  remoteTargets,
  onProvideInput,
  onApprove,
  onReject,
  onSelectExperiment,
  onEditCommand,
  onEditType,
  onSetMergeBranch,
  onNotifyBranchUpdated,
  mergeMode,
  onSetMergeMode,
}: TaskPanelProps) {
  const [isEditingCommand, setIsEditingCommand] = useState(false);
  const [editCommandValue, setEditCommandValue] = useState('');
  const [branchValue, setBranchValue] = useState(baseBranch ?? '');

  useEffect(() => {
    setIsEditingCommand(false);
    setEditCommandValue(task?.config.command ?? '');
    setBranchValue(baseBranch ?? '');
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
  const executorSelectValue = effectiveExecutorSelectValue(task);

  const mergeGateDisplayTitle = mergeGatePanelHeading(task, mergeMode);
  const isFixApproval = Boolean(task.execution.pendingFixError);

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
            ? 'FIXING WITH AI'
            : visualStatus === 'fix_approval'
              ? 'APPROVE FIX'
              : task.status.toUpperCase().replace('_', ' ')}
        </span>
      </div>

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

      {/* Merge mode selector (merge gates only) */}
      {task.config.isMergeNode && onSetMergeMode && task.config.workflowId && (
        <div className="flex items-center justify-between">
          <span className="text-sm text-gray-400">Merge Mode</span>
          <select
            value={mergeMode ?? 'manual'}
            onChange={(e) => onSetMergeMode(task.config.workflowId!, e.target.value)}
            disabled={task.status === 'running'}
            className="bg-gray-700 text-gray-200 text-xs rounded px-2 py-1 border border-gray-600 focus:outline-none focus:border-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
            data-testid="merge-mode-select"
          >
            <option value="manual">Manual</option>
            <option value="automatic">Automatic</option>
            <option value="github">GitHub</option>
          </select>
        </div>
      )}

      {/* GitHub PR link (merge gates only) */}
      {task.config.isMergeNode && task.execution?.prUrl && (
        <div className="flex items-center justify-between">
          <span className="text-sm text-gray-400">PR link</span>
          <a
            href={task.execution.prUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs font-mono text-blue-400 hover:text-blue-300 underline truncate max-w-[200px]"
            title={task.execution.prUrl}
            data-testid="pr-url-link"
          >
            {task.execution.prUrl.replace(/^https?:\/\/github\.com\//, '')}
          </a>
        </div>
      )}
      {task.config.isMergeNode && task.execution?.prStatus && (
        <div className="flex items-center justify-between">
          <span className="text-sm text-gray-400">PR Status</span>
          <span className="text-xs text-gray-200" data-testid="pr-status-text">
            {task.execution.prStatus}
          </span>
        </div>
      )}

      {/* Executor type selector */}
      {onEditType && !task.config.isMergeNode && (
        <div className="flex items-center justify-between">
          <span className="text-sm text-gray-400">Executor</span>
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

      {/* Task type + content */}
      {(task.config.prompt || task.config.command) && (
        <div>
          <div className="flex items-center justify-between">
            <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
              task.config.prompt
                ? 'bg-blue-900/40 text-blue-300'
                : 'bg-gray-700 text-gray-300'
            }`}>
              {task.config.prompt ? 'Claude Task' : 'Command'}
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

        {task.status === 'awaiting_approval' && (
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

        {task.status === 'completed' && task.execution.branch && onNotifyBranchUpdated && (
          <button
            onClick={() => onNotifyBranchUpdated(task.id)}
            className="w-full px-4 py-2 bg-orange-600 hover:bg-orange-500 text-white rounded text-sm font-medium transition-colors"
            data-testid="notify-branch-updated-btn"
          >
            Branch Updated
          </button>
        )}
      </div>
    </div>
  );
}
