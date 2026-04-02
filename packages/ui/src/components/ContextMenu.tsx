/**
 * ContextMenu — Right-click context menu for task nodes in the DAG.
 *
 * Positioned absolutely at the click coordinates.
 * Closes on click-outside or Escape.
 */

import { useEffect, useRef } from 'react';
import type { TaskState } from '../types.js';
import {
  isExperimentSpawnPivotTask,
  EXPERIMENT_SPAWN_PIVOT_OPEN_TERMINAL_MESSAGE,
} from '../isExperimentSpawnPivot.js';

interface ContextMenuProps {
  x: number;
  y: number;
  task: TaskState;
  onRestart: (taskId: string) => void;
  onReplace: (taskId: string) => void;
  onOpenTerminal: (taskId: string) => void;
  onRebaseAndRetry?: (taskId: string) => void;
  onRetryWorkflow?: (workflowId: string) => void;
  onRecreateWorkflow?: (workflowId: string) => void;
  onDeleteWorkflow?: (workflowId: string) => void;
  onFix?: (taskId: string, agentName: string) => void;
  onCancel?: (taskId: string) => void;
  onClose: () => void;
}

export function ContextMenu({ x, y, task, onRestart, onReplace, onOpenTerminal, onRebaseAndRetry, onRetryWorkflow, onRecreateWorkflow, onDeleteWorkflow, onFix, onCancel, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const canRestart = true;
  const canReplace = task.status === 'failed' || task.status === 'blocked';
  const canRebaseAndRetry = !!task.config.workflowId && !!onRebaseAndRetry;
  const canRetryWorkflow = !!task.config.workflowId && !!onRetryWorkflow;
  const canRecreateWorkflow = !!task.config.workflowId && !!onRecreateWorkflow;
  const canDeleteWorkflow = !!task.config.workflowId && !!onDeleteWorkflow;
  const canFix = task.status === 'failed' && !!onFix;
  const canCancel = task.status !== 'completed' && task.status !== 'stale' && !!onCancel;
  const canOpenTerminal = !isExperimentSpawnPivotTask(task);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };

    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [onClose]);

  return (
    <div
      ref={menuRef}
      className="fixed z-50 bg-gray-800 border border-gray-600 rounded-lg shadow-xl py-1 min-w-[160px]"
      style={{ left: x, top: y }}
    >
      <button
        className={`w-full text-left px-3 py-1.5 text-sm ${
          canRestart
            ? 'text-gray-100 hover:bg-gray-700'
            : 'text-gray-500 cursor-not-allowed'
        }`}
        onClick={() => { if (canRestart) onRestart(task.id); }}
        disabled={!canRestart}
      >
        Restart Task
      </button>
      <button
        className={`w-full text-left px-3 py-1.5 text-sm ${
          canReplace
            ? 'text-gray-100 hover:bg-gray-700'
            : 'text-gray-500 cursor-not-allowed'
        }`}
        onClick={() => { if (canReplace) onReplace(task.id); }}
        disabled={!canReplace}
      >
        Replace with...
      </button>
      <button
        className={`w-full text-left px-3 py-1.5 text-sm ${
          canOpenTerminal
            ? 'text-gray-100 hover:bg-gray-700'
            : 'text-gray-500 cursor-not-allowed'
        }`}
        onClick={() => {
          if (canOpenTerminal) onOpenTerminal(task.id);
        }}
        disabled={!canOpenTerminal}
        title={canOpenTerminal ? undefined : EXPERIMENT_SPAWN_PIVOT_OPEN_TERMINAL_MESSAGE}
      >
        Open Terminal
      </button>
      {canFix && (
        <>
          <div className="border-t border-gray-600 my-1" />
          <button
            className="w-full text-left px-3 py-1.5 text-sm text-blue-300 hover:bg-gray-700"
            onClick={() => onFix!(task.id, 'claude')}
          >
            Fix with Claude
          </button>
          <button
            className="w-full text-left px-3 py-1.5 text-sm text-blue-300 hover:bg-gray-700"
            onClick={() => onFix!(task.id, 'codex')}
          >
            Fix with Codex
          </button>
        </>
      )}
      {canRebaseAndRetry && (
        <>
          <div className="border-t border-gray-600 my-1" />
          <button
            className="w-full text-left px-3 py-1.5 text-sm text-yellow-300 hover:bg-gray-700"
            onClick={() => onRebaseAndRetry!(task.id)}
          >
            Rebase &amp; Retry
          </button>
        </>
      )}
      {canRetryWorkflow && (
        <>
          <div className="border-t border-gray-600 my-1" />
          <button
            className="w-full text-left px-3 py-1.5 text-sm text-yellow-300 hover:bg-gray-700"
            onClick={() => onRetryWorkflow!(task.config.workflowId!)}
          >
            Retry Workflow (keep completed)
          </button>
        </>
      )}
      {canRecreateWorkflow && (
        <>
          {!canRetryWorkflow && <div className="border-t border-gray-600 my-1" />}
          <button
            className="w-full text-left px-3 py-1.5 text-sm text-red-300 hover:bg-gray-700"
            onClick={() => onRecreateWorkflow!(task.config.workflowId!)}
          >
            Recreate Workflow
          </button>
        </>
      )}
      {canDeleteWorkflow && (
        <>
          <div className="border-t border-gray-600 my-1" />
          <button
            className="w-full text-left px-3 py-1.5 text-sm text-red-400 hover:bg-gray-700"
            onClick={() => onDeleteWorkflow!(task.config.workflowId!)}
          >
            Delete Workflow
          </button>
        </>
      )}
      {canCancel && (
        <button
          className="w-full text-left px-3 py-1.5 text-sm text-red-300 hover:bg-gray-700 rounded"
          onClick={() => { onCancel!(task.id); }}
        >
          Cancel Task (+ dependents)
        </button>
      )}
    </div>
  );
}
