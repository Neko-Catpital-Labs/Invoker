import type { InAppPlanningSessionSummary } from '../types.js';

export interface InvokerTerminalProps {
  collapsed: boolean;
  onToggle: () => void;
  readyDraftSession: InAppPlanningSessionSummary | null;
  submittingSessionId: string | null;
  planningError: string | null;
  submitError: string | null;
  onReviewDraft: (session: InAppPlanningSessionSummary) => void;
  onCreateWorkflow: (session: InAppPlanningSessionSummary) => void;
  onOpenGraph: () => void;
  onRefreshPlanningSessions: () => void;
}

export function InvokerTerminal({
  collapsed,
  onToggle,
  readyDraftSession,
  submittingSessionId,
  planningError,
  submitError,
  onReviewDraft,
  onCreateWorkflow,
  onOpenGraph,
  onRefreshPlanningSessions,
}: InvokerTerminalProps): JSX.Element {
  const isSubmittingReadyDraft = Boolean(
    readyDraftSession && submittingSessionId === readyDraftSession.id,
  );

  return (
    <div className="border-t border-gray-800 bg-gray-950">
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-800">
        <div className="flex items-center gap-3 text-xs text-gray-300">
          <button className="hover:text-white">Terminal</button>
          <button className="hover:text-white">Logs</button>
          <button className="hover:text-white">Problems</button>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={onRefreshPlanningSessions}
            className="rounded border border-gray-700 px-2 py-1 text-[11px] text-gray-300 hover:bg-gray-800"
          >
            Sync drafts
          </button>
          <button
            onClick={onToggle}
            aria-label={collapsed ? 'Expand terminal drawer' : 'Collapse terminal drawer'}
            className="rounded border border-gray-700 px-2 py-1 text-[11px] text-gray-300 hover:bg-gray-800"
          >
            {collapsed ? 'Expand' : 'Minimize'}
          </button>
        </div>
      </div>

      {readyDraftSession && (
        <div
          data-testid="terminal-ready-bar"
          className="flex flex-wrap items-center justify-between gap-3 border-b border-emerald-900/60 bg-emerald-950/30 px-3 py-2"
        >
          <div className="min-w-0">
            <div className="truncate text-xs font-medium text-emerald-100">
              Draft plan ready
            </div>
            <div className="truncate text-[11px] text-emerald-300/80">
              {readyDraftSession.draftPlanSummary?.name ?? readyDraftSession.title}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              data-testid="ready-bar-review-draft"
              onClick={() => onReviewDraft(readyDraftSession)}
              className="rounded bg-emerald-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-emerald-500"
            >
              Review draft
            </button>
            <button
              data-testid="ready-bar-create-workflow"
              onClick={() => onCreateWorkflow(readyDraftSession)}
              disabled={isSubmittingReadyDraft}
              className="rounded border border-emerald-700 px-2.5 py-1.5 text-xs font-medium text-emerald-100 hover:bg-emerald-900/60 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isSubmittingReadyDraft ? 'Creating...' : 'Create workflow'}
            </button>
            <button
              data-testid="ready-bar-open-graph"
              onClick={onOpenGraph}
              className="rounded border border-gray-700 px-2.5 py-1.5 text-xs text-gray-200 hover:bg-gray-800"
            >
              Open graph
            </button>
          </div>
        </div>
      )}

      {(planningError || submitError) && (
        <div className="border-b border-red-900/60 bg-red-950/30 px-3 py-2 text-xs text-red-200">
          {submitError ?? planningError}
        </div>
      )}

      {!collapsed && (
        <div className="h-40 px-3 py-2 text-xs text-gray-400 overflow-auto">
          Terminal drawer reserved for embedded shell/log surfaces.
        </div>
      )}
    </div>
  );
}
