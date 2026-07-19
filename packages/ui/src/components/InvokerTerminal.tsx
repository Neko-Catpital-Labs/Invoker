import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent, type KeyboardEvent } from 'react';
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

export interface InvokerTerminalPlanningStream {
  text: string;
  status: 'streaming' | 'failed';
}

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
  draftPlanSummary?: {
    name: string;
    taskCount: number;
    workflowCount?: number;
    taskGroups?: { workflow: string | null; tasks: string[] }[];
  };
  planningStream?: InvokerTerminalPlanningStream | null;
  readOnly?: boolean;
  expanded?: boolean;
  mode?: PlanningTerminalMode;
  terminalSession?: TerminalSessionDescriptor | null;
  terminalBusy?: boolean;
  terminalError?: string | null;
  onValueChange: (value: string) => void;
  onSubmit: () => void;
  onPresetChange: (presetKey: string) => void;
  onModeChange?: (mode: PlanningTerminalMode) => void;
  onExpand: () => void;
  onCloseExpanded?: () => void;
  onOpenGraph?: () => void;
  submittedPlanName?: string;
  activeConversationKey: string;
}

function roleLabel(role: InvokerTerminalLine['role']): string {
  if (role === 'user') return 'You';
  if (role === 'assistant') return 'Invoker';
  return 'System';
}

type MessageSegment =
  | { kind: 'prose'; text: string }
  | { kind: 'code'; language: string | null; text: string };

function splitFencedMessageSegments(text: string): MessageSegment[] {
  const segments: MessageSegment[] = [];
  const fencePattern = /```([^\n`]*)\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = fencePattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ kind: 'prose', text: text.slice(lastIndex, match.index) });
    }
    const language = match[1]?.trim() || null;
    segments.push({ kind: 'code', language, text: match[2] ?? '' });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    segments.push({ kind: 'prose', text: text.slice(lastIndex) });
  }
  return segments.length > 0 ? segments : [{ kind: 'prose', text }];
}

function MessageBody({ text, toneClass }: { text: string; toneClass: string }): JSX.Element {
  const segments = splitFencedMessageSegments(text);
  return (
    <div className={`space-y-3 ${toneClass}`}>
      {segments.map((segment, index) => {
        if (segment.kind === 'code') {
          return (
            <details key={`code-${index}`} className="rounded-lg border border-border bg-card/80">
              <summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium text-muted-foreground hover:text-foreground">
                {segment.language ? `View ${segment.language.toUpperCase()}` : 'View details'}
              </summary>
              <pre className="overflow-x-auto border-t border-border px-3 py-2.5 font-mono text-[12px] leading-5 text-foreground">
                <code className="whitespace-pre">{segment.text.replace(/\n$/, '')}</code>
              </pre>
            </details>
          );
        }
        const prose = segment.text.replace(/^\n+|\n+$/g, '');
        if (!prose) return null;
        return (
          <div key={`prose-${index}`} className="whitespace-pre-wrap font-sans text-[13.5px] leading-6">
            {prose}
          </div>
        );
      })}
    </div>
  );
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
  readOnly?: boolean;
}

