import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { useInvoker } from '../hooks/useInvoker.js';
import type {
  InAppPlanningChatResponse,
  InAppPlanningChatLine,
  InAppPlanningSessionStatus,
  InAppPlanningSessionSummary,
  InAppPlanningSubmitResponse,
} from '../types.js';

interface InvokerTerminalProps {
  collapsed: boolean;
  onToggle: () => void;
  onReviewDraft: (session: InAppPlanningSessionSummary) => void;
  onOpenGraph: () => void;
  onCreateWorkflow: (session: InAppPlanningSessionSummary) => Promise<InAppPlanningSubmitResponse | undefined>;
  onDraftSessionChange?: (session: InAppPlanningSessionSummary) => void;
  submittedDraftSessionId?: string | null;
}

function isDraftReady(session: InAppPlanningSessionSummary | undefined): session is InAppPlanningSessionSummary {
  return Boolean(session && session.status !== 'submitted' && session.draftPlanAvailable);
}

function upsertSession(
  sessions: InAppPlanningSessionSummary[],
  session: InAppPlanningSessionSummary,
): InAppPlanningSessionSummary[] {
  const existingIndex = sessions.findIndex((candidate) => candidate.id === session.id);
  if (existingIndex < 0) return [session, ...sessions];
  const next = [...sessions];
  next[existingIndex] = session;
  return next;
}

function selectActiveSession(
  sessions: InAppPlanningSessionSummary[],
  activeSessionId: string | null,
): InAppPlanningSessionSummary | undefined {
  const active = activeSessionId ? sessions.find((session) => session.id === activeSessionId) : undefined;
  return active ?? sessions.find(isDraftReady) ?? sessions[0];
}

function clearDraftReadyState(
  session: InAppPlanningSessionSummary,
  result?: Extract<InAppPlanningSubmitResponse, { ok: true }>,
): InAppPlanningSessionSummary {
  return {
    ...session,
    status: 'submitted',
    draftPlanAvailable: false,
    draftPlanSummary: undefined,
    draftPlanText: undefined,
    submittedPlanName: result?.planName ?? session.submittedPlanName,
    submittedWorkflowId: result?.workflowId ?? session.submittedWorkflowId,
    updatedAt: new Date().toISOString(),
  };
}

function sessionFromChatResponse(
  baseSession: InAppPlanningSessionSummary | undefined,
  response: Extract<InAppPlanningChatResponse, { ok: true }>,
  message: string,
): InAppPlanningSessionSummary {
  const now = new Date().toISOString();
  const baseMessages = baseSession?.messages ?? [];
  const lastMessageId = baseMessages.reduce((max, line) => Math.max(max, line.id), 0);
  const messages: InAppPlanningChatLine[] = [
    ...baseMessages,
    { id: lastMessageId + 1, role: 'user', text: message, createdAt: now },
    { id: lastMessageId + 2, role: 'assistant', text: response.reply, createdAt: now },
  ];
  const status: InAppPlanningSessionStatus = response.draftPlanAvailable ? 'draft_ready' : 'still_discussing';
  return {
    id: response.sessionId,
    title: (baseSession?.title ?? message.slice(0, 64)) || 'Untitled plan',
    status,
    presetKey: baseSession?.presetKey ?? 'default',
    messages,
    draftPlanAvailable: response.draftPlanAvailable,
    draftPlanSummary: response.draftPlanSummary,
    draftPlanText: response.draftPlanText,
    submittedWorkflowId: baseSession?.submittedWorkflowId,
    submittedPlanName: baseSession?.submittedPlanName,
    createdAt: baseSession?.createdAt ?? now,
    updatedAt: now,
  };
}

