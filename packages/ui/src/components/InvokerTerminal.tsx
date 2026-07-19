import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactElement,
} from 'react';

export interface InvokerTerminalLine {
  id: number;
  text: string;
  role: 'user' | 'assistant' | 'system';
  reasoning?: string;
  tone?: 'muted' | 'error' | 'success';
}

export type PlanningTerminalMode = 'chat' | 'tmux';

export interface InvokerTerminalPlanningStream {
  text: string;
  status: 'streaming' | 'failed';
}

interface PlanningPresetOptionView {
  key: string;
  label: string;
}

interface SubmitErrorView {
  title: string;
  message: string;
}

interface TerminalSessionView {
  sessionId: string;
  status?: string;
  outputSnapshot?: string;
}

interface InvokerTerminalProps {
  lines: InvokerTerminalLine[];
  busy: boolean;
  value: string;
  selectedPresetKey: string;
  presetOptions: PlanningPresetOptionView[];
  draftPlanAvailable: boolean;
  draftPlanSummary?: {
    name: string;
    taskCount: number;
    workflowCount?: number;
    taskGroups?: { workflow: string | null; tasks: string[] }[];
  };
  planningStream?: InvokerTerminalPlanningStream | null;
  submitError?: SubmitErrorView | null;
  readOnly?: boolean;
  expanded?: boolean;
  mode?: PlanningTerminalMode;
  terminalSession?: TerminalSessionView | null;
  terminalBusy?: boolean;
  terminalError?: string | null;
  onValueChange: (value: string) => void;
  onSubmit: () => void;
  onSubmitDraft: () => void;
  onPresetChange: (presetKey: string) => void;
  onModeChange?: (mode: PlanningTerminalMode) => void;
  onExpand: () => void;
  onCloseExpanded?: () => void;
  onCollapse?: () => void;
  activeConversationKey: string;
}

const TRANSCRIPT_BOTTOM_TOLERANCE_PX = 32;

function isTranscriptNearBottom(element: HTMLDivElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= TRANSCRIPT_BOTTOM_TOLERANCE_PX;
}

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function roundMs(durationMs: number): number {
  return Math.max(0, Math.round(durationMs));
}

function reportPlanningChatPerf(metric: string, data: Record<string, unknown>): void {
  void window.invoker?.reportUiPerf?.(metric, data);
}

function rolePrompt(role: InvokerTerminalLine['role']): string {
  if (role === 'user') return 'you >';
  if (role === 'assistant') return 'invoker >';
  return 'system >';
}

function formatDraftSummary(summary: NonNullable<InvokerTerminalProps['draftPlanSummary']> | undefined): string {
  if (!summary) return 'draft ready';
  const workflowPart = summary.workflowCount && summary.workflowCount > 1
    ? `${summary.workflowCount} workflows - `
    : '';
  const taskLabel = summary.taskCount === 1 ? 'task' : 'tasks';
  return `draft ready - "${summary.name}" - ${workflowPart}${summary.taskCount} ${taskLabel}`;
}

