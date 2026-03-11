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
import { getStatusColor } from '../lib/colors.js';

interface TaskPanelProps {
  task: TaskState | null;
  onProvideInput: (task: TaskState) => void;
  onApprove: (task: TaskState) => void;
  onReject: (task: TaskState) => void;
  onSelectExperiment: (task: TaskState) => void;
  onEditCommand?: (taskId: string, newCommand: string) => void;
  onEditType?: (taskId: string, familiarType: string) => void;
}

function formatDate(date?: Date | string): string {
  if (!date) return '--';
  const d = typeof date === 'string' ? new Date(date) : date;
  return d.toLocaleTimeString();
}

export function TaskPanel({
  task,
  onProvideInput,
  onApprove,
  onReject,
  onSelectExperiment,
  onEditCommand,
  onEditType,
}: TaskPanelProps) {
  const [isEditingCommand, setIsEditingCommand] = useState(false);
  const [editCommandValue, setEditCommandValue] = useState('');

  useEffect(() => {
    setIsEditingCommand(false);
    setEditCommandValue(task?.command ?? '');
  }, [task?.id]);

  if (!task) {
    return (
      <div className="h-full flex items-center justify-center text-gray-500 p-4">
        <p>Select a task from the graph to view details</p>
      </div>
    );
  }

  const canEditCommand = task.command !== undefined && task.status !== 'running' && onEditCommand;

  const handleSaveCommand = () => {
    if (onEditCommand && editCommandValue !== task.command) {
      onEditCommand(task.id, editCommandValue);
    }
    setIsEditingCommand(false);
  };

  const handleCancelEdit = () => {
    setEditCommandValue(task.command ?? '');
    setIsEditingCommand(false);
  };

  const colors = getStatusColor(task.status);

  return (
    <div className="h-full overflow-y-auto p-4 space-y-4">
      {/* Header */}
      <div>
        <h2 className="text-lg font-semibold text-gray-100 truncate">
          {task.description}
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
          {task.status.toUpperCase().replace('_', ' ')}
        </span>
      </div>

      {/* Executor type selector */}
      {onEditType && (
        <div className="flex items-center justify-between">
          <span className="text-sm text-gray-400">Executor</span>
          <select
            value={task.familiarType ?? 'worktree'}
            onChange={(e) => onEditType(task.id, e.target.value)}
            disabled={task.status === 'running'}
            className="bg-gray-700 text-gray-200 text-xs rounded px-2 py-1 border border-gray-600 focus:outline-none focus:border-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
            data-testid="executor-type-select"
          >
            <option value="worktree">Worktree</option>
            <option value="docker">Docker</option>
          </select>
        </div>
      )}

      {/* Task type + content */}
      {(task.prompt || task.command) && (
        <div>
          <div className="flex items-center justify-between">
            <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
              task.prompt
                ? 'bg-blue-900/40 text-blue-300'
                : 'bg-gray-700 text-gray-300'
            }`}>
              {task.prompt ? 'Claude Task' : 'Command'}
            </span>
            {canEditCommand && !isEditingCommand && (
              <button
                onClick={() => {
                  setEditCommandValue(task.command ?? '');
                  setIsEditingCommand(true);
                }}
                className="text-xs text-gray-400 hover:text-gray-200 transition-colors"
                data-testid="edit-command-btn"
              >
                Edit
              </button>
            )}
          </div>

          {isEditingCommand && task.command !== undefined ? (
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
            <div className={`mt-2 rounded p-3 text-xs select-text cursor-text ${
              task.prompt
                ? 'bg-blue-900/20 border border-blue-800'
                : 'bg-gray-800 border border-gray-700'
            }`}>
              {task.prompt ? (
                <p className="text-gray-300 whitespace-pre-wrap">{task.prompt}</p>
              ) : (
                <code className="text-green-300 font-mono whitespace-pre-wrap">{task.command}</code>
              )}
            </div>
          )}
        </div>
      )}

      {/* Timing */}
      <div className="space-y-1 text-sm">
        <div className="flex justify-between">
          <span className="text-gray-400">Created</span>
          <span className="text-gray-200">{formatDate(task.createdAt)}</span>
        </div>
        {task.startedAt && (
          <div className="flex justify-between">
            <span className="text-gray-400">Started</span>
            <span className="text-gray-200">{formatDate(task.startedAt)}</span>
          </div>
        )}
        {task.completedAt && (
          <div className="flex justify-between">
            <span className="text-gray-400">Completed</span>
            <span className="text-gray-200">{formatDate(task.completedAt)}</span>
          </div>
        )}
      </div>

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
      {(task.error || (task.exitCode !== undefined && task.exitCode !== 0)) && (
        <div className="bg-red-900/30 border border-red-700 rounded p-3">
          <h3 className="text-sm font-medium text-red-400 mb-1">Error</h3>
          {task.error && (
            <p className="text-xs text-red-300 whitespace-pre-wrap">{task.error}</p>
          )}
          {task.exitCode !== undefined && (
            <p className="text-xs text-red-400 mt-1">Exit code: {task.exitCode}</p>
          )}
        </div>
      )}

      {/* Input prompt */}
      {task.inputPrompt && task.status === 'needs_input' && (
        <div className="bg-amber-900/30 border border-amber-700 rounded p-3">
          <h3 className="text-sm font-medium text-amber-400 mb-1">Input Required</h3>
          <p className="text-xs text-amber-300">{task.inputPrompt}</p>
        </div>
      )}

      {/* Blocked info */}
      {task.blockedBy && (
        <div className="bg-gray-700/50 border border-gray-600 rounded p-3">
          <h3 className="text-sm font-medium text-gray-400 mb-1">Blocked By</h3>
          <p className="text-xs text-gray-300">{task.blockedBy}</p>
        </div>
      )}

      {/* Git info */}
      {(task.branch || task.commit) && (
        <div className="space-y-1 text-sm">
          {task.branch && (
            <div className="flex justify-between">
              <span className="text-gray-400">Branch</span>
              <span className="text-gray-200 font-mono text-xs">{task.branch}</span>
            </div>
          )}
          {task.commit && (
            <div className="flex justify-between">
              <span className="text-gray-400">Commit</span>
              <span className="text-gray-200 font-mono text-xs">
                {task.commit.slice(0, 8)}
              </span>
            </div>
          )}
        </div>
      )}

      {/* Summary */}
      {task.summary && (
        <div>
          <h3 className="text-sm font-medium text-gray-300 mb-1">Summary</h3>
          <p className="text-xs text-gray-400 whitespace-pre-wrap">{task.summary}</p>
        </div>
      )}

      {/* Experiment results */}
      {task.experimentResults && task.experimentResults.length > 0 && (
        <div>
          <h3 className="text-sm font-medium text-gray-300 mb-1">Experiment Results</h3>
          <div className="space-y-1">
            {task.experimentResults.map((result) => (
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
        {task.status === 'needs_input' && !task.isReconciliation && (
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
              Approve
            </button>
            <button
              onClick={() => onReject(task)}
              className="flex-1 px-4 py-2 bg-red-600 hover:bg-red-500 text-white rounded text-sm font-medium transition-colors"
            >
              Reject
            </button>
          </div>
        )}

        {task.isReconciliation && task.status === 'needs_input' && (
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
