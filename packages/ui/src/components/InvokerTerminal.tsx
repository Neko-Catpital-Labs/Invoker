import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
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
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const [shouldFollowTranscript, setShouldFollowTranscript] = useState(true);

  const scrollTranscriptToBottom = useCallback((): void => {
    const transcript = transcriptRef.current;
    if (!transcript) return;
    transcript.scrollTop = transcript.scrollHeight;
  }, []);

  useLayoutEffect(() => {
    setShouldFollowTranscript(true);
    scrollTranscriptToBottom();
  }, [activeConversationKey, scrollTranscriptToBottom]);

  useLayoutEffect(() => {
    if (shouldFollowTranscript) {
      scrollTranscriptToBottom();
    }
  }, [lines.length, scrollTranscriptToBottom, shouldFollowTranscript]);

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

  return (
    <section className="flex h-full min-h-0 flex-col border border-border bg-card">
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-2.5">
        <div className="min-w-0">
          <h1 className="truncate text-sm font-medium tracking-tight text-foreground">
            {mode === 'tmux' ? 'Planning tmux' : 'What do you want to build?'}
          </h1>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {mode === 'tmux' ? 'Manual planning terminal attached to this session.' : 'Talk it through, then submit the plan to Invoker.'}
          </p>
        </div>
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
        <PlanningTmuxPane session={terminalSession} busy={terminalBusy} error={terminalError} readOnly={readOnly} />
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
              className="sticky bottom-0 z-10 border-t border-destructive/40 bg-card px-4 py-3 text-destructive-foreground"
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
              className="sticky bottom-0 z-10 border-t border-border bg-card px-4 py-3 text-sm text-foreground"
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
            className="border-t border-border bg-card px-4 py-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (!value.trim() || busy || readOnly) return;
              onSubmit();
            }}
          >
            <div className="flex items-start gap-2">
              <span className="mt-2.5 shrink-0 font-mono text-xs text-muted-foreground" aria-hidden="true">›</span>
              <textarea
                ref={inputRef}
                data-testid="invoker-terminal-input"
                value={value}
                disabled={busy || readOnly}
                rows={expanded ? 8 : 3}
                onChange={(event) => onValueChange(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && !busy && !readOnly && value.trim()) {
                    event.preventDefault();
                    onSubmit();
                  }
                }}
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