export const InvokerTerminal = memo(function InvokerTerminal({
  lines,
  busy,
  value,
  selectedPresetKey,
  presetOptions,
  draftPlanAvailable,
  draftPlanSummary,
  planningStream = null,
  submitError = null,
  readOnly = false,
  expanded = false,
  mode = 'chat',
  terminalSession = null,
  terminalBusy = false,
  terminalError = null,
  onValueChange,
  onSubmit,
  onSubmitDraft,
  onPresetChange,
  onModeChange,
  onExpand,
  onCloseExpanded,
  onCollapse,
  activeConversationKey,
}: InvokerTerminalProps): ReactElement {
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const [shouldFollowTranscript, setShouldFollowTranscript] = useState(true);
  const inputSequenceRef = useRef(0);
  const pendingInputRef = useRef<{
    sequence: number;
    startedAt: number;
    nextLength: number;
    previousLength: number;
  } | null>(null);
  const transcriptCommitRef = useRef<{ signature: string; lineCount: number } | null>(null);
  const renderStartedAt = nowMs();

  useLayoutEffect(() => {
    const pendingInput = pendingInputRef.current;
    if (!pendingInput || pendingInput.nextLength !== value.length) return;
    pendingInputRef.current = null;
    reportPlanningChatPerf('planning_chat_input_commit', {
      sequence: pendingInput.sequence,
      durationMs: roundMs(nowMs() - pendingInput.startedAt),
      valueLength: value.length,
      previousValueLength: pendingInput.previousLength,
      deltaLength: value.length - pendingInput.previousLength,
      conversationKey: activeConversationKey,
      transcriptLineCount: lines.length,
      expanded,
      busy,
      readOnly,
    });
  }, [activeConversationKey, busy, expanded, lines.length, readOnly, value]);

  useLayoutEffect(() => {
    const lastLine = lines.at(-1);
    const signature = [
      activeConversationKey,
      lines.length,
      lastLine?.id ?? 'none',
      lastLine?.role ?? 'none',
      lastLine?.text.length ?? 0,
      lastLine?.reasoning?.length ?? 0,
    ].join(':');
    const previous = transcriptCommitRef.current;
    transcriptCommitRef.current = { signature, lineCount: lines.length };
    if (previous?.signature === signature || (!previous && lines.length === 0)) return;

    const transcriptChars = lines.reduce((total, line) => total + line.text.length + (line.reasoning?.length ?? 0), 0);
    reportPlanningChatPerf('planning_chat_transcript_commit', {
      durationMs: roundMs(nowMs() - renderStartedAt),
      conversationKey: activeConversationKey,
      lineCount: lines.length,
      lineDelta: previous ? lines.length - previous.lineCount : lines.length,
      transcriptChars,
      lastLineRole: lastLine?.role,
      lastLineChars: lastLine?.text.length ?? 0,
      hasReasoning: Boolean(lastLine?.reasoning),
      busy,
      expanded,
      draftPlanAvailable,
      readOnly,
    });
  }, [activeConversationKey, busy, draftPlanAvailable, expanded, lines, readOnly, renderStartedAt]);

  useLayoutEffect(() => {
    if (!shouldFollowTranscript) return;
    const transcript = transcriptRef.current;
    if (!transcript) return;
    transcript.scrollTop = transcript.scrollHeight;
  }, [activeConversationKey, lines, planningStream?.text, shouldFollowTranscript]);

  useEffect(() => {
    setShouldFollowTranscript(true);
  }, [activeConversationKey]);

  useEffect(() => {
    if (mode === 'chat' && !busy && !readOnly) {
      inputRef.current?.focus();
    }
  }, [busy, mode, readOnly]);

  const focusComposer = useCallback((): void => {
    inputRef.current?.focus();
  }, []);

  const composerDisabledCursorClass = busy
    ? 'disabled:cursor-wait'
    : readOnly
      ? 'disabled:cursor-not-allowed'
      : '';

  const handleValueChange = (event: ChangeEvent<HTMLTextAreaElement>): void => {
    const startedAt = nowMs();
    const nextValue = event.target.value;
    const sequence = inputSequenceRef.current + 1;
    inputSequenceRef.current = sequence;
    pendingInputRef.current = {
      sequence,
      startedAt,
      nextLength: nextValue.length,
      previousLength: value.length,
    };
    onValueChange(nextValue);
    reportPlanningChatPerf('planning_chat_input_change', {
      sequence,
      handlerDurationMs: roundMs(nowMs() - startedAt),
      valueLength: nextValue.length,
      previousValueLength: value.length,
      deltaLength: nextValue.length - value.length,
      conversationKey: activeConversationKey,
      transcriptLineCount: lines.length,
      expanded,
      busy,
      readOnly,
    });
  };

  const submitFromComposer = (source: 'form' | 'enter'): void => {
    if (!value.trim() || busy || readOnly) return;
    reportPlanningChatPerf('planning_chat_submit', {
      source,
      valueLength: value.length,
      trimmedLength: value.trim().length,
      conversationKey: activeConversationKey,
      transcriptLineCount: lines.length,
      draftPlanAvailable,
      expanded,
    });
    onSubmit();
  };

  const handleFormSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    submitFromComposer('form');
  };

  const handleInputKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (
      event.key === 'Enter' &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing &&
      !busy &&
      !readOnly &&
      value.trim()
    ) {
      event.preventDefault();
      submitFromComposer('enter');
    }
  };

  const handleTranscriptScroll = useCallback((): void => {
    const transcript = transcriptRef.current;
    if (!transcript) return;
    setShouldFollowTranscript(isTranscriptNearBottom(transcript));
  }, []);

  const transcriptContent = useMemo(() => (
    <>
      {lines.map((line) => {
        const toneClass = line.tone === 'error'
          ? 'text-red-300'
          : line.tone === 'success'
            ? 'text-emerald-300'
            : line.tone === 'muted'
              ? 'text-gray-400'
              : line.role === 'assistant'
                ? 'text-gray-100'
                : 'text-gray-300';
        return (
          <div key={line.id} className="space-y-1">
            <div className="text-[11px] text-gray-500">{rolePrompt(line.role)}</div>
            {line.reasoning ? (
              <details
                data-testid="invoker-terminal-thinking"
                className="rounded border border-gray-700 bg-gray-900/70 px-2 py-1 text-gray-400"
              >
                <summary className="cursor-pointer select-none text-[11px] text-gray-400">
                  Thinking
                </summary>
                <div className="mt-1 whitespace-pre-wrap text-[12px] leading-5 text-gray-400">
                  {line.reasoning}
                </div>
              </details>
            ) : null}
            <div className={`whitespace-pre-wrap ${toneClass}`}>{line.text}</div>
          </div>
        );
      })}
      {planningStream?.text ? (
        <div
          data-testid="invoker-terminal-planner-stream"
          data-state={planningStream.status}
          className={`rounded border px-3 py-2 ${
            planningStream.status === 'failed'
              ? 'border-red-500/50 bg-red-950/30'
              : 'border-gray-700 bg-gray-900/70'
          }`}
        >
          <div className="flex items-center justify-between gap-3">
            <div className="text-[11px] text-gray-500">planner stream &gt;</div>
            <div className={`text-[11px] ${planningStream.status === 'failed' ? 'text-red-300' : 'text-gray-400'}`}>
              {planningStream.status === 'failed' ? 'failed' : 'live'}
            </div>
          </div>
          <div className={`mt-2 whitespace-pre-wrap ${planningStream.status === 'failed' ? 'text-red-300' : 'text-gray-100'}`}>
            {planningStream.text}
          </div>
        </div>
      ) : null}
    </>
  ), [lines, planningStream]);

  if (mode === 'tmux') {
    return (
      <section className="flex h-full min-h-0 flex-col bg-gray-950 text-gray-100">
        <TerminalHeader
          mode={mode}
          busy={busy}
          terminalBusy={terminalBusy}
          readOnly={readOnly}
          expanded={expanded}
          onModeChange={onModeChange}
          onExpand={onExpand}
          onCloseExpanded={onCloseExpanded}
          onCollapse={onCollapse}
        />
        <div
          data-testid="invoker-terminal-tmux-pane"
          data-session-id={terminalSession?.sessionId}
          className="flex min-h-0 flex-1 items-center justify-center bg-black px-4 text-center font-mono text-xs text-gray-400"
        >
          {terminalSession
            ? terminalSession.outputSnapshot ?? 'tmux session attached.'
            : terminalError ?? (terminalBusy ? 'Starting tmux session...' : 'No tmux session attached.')}
        </div>
      </section>
    );
  }

  return (
    <section className="flex h-full min-h-0 flex-col bg-gray-950 text-gray-100">
      <TerminalHeader
        mode={mode}
        busy={busy}
        terminalBusy={terminalBusy}
        readOnly={readOnly}
        expanded={expanded}
        onModeChange={onModeChange}
        onExpand={onExpand}
        onCloseExpanded={onCloseExpanded}
        onCollapse={onCollapse}
      />

      <div
        ref={transcriptRef}
        data-testid="invoker-terminal-transcript"
        onScroll={handleTranscriptScroll}
        className="min-h-0 flex-1 space-y-3 overflow-y-auto bg-gray-950 px-4 py-4 font-mono text-[13px] leading-6"
      >
        {transcriptContent}
      </div>

      {submitError && !readOnly && (
        <div
          data-testid="invoker-terminal-submit-error"
          className="sticky bottom-0 z-10 border-t border-red-500/40 bg-gray-950 px-4 py-3 text-red-100"
        >
          <div className="text-sm font-medium text-red-300">{submitError.title}</div>
          <div className="mt-2 whitespace-pre-wrap font-mono text-xs leading-5 text-red-200">{submitError.message}</div>
          <div className="mt-3 flex flex-wrap gap-2">
            {draftPlanAvailable && (
              <button
                type="button"
                onClick={onSubmitDraft}
                disabled={busy}
                className="rounded bg-red-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-400 disabled:cursor-wait disabled:opacity-50"
              >
                Retry submit
              </button>
            )}
            <button
              type="button"
              onClick={focusComposer}
              className="rounded border border-gray-700 px-3 py-1.5 text-xs text-gray-300 hover:border-gray-500 hover:text-white"
            >
              Keep chatting
            </button>
            <button
              type="button"
              onClick={() => void navigator.clipboard?.writeText(submitError.message)}
              className="rounded border border-gray-700 px-3 py-1.5 text-xs text-gray-300 hover:border-gray-500 hover:text-white"
            >
              Copy error
            </button>
          </div>
        </div>
      )}

      {draftPlanAvailable && !readOnly && (
        <div
          data-testid="invoker-terminal-ready-bar"
          className="sticky bottom-0 z-10 border-t border-gray-800 bg-gray-950 px-4 py-3 text-sm text-gray-100"
        >
          {draftPlanSummary?.taskGroups && draftPlanSummary.taskGroups.length > 0 && (
            <div
              data-testid="invoker-terminal-plan-tasks"
              className="mb-3 max-h-52 overflow-y-auto pr-1"
            >
              {draftPlanSummary.taskGroups.map((group, groupIndex) => (
                <div key={group.workflow ?? `group-${groupIndex}`} className="mb-2 last:mb-0">
                  {group.workflow ? (
                    <div className="text-xs font-semibold text-gray-100">{group.workflow}</div>
                  ) : null}
                  <ul className={group.workflow ? 'mt-0.5 border-l border-gray-700 pl-3' : ''}>
                    {group.tasks.map((task, taskIndex) => (
                      <li key={taskIndex} className="flex gap-2 text-xs text-gray-400">
                        <span aria-hidden="true">-</span>
                        <span>{task}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="font-mono text-xs text-gray-400">
              {formatDraftSummary(draftPlanSummary)}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onSubmitDraft}
                disabled={busy}
                className="rounded bg-blue-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-400 disabled:cursor-wait disabled:opacity-50"
              >
                Submit to Invoker
              </button>
              <button
                type="button"
                onClick={focusComposer}
                className="rounded border border-gray-700 px-3 py-1.5 text-xs text-gray-300 hover:border-gray-500 hover:text-white"
              >
                Keep chatting
              </button>
            </div>
          </div>
        </div>
      )}

      <form
        className="border-t border-gray-800 bg-gray-950 px-4 py-3"
        onSubmit={handleFormSubmit}
      >
        <div className="flex items-start gap-2">
          <span className="mt-2.5 shrink-0 font-mono text-xs text-gray-400" aria-hidden="true">&gt;</span>
          <textarea
            ref={inputRef}
            data-testid="invoker-terminal-input"
            value={value}
            disabled={busy || readOnly}
            rows={expanded ? 8 : 3}
            onChange={handleValueChange}
            onKeyDown={handleInputKeyDown}
            placeholder={readOnly ? 'This planning session was already submitted.' : 'Describe the change, ask questions, or say "draft the full plan".'}
            className={`min-h-20 w-full resize-none border-0 bg-transparent py-2 font-mono text-[13px] leading-6 text-gray-100 outline-none placeholder:text-gray-500 focus:ring-0 ${composerDisabledCursorClass}`}
          />
        </div>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
          <label className="flex items-center gap-2 font-mono text-xs text-gray-400">
            <span>Agent</span>
            <select
              aria-label="Agent"
              data-testid="invoker-terminal-harness"
              value={selectedPresetKey}
              onChange={(event) => onPresetChange(event.target.value)}
              disabled={readOnly}
              className="rounded border border-gray-700 bg-gray-950 px-2 py-1 text-xs text-gray-100 outline-none hover:border-gray-500 focus:border-blue-400 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {presetOptions.map((option) => (
                <option key={option.key} value={option.key}>{option.label}</option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            disabled={busy || readOnly || !value.trim()}
            className="rounded bg-blue-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-400 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Send
          </button>
        </div>
      </form>
    </section>
  );
});

interface TerminalHeaderProps {
  mode: PlanningTerminalMode;
  busy: boolean;
  terminalBusy: boolean;
  readOnly: boolean;
  expanded: boolean;
  onModeChange?: (mode: PlanningTerminalMode) => void;
  onExpand: () => void;
  onCloseExpanded?: () => void;
  onCollapse?: () => void;
}

function TerminalHeader({
  mode,
  busy,
  terminalBusy,
  readOnly,
  expanded,
  onModeChange,
  onExpand,
  onCloseExpanded,
  onCollapse,
}: TerminalHeaderProps): ReactElement {
  return (
    <div className="flex items-center justify-end gap-2 border-b border-gray-800 bg-gray-950 px-4 py-2.5">
      <div className="flex shrink-0 items-center gap-2">
        {onModeChange && (
          <div
            role="tablist"
            aria-label="Planning mode"
            data-testid="invoker-terminal-mode-toggle"
            className="inline-flex overflow-hidden rounded border border-gray-700"
          >
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'chat'}
              onClick={() => onModeChange('chat')}
              className={`px-2.5 py-1 text-xs ${mode === 'chat' ? 'bg-gray-800 text-gray-100' : 'text-gray-400 hover:bg-gray-800 hover:text-gray-100'}`}
            >
              Chat
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'tmux'}
              onClick={() => onModeChange('tmux')}
              className={`border-l border-gray-700 px-2.5 py-1 text-xs ${mode === 'tmux' ? 'bg-gray-800 text-gray-100' : 'text-gray-400 hover:bg-gray-800 hover:text-gray-100'}`}
            >
              tmux
            </button>
          </div>
        )}
        {mode === 'chat' && busy && (
          <span className="font-mono text-[11px] text-gray-400">working...</span>
        )}
        {mode === 'tmux' && terminalBusy && (
          <span className="font-mono text-[11px] text-gray-400">starting...</span>
        )}
        {mode === 'chat' && readOnly && (
          <span className="font-mono text-[11px] text-gray-400">submitted</span>
        )}
        {expanded ? (
          <button
            type="button"
            aria-label="Close planning chat"
            onClick={onCloseExpanded}
            className="rounded border border-gray-700 px-2.5 py-1 text-xs text-gray-400 hover:border-gray-500 hover:text-gray-100"
          >
            Close
          </button>
        ) : (
          <>
            {onCollapse && (
              <button
                type="button"
                aria-label="Collapse planning chat"
                onClick={onCollapse}
                className="rounded border border-gray-700 px-2.5 py-1 text-xs text-gray-400 hover:border-gray-500 hover:text-gray-100"
              >
                Collapse
              </button>
            )}
            <button
              type="button"
              aria-label="Expand planning chat"
              onClick={onExpand}
              className="rounded border border-gray-700 px-2.5 py-1 text-xs text-gray-400 hover:border-gray-500 hover:text-gray-100"
            >
              Expand
            </button>
          </>
        )}
      </div>
    </div>
  );
}
