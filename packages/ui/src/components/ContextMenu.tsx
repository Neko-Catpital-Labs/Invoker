/**
 * ContextMenu — Right-click context menu for task nodes in the DAG.
 *
 * Positioned absolutely at the click coordinates.
 * Closes on click-outside or Escape.
 */

import { useEffect, useRef } from 'react';
import type { TaskState } from '../types.js';

interface ContextMenuProps {
  x: number;
  y: number;
  task: TaskState;
  onRestart: (taskId: string) => void;
  onReplace: (taskId: string) => void;
  onOpenTerminal: (taskId: string) => void;
  onRebaseAndRetry?: (taskId: string) => void;
  onRestartWorkflow?: (workflowId: string) => void;
  onClose: () => void;
}

export function ContextMenu({ x, y, task, onRestart, onReplace, onOpenTerminal, onRebaseAndRetry, onRestartWorkflow, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const canRestart = task.status !== 'running';
  const canReplace = task.status === 'failed' || task.status === 'blocked';
  const canRebaseAndRetry = !!task.workflowId && !!onRebaseAndRetry;
  const canRestartWorkflow = !!task.workflowId && !!onRestartWorkflow;

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
        className="w-full text-left px-3 py-1.5 text-sm text-gray-100 hover:bg-gray-700"
        onClick={() => onOpenTerminal(task.id)}
      >
        Open Terminal
      </button>
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
      {canRestartWorkflow && (
        <>
          <div className="border-t border-gray-600 my-1" />
          <button
            className="w-full text-left px-3 py-1.5 text-sm text-red-300 hover:bg-gray-700"
            onClick={() => onRestartWorkflow!(task.workflowId!)}
          >
            Restart Workflow
          </button>
        </>
      )}
    </div>
  );
}
