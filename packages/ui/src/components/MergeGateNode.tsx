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
  [key: string]: unknown;
}

interface MergeGateNodeProps {
  data: MergeGateNodeData;
}

export function MergeGateNode({ data }: MergeGateNodeProps) {
  const { status, label, onFinish, baseBranch } = data;
  const colors = getStatusColor(status);

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

      <div className="flex items-center gap-1.5 mt-1">
        <span
          className={`w-2 h-2 rounded-full ${colors.dot} ${status === 'pending' ? 'animate-pulse' : ''}`}
        />
        <span className={`text-xs uppercase ${colors.text}`}>{statusLabel}</span>
      </div>
    </div>
  );
}
