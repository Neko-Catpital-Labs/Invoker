import type { InAppPlanningSessionSummary } from '../types.js';

export interface InvokerTerminalProps {
  collapsed: boolean;
  draftReadySessions?: InAppPlanningSessionSummary[];
  submitPendingSessionId?: string | null;
  onToggle: () => void;
  onReviewDraft?: (sessionId: string) => void;
  onCreateWorkflow?: (sessionId: string) => void;
  onOpenGraph?: () => void;
}

function draftName(session: InAppPlanningSessionSummary): string {
  return session.draftPlanSummary?.name ?? session.title;
}

function draftTaskLabel(session: InAppPlanningSessionSummary): string {
  const taskCount = session.draftPlanSummary?.taskCount ?? 0;
  const workflowCount = session.draftPlanSummary?.workflowCount ?? 0;
  if (workflowCount > 1) {
    return `${workflowCount} workflows, ${taskCount} tasks`;
  }
  if (taskCount === 1) return '1 task';
  return `${taskCount} tasks`;
}

export function InvokerTerminal({
  collapsed,
  draftReadySessions = [],
  submitPendingSessionId,
  onToggle,
  onReviewDraft,
  onCreateWorkflow,
  onOpenGraph,
}: InvokerTerminalProps): JSX.Element {
  const primaryDraft = draftReadySessions[0] ?? null;
  const hasReadyDraft = Boolean(primaryDraft);
  const isSubmitting = Boolean(primaryDraft && submitPendingSessionId === primaryDraft.id);

  return (
    <div className="border-t border-gray-800 bg-gray-950">
      <div className="flex items-center justify-between border-b border-gray-800 px-3 py-2">
        <div className="flex items-center gap-3 text-xs text-gray-300">
          <button className="hover:text-white">Terminal</button>
          <button className="hover:text-white">Logs</button>
          <button className="hover:text-white">Problems</button>
        </div>
        <button
          onClick={onToggle}
          aria-label={collapsed ? 'Expand terminal drawer' : 'Collapse terminal drawer'}
          className="rounded border border-gray-700 px-2 py-1 text-[11px] text-gray-300 hover:bg-gray-800"
        >
          {collapsed ? 'Expand' : 'Minimize'}
        </button>
      </div>

      {hasReadyDraft && primaryDraft && (
        <div
          data-testid="terminal-ready-bar"
          className="flex flex-wrap items-center justify-between gap-3 border-b border-emerald-800/60 bg-emerald-950/30 px-3 py-2"
        >
          <div className="min-w-0">
            <div className="text-[11px] font-medium uppercase tracking-wide text-emerald-300">
              Draft ready
            </div>
            <div className="truncate text-xs text-gray-100" title={draftName(primaryDraft)}>
              {draftName(primaryDraft)}
            </div>
            <div className="text-[11px] text-gray-400">
              {draftTaskLabel(primaryDraft)}
              {draftReadySessions.length > 1 ? ` | ${draftReadySessions.length} drafts ready` : ''}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              data-testid="terminal-review-draft"
              onClick={() => onReviewDraft?.(primaryDraft.id)}
              className="rounded bg-emerald-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-600"
            >
              Review draft
            </button>
            <button
              data-testid="terminal-open-graph"
              onClick={onOpenGraph}
              className="rounded border border-gray-700 px-3 py-1.5 text-xs text-gray-200 hover:bg-gray-800"
            >
              Open graph
            </button>
            <button
              data-testid="terminal-create-workflow"
              onClick={() => onCreateWorkflow?.(primaryDraft.id)}
              disabled={isSubmitting}
              className="rounded border border-emerald-700 px-3 py-1.5 text-xs text-emerald-200 hover:bg-emerald-950 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isSubmitting ? 'Creating...' : 'Create workflow'}
            </button>
          </div>
        </div>
      )}

      {!collapsed && (
        <div className="h-40 overflow-auto px-3 py-2 text-xs text-gray-400">
          Terminal drawer reserved for embedded shell/log surfaces.
        </div>
      )}
    </div>
  );
}
