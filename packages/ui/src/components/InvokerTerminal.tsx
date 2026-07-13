import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ChangeEvent, type FormEvent, type KeyboardEvent } from 'react';
import { Terminal as XTermTerminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import type { TerminalSessionDescriptor } from '@invoker/contracts';
import { Button } from './primitives/index.js';

export interface InvokerTerminalLine {
  id: number;
  text: string;
  role: 'user' | 'assistant' | 'system';
  reasoning?: string;
  tone?: 'muted' | 'error' | 'success';
}

export type PlanningTerminalMode = 'chat' | 'tmux';

interface PlanningPresetOptionView {
  key: string;
  label: string;
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

interface InvokerTerminalProps {
  lines: InvokerTerminalLine[];
  busy: boolean;
  value: string;
  selectedPresetKey: string;
  presetOptions: PlanningPresetOptionView[];
  draftPlanAvailable: boolean;
  draftPlanSummary?: { name: string; taskCount: number; workflowCount?: number };
  submitError?: SubmitErrorView | null;
  readOnly?: boolean;
  expanded?: boolean;
  mode?: PlanningTerminalMode;
  terminalSession?: TerminalSessionDescriptor | null;
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

interface SubmitErrorView {
  title: string;
  message: string;
}

function rolePrompt(role: InvokerTerminalLine['role']): string {
  if (role === 'user') return 'you ›';
  if (role === 'assistant') return 'invoker ›';
  return 'system ›';
}

type SeededOutputSnapshot = {
  sessionId: string;
  snapshot: string;
  term: XTermTerminal;
};

function seedTerminalOutputSnapshot(
  term: XTermTerminal,
  session: TerminalSessionDescriptor,
  seededSnapshotRef: { current: SeededOutputSnapshot | null },
): void {
  const outputSnapshot = session.outputSnapshot;
  const seededSnapshot = seededSnapshotRef.current;
  if (
    outputSnapshot &&
    (
      !seededSnapshot ||
      seededSnapshot.sessionId !== session.sessionId ||
      seededSnapshot.snapshot !== outputSnapshot ||
      seededSnapshot.term !== term
    )
  ) {
    try {
      term.write(outputSnapshot);
      seededSnapshotRef.current = {
        sessionId: session.sessionId,
        snapshot: outputSnapshot,
        term,
      };
    } catch (err) {
      console.warn(
        `Failed to seed output snapshot for planning terminal session ${session.sessionId}:`,
        err,
      );
    }
  }
}

interface PlanningTmuxPaneProps {
  session: TerminalSessionDescriptor | null;
  busy: boolean;
  error?: string | null;
}

function PlanningTmuxPane({ session, busy, error }: PlanningTmuxPaneProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<XTermTerminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const seededSnapshotRef = useRef<SeededOutputSnapshot | null>(null);

  useEffect(() => {
    const host = containerRef.current;
    if (!host || !session) return;

    let term: XTermTerminal;
    let fit: FitAddon;
    try {
      term = new XTermTerminal({
        fontSize: 12,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        cursorBlink: true,
        convertEol: false,
        scrollback: 5000,
        theme: { background: '#0b0f1a', foreground: '#e5e7eb' },
      });
      fit = new FitAddon();
      term.loadAddon(fit);
      term.open(host);
    } catch {
      return;
    }
    termRef.current = term;
    fitRef.current = fit;

    seedTerminalOutputSnapshot(term, session, seededSnapshotRef);

    const inputDisposable = term.onData((data) => {
      void window.invoker?.planningTerminalWrite?.(session.sessionId, data);
    });

    const subscribeToOutput = window.__INVOKER_TEST_ON_TERMINAL_OUTPUT__ ?? window.invoker?.onTerminalOutput;
    const unsubscribeOutput = subscribeToOutput?.((event) => {
      if (event.sessionId !== session.sessionId) return;
      try {
        term.write(event.data);
      } catch {
        /* terminal disposed */
      }
    });

    const tryFit = () => {
      try {
        fit.fit();
        void window.invoker?.planningTerminalResize?.(session.sessionId, term.cols, term.rows);
      } catch {
        /* host has zero size or fit unsupported */
      }
    };

    const raf = typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame(tryFit)
      : null;

    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      try {
        resizeObserver = new ResizeObserver(() => {
          tryFit();
        });
        resizeObserver.observe(host);
      } catch {
        resizeObserver = null;
      }
    }

    return () => {
      if (raf !== null && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(raf);
      }
      resizeObserver?.disconnect();
      inputDisposable.dispose();
      unsubscribeOutput?.();
      try {
        term.dispose();
      } catch {
        /* already disposed */
      }
      termRef.current = null;
      fitRef.current = null;
    };
  }, [session?.sessionId]);

  useEffect(() => {
    const term = termRef.current;
    if (!term || !session) return;
    seedTerminalOutputSnapshot(term, session, seededSnapshotRef);
  }, [session?.outputSnapshot, session?.sessionId]);

  useEffect(() => {
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit || !session) return;
    try {
      fit.fit();
      void window.invoker?.planningTerminalResize?.(session.sessionId, term.cols, term.rows);
      term.focus();
    } catch {
      /* fit failed (e.g., hidden) */
    }
  }, [session?.sessionId]);

  return (
    <div className="relative min-h-0 flex-1 overflow-hidden bg-black">
      {!session && (
        <div
          data-testid="invoker-terminal-tmux-placeholder"
          className="absolute inset-0 flex items-center justify-center px-4 text-center font-mono text-xs text-muted-foreground"
        >
          {error || (busy ? 'Starting tmux session…' : 'No tmux session attached.')}
        </div>
      )}
      {session && (
        <div
          ref={containerRef}
          data-testid="invoker-terminal-tmux-pane"
          data-session-id={session.sessionId}
          className="absolute inset-0 overflow-hidden"
        />
      )}
      {session?.status === 'exited' && (
        <div className="absolute right-3 top-3 rounded-sm border border-border bg-card px-2 py-1 font-mono text-[11px] text-amber-300">
          exited{typeof session.exitCode === 'number' ? ` ${session.exitCode}` : ''}
        </div>
      )}
      {session && error && (
        <div
          data-testid="invoker-terminal-tmux-error"
          className="absolute bottom-3 left-3 right-3 rounded-sm border border-destructive/40 bg-card px-3 py-2 font-mono text-xs text-destructive"
        >
          {error}
        </div>
      )}
    </div>
  );
}

export function InvokerTerminal({
  lines,
  busy,
  value,
  selectedPresetKey,
  presetOptions,
  draftPlanAvailable,
  draftPlanSummary,
  submitError,
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
}: InvokerTerminalProps): JSX.Element {
  const renderStartedAt = nowMs();
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const [shouldFollowTranscript, setShouldFollowTranscript] = useState(true);
  const inputSequenceRef = useRef(0);
  const latestLineCountRef = useRef(lines.length);
  const perfContextRef = useRef({ activeConversationKey, expanded });
  const pendingInputRef = useRef<{
    sequence: number;
    startedAt: number;
    nextLength: number;
    previousLength: number;
  } | null>(null);
  const transcriptCommitRef = useRef<{ signature: string; lineCount: number } | null>(null);
  latestLineCountRef.current = lines.length;
  perfContextRef.current = { activeConversationKey, expanded };

  const scrollTranscriptToBottom = useCallback((reason: 'conversation_change' | 'line_change', lineCount: number): void => {
    const transcript = transcriptRef.current;
    if (!transcript) return;
    const startedAt = nowMs();
    const context = perfContextRef.current;
    transcript.scrollTop = transcript.scrollHeight;
    reportPlanningChatPerf('planning_chat_transcript_autoscroll', {
      reason,
      durationMs: roundMs(nowMs() - startedAt),
      conversationKey: context.activeConversationKey,
      lineCount,
      scrollHeight: transcript.scrollHeight,
      clientHeight: transcript.clientHeight,
      expanded: context.expanded,
    });
  }, []);

  useLayoutEffect(() => {
    setShouldFollowTranscript(true);
    scrollTranscriptToBottom('conversation_change', latestLineCountRef.current);
  }, [activeConversationKey, scrollTranscriptToBottom]);

  useLayoutEffect(() => {
    if (shouldFollowTranscript) {
      scrollTranscriptToBottom('line_change', lines.length);
    }
  }, [lines.length, scrollTranscriptToBottom, shouldFollowTranscript]);

  useLayoutEffect(() => {
    const pending = pendingInputRef.current;
    if (!pending || pending.nextLength !== value.length) return;
    pendingInputRef.current = null;
    reportPlanningChatPerf('planning_chat_input_commit', {
      sequence: pending.sequence,
      durationMs: roundMs(nowMs() - pending.startedAt),
      valueLength: value.length,
      previousValueLength: pending.previousLength,
      deltaLength: value.length - pending.previousLength,
      conversationKey: activeConversationKey,
      transcriptLineCount: lines.length,
      expanded,
      busy,
      readOnly,
    });
  }, [activeConversationKey, busy, expanded, lines.length, readOnly, value]);

  useLayoutEffect(() => {
    const lastLine = lines.at(-1);
    const signature = `${activeConversationKey}:${lines.length}:${lastLine?.id ?? 'none'}:${lastLine?.role ?? 'none'}:${lastLine?.text.length ?? 0}:${lastLine?.reasoning?.length ?? 0}`;
    const previous = transcriptCommitRef.current;
    transcriptCommitRef.current = { signature, lineCount: lines.length };
    if (!previous || previous.signature === signature) return;
    const transcriptChars = lines.reduce((total, line) => total + line.text.length + (line.reasoning?.length ?? 0), 0);
    reportPlanningChatPerf('planning_chat_transcript_commit', {
      durationMs: roundMs(nowMs() - renderStartedAt),
      conversationKey: activeConversationKey,
      lineCount: lines.length,
      lineDelta: lines.length - previous.lineCount,
      transcriptChars,
      lastLineRole: lastLine?.role,
      lastLineChars: lastLine?.text.length ?? 0,
      hasReasoning: Boolean(lastLine?.reasoning),
      busy,
      expanded,
      draftPlanAvailable,
      readOnly,
    });
  }, [activeConversationKey, busy, draftPlanAvailable, expanded, lines, readOnly]);

  const handleTranscriptScroll = useCallback((): void => {
    const transcript = transcriptRef.current;
    if (!transcript) return;
    setShouldFollowTranscript(isTranscriptNearBottom(transcript));
  }, []);

  useEffect(() => {
    if (mode === 'chat' && !busy && !readOnly) {
      inputRef.current?.focus();
    }
  }, [busy, mode, readOnly]);

  const focusComposer = (): void => {
    inputRef.current?.focus();
  };

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
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && !busy && !readOnly && value.trim()) {
      event.preventDefault();
      submitFromComposer('enter');
    }
  };

  return (
    <section className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex items-center justify-end gap-2 border-b border-border bg-background px-4 py-2.5">
        <div className="flex shrink-0 items-center gap-2">
          {onModeChange && (
            <div
              role="tablist"
              aria-label="Planning mode"
              data-testid="invoker-terminal-mode-toggle"
              className="inline-flex overflow-hidden rounded-sm border border-border"
            >
              <button
                type="button"
                role="tab"
                aria-selected={mode === 'chat'}
                onClick={() => onModeChange('chat')}
                className={`px-2.5 py-1 text-xs ${mode === 'chat' ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground'}`}
              >
                Chat
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={mode === 'tmux'}
                onClick={() => onModeChange('tmux')}
                className={`border-l border-border px-2.5 py-1 text-xs ${mode === 'tmux' ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground'}`}
              >
                tmux
              </button>
            </div>
          )}
          {mode === 'chat' && busy && (
            <span className="font-mono text-[11px] text-muted-foreground">working…</span>
          )}
          {mode === 'tmux' && terminalBusy && (
            <span className="font-mono text-[11px] text-muted-foreground">starting…</span>
          )}
          {mode === 'chat' && readOnly && (
            <span className="font-mono text-[11px] text-muted-foreground">submitted</span>
          )}
          {expanded ? (
            <button
              type="button"
              aria-label="Close planning chat"
              onClick={onCloseExpanded}
              className="rounded-sm border border-border px-2.5 py-1 text-xs text-muted-foreground hover:border-border-strong hover:text-foreground"
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
                  className="rounded-sm border border-border px-2.5 py-1 text-xs text-muted-foreground hover:border-border-strong hover:text-foreground"
                >
                  Collapse
                </button>
              )}
              <button
                type="button"
                aria-label="Expand planning chat"
                onClick={onExpand}
                className="rounded-sm border border-border px-2.5 py-1 text-xs text-muted-foreground hover:border-border-strong hover:text-foreground"
              >
                Expand
              </button>
            </>
          )}
        </div>
      </div>

      {mode === 'tmux' ? (
        <PlanningTmuxPane session={terminalSession} busy={terminalBusy} error={terminalError} />
      ) : (
        <>
          <div
            ref={transcriptRef}
            data-testid="invoker-terminal-transcript"
            onScroll={handleTranscriptScroll}
            className="min-h-0 flex-1 space-y-3 overflow-y-auto bg-background px-4 py-4 font-mono text-[13px] leading-6"
          >
            {lines.map((line) => {
              const toneClass = line.tone === 'error'
                ? 'text-destructive'
                : line.tone === 'success'
                  ? 'text-emerald-400'
                  : line.tone === 'muted'
                    ? 'text-muted-foreground'
                    : line.role === 'assistant'
                      ? 'text-foreground'
                      : 'text-muted-foreground';
              return (
                <div key={line.id} className="space-y-1">
                  <div className="text-[11px] text-muted-foreground">{rolePrompt(line.role)}</div>
                  {line.reasoning ? (
                    <details
                      data-testid="invoker-terminal-thinking"
                      className="rounded-sm border border-border/60 bg-background/40 px-2 py-1 text-muted-foreground"
                    >
                      <summary className="cursor-pointer select-none text-[11px] text-muted-foreground">
                        Thinking
                      </summary>
                      <div className="mt-1 whitespace-pre-wrap text-[12px] leading-5 text-muted-foreground">
                        {line.reasoning}
                      </div>
                    </details>
                  ) : null}
                  <div className={`whitespace-pre-wrap ${toneClass}`}>{line.text}</div>
                </div>
              );
            })}
          </div>

          {submitError && !readOnly && (
            <div
              data-testid="invoker-terminal-submit-error"
              className="sticky bottom-0 z-10 border-t border-destructive/40 bg-background px-4 py-3 text-destructive-foreground"
            >
              <div className="text-sm font-medium text-destructive">{submitError.title}</div>
              <div className="mt-2 whitespace-pre-wrap font-mono text-xs leading-5 text-destructive/90">{submitError.message}</div>
              <div className="mt-3 flex flex-wrap gap-2">
                {draftPlanAvailable && (
                  <button
                    type="button"
                    onClick={onSubmitDraft}
                    disabled={busy}
                    className="rounded-sm bg-destructive px-3 py-1.5 text-xs font-medium text-destructive-foreground hover:bg-destructive/85 disabled:cursor-wait disabled:opacity-50"
                  >
                    Retry submit
                  </button>
                )}
                <button
                  type="button"
                  onClick={focusComposer}
                  className="rounded-sm border border-border px-3 py-1.5 text-xs text-muted-foreground hover:border-border-strong hover:text-foreground"
                >
                  Keep chatting
                </button>
                <button
                  type="button"
                  onClick={() => void navigator.clipboard?.writeText(submitError.message)}
                  className="rounded-sm border border-border px-3 py-1.5 text-xs text-muted-foreground hover:border-border-strong hover:text-foreground"
                >
                  Copy error
                </button>
              </div>
            </div>
          )}

          {draftPlanAvailable && !readOnly && (
            <div
              data-testid="invoker-terminal-ready-bar"
              className="sticky bottom-0 z-10 border-t border-border bg-background px-4 py-3 text-sm text-foreground"
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span className="font-mono text-xs text-muted-foreground">
                  {draftPlanSummary
                    ? `draft ready · "${draftPlanSummary.name}" · ${draftPlanSummary.workflowCount && draftPlanSummary.workflowCount > 1 ? `${draftPlanSummary.workflowCount} workflows` : `${draftPlanSummary.taskCount} step${draftPlanSummary.taskCount === 1 ? '' : 's'}`}`
                    : 'draft ready'}
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={onSubmitDraft}
                    disabled={busy}
                    className="rounded-sm bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-wait disabled:opacity-50"
                  >
                    Submit to Invoker
                  </button>
                  <button
                    type="button"
                    onClick={focusComposer}
                    className="rounded-sm border border-border px-3 py-1.5 text-xs text-muted-foreground hover:border-border-strong hover:text-foreground"
                  >
                    Keep chatting
                  </button>
                </div>
              </div>
            </div>
          )}

          <form
            className="border-t border-border bg-background px-4 py-3"
            onSubmit={handleFormSubmit}
          >
            <div className="flex items-start gap-2">
              <span className="mt-2.5 shrink-0 font-mono text-xs text-muted-foreground" aria-hidden="true">›</span>
              <textarea
                ref={inputRef}
                data-testid="invoker-terminal-input"
                value={value}
                disabled={busy || readOnly}
                rows={expanded ? 8 : 3}
                onChange={handleValueChange}
                onKeyDown={handleInputKeyDown}
                placeholder={readOnly ? 'This planning session was already submitted.' : 'Describe the change, ask questions, or say “draft the full plan”.'}
                className="min-h-20 w-full resize-none border-0 bg-transparent py-2 font-mono text-[13px] leading-6 text-foreground outline-none placeholder:text-muted-foreground focus:ring-0 disabled:cursor-wait"
              />
            </div>
            <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
              <label className="flex items-center gap-2 font-mono text-xs text-muted-foreground">
                <span>ai</span>
                <select
                  data-testid="invoker-terminal-harness"
                  value={selectedPresetKey}
                  onChange={(event) => onPresetChange(event.target.value)}
                  disabled={readOnly}
                  className="rounded-sm border border-border bg-background px-2 py-1 text-xs text-foreground outline-none hover:border-border-strong focus:border-ring"
                >
                  {presetOptions.map((option) => (
                    <option key={option.key} value={option.key}>{option.label}</option>
                  ))}
                </select>
              </label>
              <Button
                type="submit"
                size="sm"
                disabled={busy || readOnly || !value.trim()}
              >
                Send
              </Button>
            </div>
          </form>
        </>
      )}
    </section>
  );
}
