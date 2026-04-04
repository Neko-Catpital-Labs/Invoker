/**
 * MergeGateNode — Synthetic terminal node showing the merge/PR gate.
 *
 * Styled to match TaskNode cards so DAG visuals stay consistent.
 * Keeps dashed border to distinguish gate semantics.
 */

import { useState } from 'react';
import { Handle, Position } from '@xyflow/react';
import type { TaskStatus } from '../types.js';
import { getStatusColor, getEffectiveVisualStatus } from '../lib/colors.js';
import type { MergeGateKind } from '../lib/merge-gate.js';

interface MergeGateNodeData {
  taskId?: string;
  status: TaskStatus;
  /** Plan title only (no "… gate for" prefix). */
  label: string;
  gateKind: MergeGateKind;
  mergeMode?: 'manual' | 'automatic' | 'external_review';
  workflowId?: string;
  /** Set when merge gate was fixed with Claude — first approve clears this (orchestrator). */
  pendingFixError?: string;
  dimmed?: boolean;
  [key: string]: unknown;
}

interface MergeGateNodeProps {
  data: MergeGateNodeData;
}

const PRIMARY_LABEL: Record<MergeGateKind, string> = {
  external_review: 'Review',
  pull_request: 'Pull request',
  merge: 'Merge',
  workflow: 'Workflow',
};

export function MergeGateNode({ data }: MergeGateNodeProps) {
  const {
    status,
    label,
    gateKind,
    mergeMode = 'manual',
    workflowId,
    pendingFixError,
    dimmed: dataDimmed,
  } = data;
  const dimmed = dataDimmed ?? false;
  const visualStatus = getEffectiveVisualStatus(
    status,
    pendingFixError ? { pendingFixError } : undefined,
  );
  const colors = getStatusColor(visualStatus);
  const [error, setError] = useState<string | null>(null);

  /** mergeMode wins over gateKind so we never show "Pull request" + "Review" when workflow is external_review mode. */
  const effectiveGateKind: MergeGateKind = mergeMode === 'external_review' ? 'external_review' : gateKind;

  const handleApproveMerge = () => {
    if (workflowId && window.invoker?.approveMerge) {
      setError(null);
      window.invoker.approveMerge(workflowId).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        console.error('Failed to approve merge:', err);
      });
    }
  };

  const usePrIcon = effectiveGateKind === 'external_review' || effectiveGateKind === 'pull_request';
  const icon = usePrIcon ? (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M7 7v10m0-10a2 2 0 11-4 0 2 2 0 014 0zm10 10a2 2 0 104 0 2 2 0 00-4 0zm0 0V7a4 4 0 00-4-4H9" />
    </svg>
  ) : (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M7 7v10m0-10a2 2 0 11-4 0 2 2 0 014 0zm10 10a2 2 0 104 0 2 2 0 00-4 0zm0 0V9a4 4 0 00-4-4H9" />
    </svg>
  );

  const statusLabel =
    visualStatus === 'completed' ? 'COMPLETED' :
    visualStatus === 'fix_approval' ? 'APPROVE FIX' :
    visualStatus === 'review_ready' ? 'REVIEW READY' :
    visualStatus === 'awaiting_approval' ? 'APPROVE' :
    visualStatus === 'running' ? 'RUNNING' :
    visualStatus === 'failed' ? 'BLOCKED' :
    'PENDING';

  const mergeApproveLabel = effectiveGateKind === 'pull_request' ? 'Approve & Create PR'
    : effectiveGateKind === 'merge' ? 'Approve & Merge' : 'Approve';
  const approveLabel = pendingFixError ? 'Approve Fix' : mergeApproveLabel;

  return (
    <div
      className={`relative w-[264px] rounded-2xl border border-dashed px-5 py-4 transition-opacity duration-75 shadow-[0_6px_24px_rgba(0,0,0,0.28)] ${colors.bg} ${colors.border} ${dimmed ? 'opacity-20 pointer-events-none' : ''}`}
      title={label}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!w-2 !h-2 !bg-slate-500/90 !border !border-slate-900"
      />

      <span
        className={`absolute left-0 top-0 bottom-0 w-1.5 rounded-l-2xl ${colors.dot} ${visualStatus === 'pending' ? 'pulse-strong' : ''}`}
      />

      <div className={`flex items-center gap-2 pl-3 ${colors.text}`}>
        {icon}
        <span className="font-mono text-sm font-semibold" data-testid="merge-gate-primary-label">
          {PRIMARY_LABEL[effectiveGateKind]}
        </span>
      </div>

      <div className={`text-2xl font-medium truncate mt-1 pl-3 ${colors.text}`}>
        {label}
      </div>

      <div className="flex items-center gap-1.5 mt-1 pl-3">
        <span
          className={`w-2 h-2 rounded-full ${colors.dot} ${visualStatus === 'pending' ? 'pulse-strong' : ''}`}
        />
        <span className={`text-sm uppercase tracking-wide ${colors.text}`}>{statusLabel}</span>
      </div>

      {mergeMode === 'manual' && (status === 'review_ready' || status === 'awaiting_approval') && (
        <button
          onClick={handleApproveMerge}
          data-testid="approve-merge-button"
          className="mt-2 w-full px-2 py-1 text-xs font-semibold text-white bg-green-600 hover:bg-green-700 rounded transition-colors"
        >
          {approveLabel}
        </button>
      )}

      {error && (
        <div
          data-testid="merge-error"
          className="mt-1 px-2 py-1 text-xs text-red-400 bg-red-900/30 rounded break-words"
          title={error}
        >
          {error}
        </div>
      )}

      <Handle
        type="source"
        position={Position.Right}
        className="!w-2 !h-2 !bg-slate-500/90 !border !border-slate-900"
      />
    </div>
  );
}