export function InvokerTerminal({
  collapsed,
  onToggle,
  onReviewDraft,
  onOpenGraph,
  onCreateWorkflow,
  onDraftSessionChange,
  submittedDraftSessionId,
}: InvokerTerminalProps): JSX.Element {
  const invoker = useInvoker();
  const [sessions, setSessions] = useState<InAppPlanningSessionSummary[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!invoker) return;
    let cancelled = false;
    invoker.planningChatList()
      .then((response) => {
        if (cancelled) return;
        if (response.sessions.length === 0) return;
        setSessions(response.sessions);
        setActiveSessionId((current) => selectActiveSession(response.sessions, current)?.id ?? null);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [invoker]);

  useEffect(() => {
    if (!submittedDraftSessionId) return;
    setSessions((current) => current.map((session) => (
      session.id === submittedDraftSessionId ? clearDraftReadyState(session) : session
    )));
  }, [submittedDraftSessionId]);

  const activeSession = useMemo(
    () => selectActiveSession(sessions, activeSessionId),
    [activeSessionId, sessions],
  );
  const readySession = isDraftReady(activeSession) ? activeSession : undefined;

  const replaceSession = useCallback((session: InAppPlanningSessionSummary) => {
    setSessions((current) => upsertSession(current, session));
    setActiveSessionId(session.id);
    onDraftSessionChange?.(session);
  }, [onDraftSessionChange]);

  const handleSubmitMessage = useCallback(async (event: FormEvent) => {
    event.preventDefault();
    if (!invoker || busy) return;
    const trimmed = message.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      const response = await invoker.planningChatSend({
        ...(activeSession?.id ? { sessionId: activeSession.id } : {}),
        message: trimmed,
        presetKey: activeSession?.presetKey,
      });
      if (!response.ok) {
        setError(response.error);
        return;
      }

      const fetched = await invoker.planningChatGet({ sessionId: response.sessionId }).catch(() => null);
      const nextSession = fetched?.ok
        ? fetched.session
        : sessionFromChatResponse(activeSession, response, trimmed);
      replaceSession(nextSession);
      setMessage('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [activeSession, busy, invoker, message, replaceSession]);

  const handleCreateWorkflow = useCallback(async () => {
    if (!isDraftReady(activeSession) || busy) return;
    const session = activeSession;
    setBusy(true);
    setError(null);
    try {
      const result = await onCreateWorkflow(session);
      if (!result) return;
      if (!result.ok) {
        setError(result.error);
        return;
      }
      replaceSession(clearDraftReadyState(session, result));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [activeSession, busy, onCreateWorkflow, replaceSession]);

  return (
    <div className="border-t border-gray-800 bg-gray-950">
      <div className="flex items-center justify-between gap-3 border-b border-gray-800 px-3 py-2">
        <div className="flex shrink-0 items-center gap-3 text-xs text-gray-300">
          <button type="button" className="hover:text-white">Terminal</button>
          <button type="button" className="hover:text-white">Planning</button>
          <button type="button" className="hover:text-white">Problems</button>
        </div>

        {readySession && (
          <div
            data-testid="terminal-ready-bar"
            className="flex min-w-0 flex-1 items-center justify-end gap-2 text-xs"
          >
            <span className="hidden min-w-0 truncate text-gray-400 sm:block" title={readySession.draftPlanSummary?.name ?? readySession.title}>
              Draft ready: {readySession.draftPlanSummary?.name ?? readySession.title}
            </span>
            <button
              type="button"
              data-testid="terminal-review-draft"
              onClick={() => onReviewDraft(readySession)}
              className="rounded bg-blue-700 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-blue-600"
            >
              Review draft
            </button>
            <button
              type="button"
              data-testid="terminal-create-workflow"
              onClick={() => void handleCreateWorkflow()}
              disabled={busy}
              className="rounded bg-green-700 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-green-600 disabled:cursor-not-allowed disabled:opacity-60"
            >
              Create workflow
            </button>
            <button
              type="button"
              data-testid="terminal-open-graph"
              onClick={onOpenGraph}
              className="rounded border border-gray-700 px-2.5 py-1 text-[11px] text-gray-300 hover:bg-gray-800"
            >
              Open graph
            </button>
          </div>
        )}

        <button
          type="button"
          onClick={onToggle}
          aria-label={collapsed ? 'Expand terminal drawer' : 'Collapse terminal drawer'}
          className="shrink-0 rounded border border-gray-700 px-2 py-1 text-[11px] text-gray-300 hover:bg-gray-800"
        >
          {collapsed ? 'Expand' : 'Minimize'}
        </button>
      </div>

      {!collapsed && (
        <div className="grid h-48 grid-cols-[minmax(0,1fr)_260px] border-b border-gray-900 text-xs">
          <div className="flex min-w-0 flex-col">
            <div className="flex-1 space-y-2 overflow-auto px-3 py-2">
              {activeSession?.messages.length ? (
                activeSession.messages.map((line) => (
                  <div key={line.id} className={line.role === 'user' ? 'text-gray-100' : line.tone === 'error' ? 'text-red-300' : 'text-gray-400'}>
                    <span className="mr-2 text-[11px] uppercase text-gray-600">{line.role}</span>
                    <span className="whitespace-pre-wrap">{line.text}</span>
                  </div>
                ))
              ) : (
                <div className="text-gray-500">Describe a workflow goal to draft a plan.</div>
              )}
              {error && (
                <div className="rounded border border-red-900 bg-red-950/40 px-2 py-1.5 text-red-200">
                  {error}
                </div>
              )}
            </div>
            <form onSubmit={handleSubmitMessage} className="flex items-end gap-2 border-t border-gray-800 px-3 py-2">
              <textarea
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                placeholder="Ask Invoker to draft a plan..."
                rows={2}
                className="min-h-10 flex-1 resize-none rounded border border-gray-700 bg-gray-900 px-2 py-1.5 text-xs text-gray-100 outline-none focus:border-blue-500"
              />
              <button
                type="submit"
                disabled={busy || !message.trim()}
                className="rounded bg-gray-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-gray-600 disabled:cursor-not-allowed disabled:opacity-60"
              >
                Send
              </button>
            </form>
          </div>

          <aside className="border-l border-gray-800 px-3 py-2">
            <div className="text-[11px] font-medium uppercase tracking-wide text-gray-500">Planning sessions</div>
            <div className="mt-2 space-y-1">
              {sessions.length > 0 ? sessions.slice(0, 5).map((session) => (
                <button
                  key={session.id}
                  type="button"
                  onClick={() => setActiveSessionId(session.id)}
                  className={`w-full rounded px-2 py-1.5 text-left text-[11px] ${session.id === activeSession?.id ? 'bg-gray-800 text-gray-100' : 'text-gray-400 hover:bg-gray-900'}`}
                >
                  <span className="block truncate">{session.draftPlanSummary?.name ?? session.title}</span>
                  <span className="block text-[10px] text-gray-600">{session.status.replaceAll('_', ' ')}</span>
                </button>
              )) : (
                <div className="text-[11px] text-gray-600">No planning sessions yet.</div>
              )}
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}
