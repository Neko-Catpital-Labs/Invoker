/**
 * MergeGateNode — Synthetic terminal node showing the merge/PR gate.
 *
 * Styled to match TaskNode cards so DAG visuals stay consistent.
 * Keeps dashed border to distinguish gate semantics.
 */

import { Handle, Position } from '@xyflow/react';
import type { TaskStatus } from '../types.js';
import { getStatusColor, getEffectiveVisualStatus } from '../lib/colors.js';
import type { MergeGateKind } from '../lib/merge-gate.js';
import { GitMergeIcon, GitPullRequestIcon } from './icons/index.js';

interface MergeGateNodeData {
  taskId?: string;
  status: TaskStatus;
  /** Plan title only (no "… gate for" prefix). */
  label: string;
  gateKind: MergeGateKind;
  mergeMode?: 'manual' | 'automatic' | 'external_review';
  /** Set when merge gate was fixed with Claude — first approve clears this (orchestrator). */
  pendingFixError?: string;
  dimmed?: boolean;
  selected?: boolean;
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
    pendingFixError,
    dimmed: dataDimmed,
    selected: dataSelected,
  } = data;
  const dimmed = dataDimmed ?? false;
  const selected = dataSelected ?? false;
  const visualStatus = getEffectiveVisualStatus(
    status,
    pendingFixError ? { pendingFixError } : undefined,
  );
  const colors = getStatusColor(visualStatus);

  /** mergeMode wins over gateKind so we never show "Pull request" + "Review" when workflow is external_review mode. */
  const effectiveGateKind: MergeGateKind = mergeMode === 'external_review' ? 'external_review' : gateKind;

  const usePrIcon = effectiveGateKind === 'external_review' || effectiveGateKind === 'pull_request';
  const IconComponent = usePrIcon ? GitPullRequestIcon : GitMergeIcon;

  const statusLabel =
    visualStatus === 'completed' ? 'Completed' :
    visualStatus === 'fix_approval' ? 'Approve fix' :
    visualStatus === 'review_ready' ? 'Review ready' :
    visualStatus === 'awaiting_approval' ? 'Approve' :
    visualStatus === 'running' ? 'Running' :
    visualStatus === 'closed' ? 'Closed' :
    visualStatus === 'failed' ? 'Blocked' :
    'Pending';

  return (
    <div
      className={`relative w-[167px] rounded-xl border border-dashed px-2 py-2 transition-[opacity,box-shadow,border-color] duration-75 shadow-sm ${colors.bg} ${colors.border} ${selected ? 'ring-1 ring-ring/60 shadow-md' : ''} ${dimmed ? 'opacity-20 pointer-events-none' : ''}`}
      title={label}
      data-selected={selected ? 'true' : 'false'}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!w-2 !h-2 !bg-slate-500/90 !border !border-slate-900"
      />

      <span
        className={`absolute left-0 top-0 bottom-0 w-[2px] rounded-l-xl ${colors.dot} ${visualStatus === 'pending' ? 'pulse-strong' : ''}`}
      />

      <div className={`flex items-center gap-1.5 pl-2 ${colors.text}`}>
        <IconComponent className="w-3 h-3" />
        <span className="font-mono text-[8px] font-semibold uppercase tracking-wide" data-testid="merge-gate-primary-label">
          {PRIMARY_LABEL[effectiveGateKind]}
        </span>
      </div>

      <div className={`text-[11px] font-medium truncate mt-0.5 pl-2 text-card-foreground`}>
        {label}
      </div>

      <div className="flex items-center gap-1 mt-0.5 pl-2">
        <span
          className={`w-1 h-1 rounded-full ${colors.dot} ${visualStatus === 'pending' ? 'pulse-strong' : ''}`}
        />
        <span className={`text-[8px] tracking-wide ${colors.text}`}>{statusLabel}</span>
      </div>

      <Handle
        type="source"
        position={Position.Right}
        className="!w-2 !h-2 !bg-slate-500/90 !border !border-slate-900"
      />
    </div>
  );
}
