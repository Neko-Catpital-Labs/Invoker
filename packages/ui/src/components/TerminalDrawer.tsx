import { useEffect, useMemo, useRef, useState } from 'react';

interface TerminalDrawerProps {
  collapsed: boolean;
  onToggle: () => void;
}

interface PlanningPreset {
  key: string;
  label: string;
}

interface PlanningDraftSummary {
  name: string;
  taskCount: number;
  steps: string[];
}

interface PlanningChatSession {
  id: string;
  title: string;
  status: string;
  presetKey?: string;
  messages?: PlanningTranscriptEntry[];
  draftPlanAvailable?: boolean;
}

interface PlanningChatResponse {
  ok: boolean;
  sessionId: string;
  reply: string;
  draftPlanAvailable: boolean;
  draftPlanSummary?: PlanningDraftSummary;
}

interface PlanningChatStreamEvent {
  sessionId: string;
  chunk: string;
}

interface PlanningApi {
  getPlanningPresets?: () => Promise<PlanningPreset[]>;
  planningChatCreate?: (request: { presetKey: string }) => Promise<{ ok: boolean; session: PlanningChatSession }>;
  planningChatSend?: (request: { sessionId?: string; message: string; presetKey: string }) => Promise<PlanningChatResponse>;
  planningChatSubmit?: (request: { sessionId: string }) => Promise<{ ok: boolean; planName?: string; workflowId?: string }>;
  planningChatReset?: (request?: { sessionId?: string }) => Promise<{ ok: boolean }>;
  onPlanningChatStream?: (callback: (event: PlanningChatStreamEvent) => void) => () => void;
}

type PlanningTranscriptEntry = {
  role: 'user' | 'assistant' | 'system';
  content: string;
};

