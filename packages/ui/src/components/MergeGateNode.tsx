/**
 * MergeGateNode — Synthetic terminal node showing the merge/PR gate.
 *
 * Visually distinct from TaskNode: smaller, different accent.
 * Status reflects whether all tasks passed (merge proceeds) or any failed (merge blocked).
 * Branch display is read-only; editing happens in TaskPanel.
 */

import { useState } from 'react';
import { Handle, Position } from '@xyflow/react';
import type { TaskStatus } from '../types.js';
import { getStatusColor, getEffectiveVisualStatus } from '../lib/colors.js';
import type { MergeGateKind } from '../lib/merge-gate.js';

interface MergeGateNodeData {
  status: TaskStatus;
  /** Plan title only (no "… gate for" prefix). */
  label: string;
  gateKind: MergeGateKind;
  /** When false, omit Manual/Automatic/GitHub row (used for github_pr — primary already says GitHub PR). */
  showMergeModeRow?: boolean;
  baseBranch?: string;
  featureBranch?: string;
  mergeMode?: 'manual' | 'automatic' | 'github';
  workflowId?: string;
  prUrl?: string;
  prStatus?: string;
  summary?: string;
  /** Set when merge gate was fixed with Claude — first approve clears this (orchestrator). */
  pendingFixError?: string;
  dimmed?: boolean;
  [key: string]: unknown;
}

interface MergeGateNodeProps {
  data: MergeGateNodeData;
}

const PRIMARY_LABEL: Record<MergeGateKind, string> = {
  github_pr: 'GitHub PR',
  pull_request: 'Pull request',
  merge: 'Merge',
  workflow: 'Workflow',
};

export function MergeGateNode({ data }: MergeGateNodeProps) {
  const {
    status,
    label,
    gateKind,
    showMergeModeRow = true,
    baseBranch,
    featureBranch,
    mergeMode = 'manual',
    workflowId,
    prUrl,
    prStatus,
    summary,
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

  /** mergeMode wins over gateKind so we never show "Pull request" + "GitHub PR" when workflow is GitHub mode. */
  const effectiveGateKind: MergeGateKind = mergeMode === 'github' ? 'github_pr' : gateKind;
  const shouldShowMergeModeRow =
    showMergeModeRow && mergeMode !== 'github' && effectiveGateKind !== 'github_pr';

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

  const usePrIcon = effectiveGateKind === 'github_pr' || effectiveGateKind === 'pull_request';
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
    visualStatus === 'awaiting_approval' ? 'NEEDS APPROVAL' :
    visualStatus === 'failed' ? 'BLOCKED' :
    'WAITING';

  const mergeApproveLabel = effectiveGateKind === 'pull_request' ? 'Approve & Create PR'
    : effectiveGateKind === 'merge' ? 'Approve & Merge' : 'Approve';
  const approveLabel = pendingFixError ? 'Approve Fix' : mergeApproveLabel;

  return (
    <div className={`rounded-lg border-2 border-dashed px-3 py-2 w-[200px] transition-opacity duration-200 ${colors.bg} ${colors.border} ${dimmed ? 'opacity-20 pointer-events-none' : ''}`}>
      <Handle type="target" position={Position.Left} className="!bg-gray-500" />

      <div className={`flex items-center gap-1.5 ${colors.text}`}>
        {icon}
        <span className="font-mono text-xs font-semibold" data-testid="merge-gate-primary-label">
          {PRIMARY_LABEL[effectiveGateKind]}
        </span>
      </div>

      <div
        className={`text-xs mt-1 ${colors.text} opacity-80 truncate`}
        title={typeof label === 'string' ? label : undefined}
      >
        {label}
      </div>

      <div className="flex items-center gap-1 mt-1">
        <svg className="w-3 h-3 text-gray-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M7 7v10m0-10a2 2 0 11-4 0 2 2 0 014 0zm10 10a2 2 0 104 0 2 2 0 00-4 0zm0 0V7a4 4 0 00-4-4H9" />
        </svg>
        <span className="text-xs font-mono text-gray-400 truncate" title={featureBranch ?? 'current'}>
          {featureBranch ?? 'current'}
        </span>
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

      {shouldShowMergeModeRow && (
        <div className="flex items-center gap-1 mt-1" data-testid="merge-mode-display">
          {mergeMode === 'github' ? (
            <svg className="w-3 h-3 text-blue-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M7 7v10m0-10a2 2 0 11-4 0 2 2 0 014 0zm10 10a2 2 0 104 0 2 2 0 00-4 0zm0 0V7a4 4 0 00-4-4H9" />
            </svg>
          ) : mergeMode === 'manual' ? (
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
            className={`text-xs font-mono ${mergeMode === 'github' ? 'text-blue-400' : mergeMode === 'manual' ? 'text-yellow-500' : 'text-green-500'}`}
          >
            {mergeMode === 'github' ? 'GitHub PR' : mergeMode === 'manual' ? 'Manual' : 'Automatic'}
          </span>
        </div>
      )}

      <div className="flex items-center gap-1.5 mt-1">
        <span
          className={`w-2 h-2 rounded-full ${colors.dot} ${visualStatus === 'pending' ? 'animate-pulse' : ''}`}
        />
        <span className={`text-xs uppercase ${colors.text}`}>{statusLabel}</span>
      </div>

      {summary && (
        <div
          className="mt-1 text-xs text-gray-400 line-clamp-2 cursor-help"
          title={summary}
          data-testid="merge-summary-preview"
        >
          {summary.length > 120 ? summary.slice(0, 120) + '...' : summary}
        </div>
      )}

      {mergeMode === 'manual' && status === 'awaiting_approval' && (
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
    </div>
  );
}