function PlanningTmuxPane({ session, busy, error, readOnly = false }: PlanningTmuxPaneProps): JSX.Element {
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
        fontFamily: 'var(--app-font-mono), ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
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
      if (readOnly) return;
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
  }, [readOnly, session?.sessionId]);

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
          className="absolute inset-0 flex items-center justify-center px-4 text-center font-sans text-xs text-muted-foreground"
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
        <div className="absolute right-3 top-3 rounded-md border border-border bg-card px-2 py-1 font-sans text-[11px] text-amber-300">
          exited{typeof session.exitCode === 'number' ? ` ${session.exitCode}` : ''}
        </div>
      )}
      {session && error && (
        <div
          data-testid="invoker-terminal-tmux-error"
          className="absolute bottom-3 left-3 right-3 rounded-md border border-destructive/40 bg-card px-3 py-2 font-sans text-xs text-destructive"
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
  planningStream,
  readOnly = false,
  expanded = false,
  mode = 'chat',
  terminalSession = null,
  terminalBusy = false,
  terminalError = null,
  onValueChange,
  onSubmit,
  onPresetChange,
  onModeChange,
  onExpand,
  onCloseExpanded,
  onOpenGraph,
  submittedPlanName,
  activeConversationKey,
}: InvokerTerminalProps): JSX.Element {
  const renderStartedAt = nowMs();
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const [shouldFollowTranscript, setShouldFollowTranscript] = useState(true);
  const [showComposerOptions, setShowComposerOptions] = useState(false);
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
  }, [lines.length, planningStream?.text, scrollTranscriptToBottom, shouldFollowTranscript]);

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
    const input = inputRef.current;
    if (!input || expanded) return;
    input.style.height = '0px';
    input.style.height = `${Math.min(input.scrollHeight, 144)}px`;
  }, [expanded, value]);

  useLayoutEffect(() => {
    const lastLine = lines.at(-1);
    const signature = `${activeConversationKey}:${lines.length}:${lastLine?.id ?? 'none'}:${lastLine?.role ?? 'none'}:${lastLine?.text.length ?? 0}:${lastLine?.reasoning?.length ?? 0}`;
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

  const composerDisabledCursorClass = busy ? 'disabled:cursor-wait' : readOnly ? 'disabled:cursor-not-allowed' : '';

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

  const transcriptContent = useMemo(() => (
    <>
      {lines.map((line) => {
        const toneClass = line.tone === 'error'
          ? 'text-destructive'
          : line.tone === 'success'
            ? 'text-emerald-400'
            : line.tone === 'muted'
              ? 'text-muted-foreground'
              : line.role === 'assistant'
                ? 'text-foreground'
                : 'text-foreground/90';
        const bubbleClass = line.role === 'user'
          ? 'rounded-2xl border border-border/70 bg-secondary/40 px-3.5 py-2.5'
          : line.role === 'system'
            ? 'rounded-xl border border-border/50 bg-background/50 px-3.5 py-2.5'
            : 'rounded-2xl px-1 py-1';
        return (
          <div key={line.id} className={`space-y-1.5 ${bubbleClass}`}>
            <div className="text-[11px] font-medium tracking-wide text-muted-foreground">
              {roleLabel(line.role)}
            </div>
            <MessageBody text={line.text} toneClass={toneClass} />
          </div>
        );
      })}
      {planningStream && planningStream.text ? (
        <div
          data-testid="invoker-terminal-planner-stream"
          data-state={planningStream.status}
          className={`flex items-center gap-2 text-xs ${
            planningStream.status === 'failed'
              ? 'text-destructive'
              : 'text-muted-foreground'
          }`}
        >
          <span aria-hidden="true" className={planningStream.status === 'failed' ? '' : 'animate-pulse'}>●</span>
          <span>{planningStream.status === 'failed' ? 'Planning stopped. Try again when ready.' : 'Drafting your plan…'}</span>
        </div>
      ) : null}
    </>
  ), [lines, planningStream]);
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
                Tmux
              </button>
            </div>
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
            <button
              type="button"
              aria-label="Expand planning chat"
              onClick={onExpand}
              className="rounded-sm border border-border px-2.5 py-1 text-xs text-muted-foreground hover:border-border-strong hover:text-foreground"
            >
              Expand
            </button>
          )}
        </div>
      </div>

      {mode === 'tmux' ? (
        <PlanningTmuxPane session={terminalSession} busy={terminalBusy} error={terminalError} readOnly={readOnly} />
      ) : (
        <>
          <div
            ref={transcriptRef}
            data-testid="invoker-terminal-transcript"
            onScroll={handleTranscriptScroll}
            className="min-h-0 flex-1 space-y-5 overflow-y-auto bg-background px-5 py-5 font-sans text-[13.5px] leading-6"
          >
            {lines.length === 0 && !planningStream?.text ? (
              <div data-testid="invoker-terminal-empty-hero" className="flex h-full min-h-[220px] flex-col justify-center gap-4">
                <div>
                  <h3 className="text-lg font-semibold tracking-tight text-foreground">What do you want to build?</h3>
                  <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">
                    Describe a change, investigate a bug, or ask Invoker to draft a full plan. Review the graph before starting work.
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {['Plan a feature', 'Investigate a bug', 'Compare approaches'].map((chip) => (
                    <button
                      key={chip}
                      type="button"
                      disabled={busy || readOnly}
                      onClick={() => {
                        onValueChange(chip);
                        focusComposer();
                      }}
                      className="rounded-full border border-border px-3 py-1 text-xs text-muted-foreground hover:border-border-strong hover:text-foreground disabled:opacity-50"
                    >
                      {chip}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              transcriptContent
            )}
          </div>

          {draftPlanAvailable && !readOnly && (
            <div
              data-testid="invoker-terminal-ready-bar"
              className="sticky bottom-0 z-10 border-t border-border bg-card/80 px-4 py-3.5 text-sm text-foreground backdrop-blur-sm"
            >
              <p className="mb-3 text-xs text-muted-foreground">
                {draftPlanSummary
                  ? `Draft ready · ${draftPlanSummary.name} · ${draftPlanSummary.workflowCount && draftPlanSummary.workflowCount > 1 ? `${draftPlanSummary.workflowCount} workflows · ${draftPlanSummary.taskCount} task${draftPlanSummary.taskCount === 1 ? '' : 's'}` : `${draftPlanSummary.taskCount} task${draftPlanSummary.taskCount === 1 ? '' : 's'}`}`
                  : 'Draft ready'}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                {onOpenGraph && (
                  <button
                    type="button"
                    data-testid="invoker-terminal-open-graph"
                    onClick={onOpenGraph}
                    className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
                  >
                    Review draft
                  </button>
                )}
                <button
                  type="button"
                  onClick={focusComposer}
                  className="rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground hover:border-border-strong hover:text-foreground"
                >
                  Keep chatting
                </button>
              </div>
            </div>
          )}

          {readOnly && submittedPlanName && onOpenGraph && (
            <div
              data-testid="invoker-terminal-submitted-bar"
              className="sticky bottom-0 z-10 border-t border-border bg-card/80 px-4 py-3.5 text-sm text-foreground backdrop-blur-sm"
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span className="text-xs text-muted-foreground">
                  Plan ready · &quot;{submittedPlanName}&quot; · review the graph, then Start ready work
                </span>
                <button
                  type="button"
                  data-testid="invoker-terminal-open-graph"
                  onClick={onOpenGraph}
                  className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
                >
                  Open graph
                </button>
              </div>
            </div>
          )}

          <form
            className="border-t border-border bg-background px-4 py-3.5"
            onSubmit={handleFormSubmit}
          >
            <div className="rounded-xl border border-border bg-card/40 px-3 py-1.5 focus-within:border-border-strong">
              <textarea
                ref={inputRef}
                data-testid="invoker-terminal-input"
                value={value}
                disabled={busy || readOnly}
                rows={expanded ? 5 : 1}
                onChange={handleValueChange}
                onKeyDown={handleInputKeyDown}
                placeholder={readOnly ? 'This planning session was already submitted.' : 'Describe what you want to build'}
                className={`min-h-9 w-full resize-none border-0 bg-transparent py-1 font-sans text-[13.5px] leading-6 text-foreground outline-none placeholder:text-muted-foreground focus:ring-0 ${composerDisabledCursorClass}`}
              />
              <div className="mt-1 flex flex-wrap items-center justify-between gap-3 pt-2">
                <div>
                  <button
                    type="button"
                    aria-expanded={showComposerOptions}
                    onClick={() => setShowComposerOptions((visible) => !visible)}
                    className="text-xs text-muted-foreground hover:text-foreground"
                  >
                    Options
                  </button>
                  {showComposerOptions && (
                    <label className="ml-3 text-xs text-muted-foreground">
                      Agent
                      <select
                        data-testid="invoker-terminal-harness"
                        value={selectedPresetKey}
                        onChange={(event) => onPresetChange(event.target.value)}
                        disabled={readOnly}
                        className="ml-2 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground outline-none hover:border-border-strong focus:border-ring"
                      >
                        {presetOptions.map((option) => (
                          <option key={option.key} value={option.key}>{option.label}</option>
                        ))}
                      </select>
                    </label>
                  )}
                </div>
                <Button
                  type="submit"
                  size="sm"
                  disabled={busy || readOnly || !value.trim()}
                >
                  Send
                </Button>
              </div>
            </div>
          </form>
        </>
      )}
    </section>
  );
}
