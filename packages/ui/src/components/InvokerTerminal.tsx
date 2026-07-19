import { useState } from 'react';
import type { FormEvent, ReactElement } from 'react';
import type { InAppPlanningSessionSummary } from '../types.js';

export interface InvokerTerminalProps {
  collapsed: boolean;
  onToggle: () => void;
  planningSession?: InAppPlanningSessionSummary | null;
  sending?: boolean;
  submitting?: boolean;
  error?: string | null;
  onSendMessage?: (message: string) => void | Promise<void>;
  onReviewDraft?: () => void;
  onSubmitDraft?: () => void;
  onOpenGraph?: () => void;
}

function formatDraftMeta(session: InAppPlanningSessionSummary): string {
  const summary = session.draftPlanSummary;
  if (!summary) return 'Draft plan ready';
  const workflowLabel = summary.workflowCount && summary.workflowCount > 1
    ? `${summary.workflowCount} workflows`
    : '1 workflow';
  const taskLabel = summary.taskCount === 1 ? '1 task' : `${summary.taskCount} tasks`;
  return `${summary.name} - ${workflowLabel}, ${taskLabel}`;
}

export function InvokerTerminal({
  collapsed,
  onToggle,
  planningSession,
  sending = false,
  submitting = false,
  error,
  onSendMessage,
  onReviewDraft,
  onSubmitDraft,
  onOpenGraph,
}: InvokerTerminalProps): ReactElement {
  const [message, setMessage] = useState('');
  const draftReady = Boolean(
    planningSession?.status !== 'submitted'
    && planningSession?.draftPlanAvailable
    && planningSession?.draftPlanSummary,
  );
  const canSubmitMessage = Boolean(onSendMessage && message.trim() && !sending && !submitting);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = message.trim();
    if (!trimmed || !onSendMessage || sending || submitting) return;
    setMessage('');
    void onSendMessage(trimmed);
  };

  return (
    <div className="border-t border-gray-800 bg-gray-950">
      <div className="flex items-center justify-between gap-3 border-b border-gray-800 px-3 py-2">
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

      {draftReady && planningSession && (
        <div
          data-testid="terminal-ready-bar"
          className="flex flex-wrap items-center justify-between gap-3 border-b border-emerald-900/70 bg-emerald-950/20 px-3 py-2"
        >
          <div className="min-w-0">
            <div className="text-xs font-medium text-emerald-100">Draft ready</div>
            <div className="truncate text-[11px] text-emerald-200/80">{formatDraftMeta(planningSession)}</div>
          </div>
          <div className="flex items-center gap-2">
            <button
              data-testid="terminal-review-draft"
              onClick={onReviewDraft}
              className="rounded bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500"
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
              onClick={onSubmitDraft}
              disabled={submitting}
              className="rounded border border-emerald-700 px-3 py-1.5 text-xs text-emerald-100 hover:bg-emerald-900/40 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {submitting ? 'Creating...' : 'Create workflow'}
            </button>
          </div>
        </div>
      )}

      {!collapsed && (
        <div className="h-40 overflow-hidden px-3 py-2 text-xs text-gray-400">
          <div className="flex h-full flex-col gap-2">
            <div className="min-h-0 flex-1 overflow-auto rounded border border-gray-800 bg-gray-900/70 p-2">
              {planningSession?.messages?.length ? (
                <div className="space-y-2">
                  {planningSession.messages.map((line) => (
                    <div key={line.id} className={line.tone === 'error' ? 'text-red-300' : line.tone === 'success' ? 'text-emerald-300' : 'text-gray-300'}>
                      <span className="mr-2 text-gray-500">{line.role}</span>
                      <span className="whitespace-pre-wrap">{line.text}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="flex h-full items-center justify-center text-gray-500">
                  Terminal drawer reserved for embedded shell/log surfaces.
                </div>
              )}
            </div>
            {error && <div className="text-[11px] text-red-300">{error}</div>}
            <form onSubmit={handleSubmit} className="flex items-center gap-2">
              <input
                aria-label="Planning prompt"
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                disabled={sending || submitting}
                className="min-w-0 flex-1 rounded border border-gray-700 bg-gray-900 px-2 py-1.5 text-xs text-gray-100 placeholder:text-gray-600 focus:border-blue-500 focus:outline-none disabled:opacity-60"
                placeholder="Ask Invoker to draft a workflow"
              />
              <button
                type="submit"
                disabled={!canSubmitMessage}
                className="rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {sending ? 'Sending...' : 'Send'}
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