export function TerminalDrawer({ collapsed, onToggle }: TerminalDrawerProps): JSX.Element {
  const [activeTab, setActiveTab] = useState<'planning' | 'terminal' | 'logs' | 'problems'>('terminal');
  const [presets, setPresets] = useState<PlanningPreset[]>([{ key: 'codex', label: 'Codex' }]);
  const [presetKey, setPresetKey] = useState('codex');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<PlanningTranscriptEntry[]>([]);
  const [input, setInput] = useState('');
  const [sendPending, setSendPending] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [draftSummary, setDraftSummary] = useState<PlanningDraftSummary | null>(null);
  const [submittedPlanName, setSubmittedPlanName] = useState<string | null>(null);
  const [streamSessionId, setStreamSessionId] = useState<string | null>(null);
  const [streamChunks, setStreamChunks] = useState<string[]>([]);
  const sendPendingRef = useRef(false);
  const sessionIdRef = useRef<string | null>(null);

  const planningApi = useMemo(() => {
    if (typeof window === 'undefined') return undefined;
    return window.invoker as unknown as PlanningApi | undefined;
  }, []);

  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  useEffect(() => {
    sendPendingRef.current = sendPending;
  }, [sendPending]);

  useEffect(() => {
    let cancelled = false;
    planningApi?.getPlanningPresets?.()
      .then((loadedPresets) => {
        if (cancelled || loadedPresets.length === 0) return;
        setPresets(loadedPresets);
        setPresetKey((current) => loadedPresets.some((preset) => preset.key === current) ? current : loadedPresets[0].key);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [planningApi]);

  useEffect(() => {
    const unsubscribe = planningApi?.onPlanningChatStream?.((event) => {
      const activeSessionId = sessionIdRef.current;
      if (activeSessionId && event.sessionId !== activeSessionId && !sendPendingRef.current) return;
      if (!activeSessionId && !sendPendingRef.current) return;
      setStreamSessionId(event.sessionId);
      setStreamChunks((chunks) => [...chunks, event.chunk]);
    });
    return () => {
      unsubscribe?.();
    };
  }, [planningApi]);

  const openPlanning = () => {
    setActiveTab('planning');
    if (collapsed) onToggle();
  };

  const handleNewPlanningSession = async () => {
    sessionIdRef.current = null;
    sendPendingRef.current = false;
    setSessionId(null);
    setTranscript([]);
    setInput('');
    setSendPending(false);
    setSubmitted(false);
    setDraftSummary(null);
    setSubmittedPlanName(null);
    setStreamSessionId(null);
    setStreamChunks([]);
    await planningApi?.planningChatReset?.({ sessionId: sessionId ?? undefined }).catch(() => undefined);
  };

  const handlePlanningSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const message = input.trim();
    if (!message || sendPending || submitted || !planningApi?.planningChatSend) return;

    setInput('');
    sendPendingRef.current = true;
    setSendPending(true);
    setDraftSummary(null);
    setStreamSessionId(null);
    setStreamChunks([]);
    setTranscript((entries) => [...entries, { role: 'user', content: message }]);

    try {
      const response = await planningApi.planningChatSend({
        ...(sessionId ? { sessionId } : {}),
        message,
        presetKey,
      });
      if (!response.ok) return;
      sessionIdRef.current = response.sessionId;
      setSessionId(response.sessionId);
      setStreamSessionId(null);
      setStreamChunks([]);
      setTranscript((entries) => [...entries, { role: 'assistant', content: response.reply }]);
      setDraftSummary(response.draftPlanAvailable ? response.draftPlanSummary ?? {
        name: 'Draft plan',
        taskCount: 0,
        steps: [],
      } : null);
    } finally {
      sendPendingRef.current = false;
      setSendPending(false);
    }
  };

  const handleSubmitToInvoker = async () => {
    if (!sessionId || !planningApi?.planningChatSubmit) return;
    const result = await planningApi.planningChatSubmit({ sessionId });
    if (!result.ok) return;
    const planName = result.planName ?? draftSummary?.name ?? 'Draft plan';
    setSubmitted(true);
    setSubmittedPlanName(planName);
    setDraftSummary(null);
    setStreamSessionId(null);
    setStreamChunks([]);
    setTranscript((entries) => [
      ...entries,
      { role: 'system', content: `Plan "${planName}" submitted to Invoker. Review it, then use Start ready work.` },
    ]);
  };

  const planningDisabled = submitted || sendPending;
  const streamText = streamChunks.join('');

  return (
    <div className="border-t border-gray-800 bg-gray-950">
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-800">
        <div className="flex items-center gap-3 text-xs text-gray-300">
          <button
            data-testid="sidebar-planning"
            className={activeTab === 'planning' ? 'text-white' : 'hover:text-white'}
            onClick={openPlanning}
          >
            Planning
          </button>
          <button
            className={activeTab === 'terminal' ? 'text-white' : 'hover:text-white'}
            onClick={() => setActiveTab('terminal')}
          >
            Terminal
          </button>
          <button
            className={activeTab === 'logs' ? 'text-white' : 'hover:text-white'}
            onClick={() => setActiveTab('logs')}
          >
            Logs
          </button>
          <button
            className={activeTab === 'problems' ? 'text-white' : 'hover:text-white'}
            onClick={() => setActiveTab('problems')}
          >
            Problems
          </button>
        </div>
        <button
          onClick={onToggle}
          aria-label={collapsed ? 'Expand terminal drawer' : 'Collapse terminal drawer'}
          className="rounded border border-gray-700 px-2 py-1 text-[11px] text-gray-300 hover:bg-gray-800"
        >
          {collapsed ? 'Expand' : 'Minimize'}
        </button>
      </div>
      {!collapsed && (
        activeTab === 'planning' ? (
          <div className="h-72 px-3 py-2 text-xs text-gray-300 overflow-auto">
            <div className="mb-2 flex items-center justify-between gap-2">
              <select
                data-testid="invoker-terminal-harness"
                value={presetKey}
                disabled={planningDisabled}
                onChange={(event) => setPresetKey(event.target.value)}
                className="rounded border border-gray-700 bg-gray-900 px-2 py-1 text-xs text-gray-100 disabled:opacity-60"
              >
                {presets.map((preset) => (
                  <option key={preset.key} value={preset.key}>{preset.label}</option>
                ))}
              </select>
              <button
                type="button"
                onClick={handleNewPlanningSession}
                className="rounded border border-gray-700 px-2 py-1 text-[11px] text-gray-200 hover:bg-gray-800"
              >
                New
              </button>
            </div>

            <div data-testid="invoker-terminal-transcript" className="mb-2 max-h-28 space-y-1 overflow-auto rounded border border-gray-800 bg-gray-900 p-2">
              {transcript.length === 0 ? (
                <div className="text-gray-500">No planning messages yet.</div>
              ) : (
                transcript.map((entry, index) => (
                  <div key={`${entry.role}-${index}`} className={entry.role === 'user' ? 'text-sky-200' : entry.role === 'system' ? 'text-emerald-200' : 'text-gray-100'}>
                    {entry.content}
                  </div>
                ))
              )}
              {submittedPlanName && (
                <span className="sr-only">{submittedPlanName}</span>
              )}
            </div>

            {streamText && streamSessionId && (
              <div
                data-testid="invoker-terminal-planner-stream"
                data-state="streaming"
                className="mb-2 rounded border border-blue-700/60 bg-blue-950/40 p-2 text-blue-100"
              >
                {streamText}
              </div>
            )}

            {draftSummary && !submitted && (
              <div data-testid="invoker-terminal-ready-bar" className="mb-2 flex items-center justify-between gap-2 rounded border border-emerald-700/70 bg-emerald-950/40 px-2 py-1.5 text-emerald-100">
                <span>{draftSummary.name}</span>
                <button
                  type="button"
                  onClick={handleSubmitToInvoker}
                  className="rounded bg-emerald-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-emerald-500"
                >
                  Submit to Invoker
                </button>
              </div>
            )}

            <form onSubmit={handlePlanningSubmit} className="flex gap-2">
              <textarea
                data-testid="invoker-terminal-input"
                value={input}
                disabled={planningDisabled}
                onChange={(event) => setInput(event.target.value)}
                className="h-16 flex-1 resize-none rounded border border-gray-700 bg-gray-900 px-2 py-1 text-xs text-gray-100 disabled:opacity-60"
              />
              <button
                type="submit"
                disabled={planningDisabled || input.trim().length === 0}
                className="self-start rounded bg-gray-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-gray-600 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Send
              </button>
            </form>
          </div>
        ) : (
          <div className="h-40 px-3 py-2 text-xs text-gray-400 overflow-auto">
            Terminal drawer reserved for embedded shell/log surfaces.
          </div>
        )
      )}
    </div>
  );
}
