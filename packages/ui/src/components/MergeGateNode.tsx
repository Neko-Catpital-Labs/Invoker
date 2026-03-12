/**
 * MergeGateNode — Synthetic terminal node showing the merge/PR gate.
 *
 * Visually distinct from TaskNode: smaller, different accent.
 * Status reflects whether all tasks passed (merge proceeds) or any failed (merge blocked).
 * Branch display is read-only; editing happens in TaskPanel.
 */

import { Handle, Position } from '@xyflow/react';
import type { TaskStatus } from '../types.js';
import { getStatusColor } from '../lib/colors.js';

interface MergeGateNodeData {
  status: TaskStatus;
  label: string;
  onFinish: 'merge' | 'pull_request';
  baseBranch?: string;
  mergeMode?: 'manual' | 'automatic';
  workflowId?: string;
  [key: string]: unknown;
}

interface MergeGateNodeProps {
  data: MergeGateNodeData;
}

export function MergeGateNode({ data }: MergeGateNodeProps) {
  const { status, label, onFinish, baseBranch, mergeMode = 'manual', workflowId } = data;
  const colors = getStatusColor(status);

  const handleApproveMerge = () => {
    if (workflowId && window.invoker?.approveMerge) {
      window.invoker.approveMerge(workflowId).catch((err) => {
        console.error('Failed to approve merge:', err);
      });
    }
  };

  const icon = onFinish === 'pull_request' ? (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M7 7v10m0-10a2 2 0 11-4 0 2 2 0 014 0zm10 10a2 2 0 104 0 2 2 0 00-4 0zm0 0V7a4 4 0 00-4-4H9" />
    </svg>
  ) : (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M7 7v10m0-10a2 2 0 11-4 0 2 2 0 014 0zm10 10a2 2 0 104 0 2 2 0 00-4 0zm0 0V9a4 4 0 00-4-4H9" />
    </svg>
  );

  const statusLabel =
    status === 'completed' ? 'READY' :
    status === 'awaiting_approval' ? 'NEEDS APPROVAL' :
    status === 'failed' ? 'BLOCKED' :
    'WAITING';

  return (
    <div className={`rounded-lg border-2 border-dashed px-3 py-2 w-[200px] ${colors.bg} ${colors.border}`}>
      <Handle type="target" position={Position.Left} className="!bg-gray-500" />

      <div className={`flex items-center gap-1.5 ${colors.text}`}>
        {icon}
        <span className="font-mono text-xs font-semibold uppercase">
          {onFinish === 'pull_request' ? 'Pull Request' : 'Merge'}
        </span>
      </div>

      <div className={`text-xs mt-1 ${colors.text} opacity-80`}>
        {label}
      </div>

      <div className="flex items-center gap-1 mt-1" data-testid="merge-branch-display">
        <svg className="w-3 h-3 text-gray-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" />
        </svg>
        <span
          data-testid="merge-branch-label"
          className="text-xs font-mono text-gray-400 truncate"
          title={baseBranch ?? 'default'}
        >
          {baseBranch ?? 'default'}
        </span>
      </div>

      <div className="flex items-center gap-1 mt-1" data-testid="merge-mode-display">
        {mergeMode === 'manual' ? (
          <svg className="w-3 h-3 text-yellow-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
          </svg>
        ) : (
          <svg className="w-3 h-3 text-green-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        )}
        <span
          data-testid="merge-mode-label"
          className={`text-xs font-mono ${mergeMode === 'manual' ? 'text-yellow-500' : 'text-green-500'}`}
        >
          {mergeMode === 'manual' ? 'Manual' : 'Automatic'}
        </span>
      </div>

      <div className="flex items-center gap-1.5 mt-1">
        <span
          className={`w-2 h-2 rounded-full ${colors.dot} ${status === 'pending' ? 'animate-pulse' : ''}`}
        />
        <span className={`text-xs uppercase ${colors.text}`}>{statusLabel}</span>
      </div>

      {mergeMode === 'manual' && status === 'awaiting_approval' && (
        <button
          onClick={handleApproveMerge}
          data-testid="approve-merge-button"
          className="mt-2 w-full px-2 py-1 text-xs font-semibold text-white bg-green-600 hover:bg-green-700 rounded transition-colors"
        >
          Approve Merge
        </button>
      )}
    </div>
  );
}
