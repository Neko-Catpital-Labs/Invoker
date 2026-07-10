import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { Button } from './primitives/index.js';

export interface InvokerTerminalLine {
  id: number;
  text: string;
  role: 'user' | 'assistant' | 'system';
  tone?: 'muted' | 'error' | 'success';
}

interface PlanningPresetOptionView {
  key: string;
  label: string;
}

const TRANSCRIPT_BOTTOM_TOLERANCE_PX = 32;
const PLANNING_CHAT_INPUT_REPORT_INTERVAL_MS = 250;
const PLANNING_CHAT_RENDER_REPORT_INTERVAL_MS = 250;
const PLANNING_CHAT_TRANSCRIPT_REPORT_INTERVAL_MS = 500;
const PLANNING_CHAT_SLOW_INPUT_MS = 8;
const PLANNING_CHAT_SLOW_RENDER_MS = 16;

type PendingInputPerf = {
  sequence: number;
  startedAtMs: number;
  valueLength: number;
  previousValueLength: number;
  handlerDurationMs: number;
};

type TranscriptScrollSample = {
  durationMs: number;
  scrollHeight: number;
  clientHeight: number;
  scrollTop: number;
};

type TranscriptScrollContext = {
  lineCount: number;
  lastLineChars: number;
  expanded: boolean;
  conversationKey: string;
};

function isTranscriptNearBottom(element: HTMLDivElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= TRANSCRIPT_BOTTOM_TOLERANCE_PX;
}

function perfNowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function roundMs(value: number): number {
  return Math.max(0, Math.round(value));
}

function reportPlanningChatPerf(metric: string, data: Record<string, unknown>): void {
  if (typeof window === 'undefined') return;
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
  onValueChange: (value: string) => void;
  onSubmit: () => void;
  onSubmitDraft: () => void;
  onPresetChange: (presetKey: string) => void;
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
  onValueChange,
  onSubmit,
  onSubmitDraft,
  onPresetChange,
  onExpand,
  onCloseExpanded,
  onCollapse,
  activeConversationKey,
}: InvokerTerminalProps): JSX.Element {
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const inputPerfRef = useRef({
    sequence: 0,
    lastInputAtMs: 0,
    lastInputReportAtMs: Number.NEGATIVE_INFINITY,
    lastValueLength: value.length,
    pendingInput: null as PendingInputPerf | null,
  });
  const renderPerfRef = useRef({
    lastInputCommitReportAtMs: Number.NEGATIVE_INFINITY,
    lastTranscriptReportAtMs: Number.NEGATIVE_INFINITY,
  });
  const latestValueLengthRef = useRef(value.length);
  const transcriptContextRef = useRef<TranscriptScrollContext>({
    lineCount: lines.length,
    lastLineChars: lines[lines.length - 1]?.text.length ?? 0,
    expanded,
    conversationKey: activeConversationKey,
  });
  const [shouldFollowTranscript, setShouldFollowTranscript] = useState(true);

  latestValueLengthRef.current = value.length;
  transcriptContextRef.current = {
    lineCount: lines.length,
    lastLineChars: lines[lines.length - 1]?.text.length ?? 0,
    expanded,
    conversationKey: activeConversationKey,
  };

  const scrollTranscriptToBottom = useCallback((): TranscriptScrollSample | null => {
    const transcript = transcriptRef.current;
    if (!transcript) return null;
    const startedAtMs = perfNowMs();
    transcript.scrollTop = transcript.scrollHeight;
    const durationMs = perfNowMs() - startedAtMs;
    return {
      durationMs,
      scrollHeight: transcript.scrollHeight,
      clientHeight: transcript.clientHeight,
      scrollTop: transcript.scrollTop,
    };
  }, []);

  const reportTranscriptScroll = useCallback((
    reason: string,
    sample: TranscriptScrollSample | null,
    context: TranscriptScrollContext,
  ): void => {
    if (!sample) return;
    const nowMs = perfNowMs();
    const shouldReport =
      nowMs - renderPerfRef.current.lastTranscriptReportAtMs >= PLANNING_CHAT_TRANSCRIPT_REPORT_INTERVAL_MS ||
      sample.durationMs >= PLANNING_CHAT_SLOW_INPUT_MS;
    if (!shouldReport) return;
    renderPerfRef.current.lastTranscriptReportAtMs = nowMs;
    reportPlanningChatPerf('planning_chat_transcript_scroll', {
      reason,
      durationMs: roundMs(sample.durationMs),
      lineCount: context.lineCount,
      lastLineChars: context.lastLineChars,
      scrollHeight: sample.scrollHeight,
      clientHeight: sample.clientHeight,
      scrollTop: sample.scrollTop,
      expanded: context.expanded,
      conversationKey: context.conversationKey,
    });
  }, []);

  useLayoutEffect(() => {
    setShouldFollowTranscript(true);
    const sample = scrollTranscriptToBottom();
    reportTranscriptScroll('conversation_changed', sample, transcriptContextRef.current);
    inputPerfRef.current.lastValueLength = latestValueLengthRef.current;
    inputPerfRef.current.pendingInput = null;
  }, [activeConversationKey, reportTranscriptScroll, scrollTranscriptToBottom]);

  useLayoutEffect(() => {
    if (shouldFollowTranscript) {
      const sample = scrollTranscriptToBottom();
      reportTranscriptScroll('lines_changed', sample, transcriptContextRef.current);
    }
  }, [lines.length, reportTranscriptScroll, scrollTranscriptToBottom, shouldFollowTranscript]);

  useLayoutEffect(() => {
    const pendingInput = inputPerfRef.current.pendingInput;
    if (!pendingInput || pendingInput.valueLength !== value.length) return;
    const nowMs = perfNowMs();
    const inputToCommitMs = nowMs - pendingInput.startedAtMs;
    const shouldReport =
      nowMs - renderPerfRef.current.lastInputCommitReportAtMs >= PLANNING_CHAT_RENDER_REPORT_INTERVAL_MS ||
      inputToCommitMs >= PLANNING_CHAT_SLOW_RENDER_MS ||
      pendingInput.handlerDurationMs >= PLANNING_CHAT_SLOW_INPUT_MS;
    if (shouldReport) {
      renderPerfRef.current.lastInputCommitReportAtMs = nowMs;
      reportPlanningChatPerf('planning_chat_render_commit', {
        inputSequence: pendingInput.sequence,
        inputToCommitMs: roundMs(inputToCommitMs),
        handlerDurationMs: roundMs(pendingInput.handlerDurationMs),
        valueLength: value.length,
        previousValueLength: pendingInput.previousValueLength,
        lineCount: lines.length,
        busy,
        readOnly,
        expanded,
        draftPlanAvailable,
        conversationKey: activeConversationKey,
      });
    }
    inputPerfRef.current.pendingInput = null;
  }, [activeConversationKey, busy, draftPlanAvailable, expanded, lines.length, readOnly, value.length]);

  const handleTranscriptScroll = useCallback((): void => {
    const transcript = transcriptRef.current;
    if (!transcript) return;
    setShouldFollowTranscript(isTranscriptNearBottom(transcript));
  }, []);

  useEffect(() => {
    if (!busy && !readOnly) {
      inputRef.current?.focus();
    }
  }, [busy, readOnly]);

  const focusComposer = (): void => {
    inputRef.current?.focus();
  };

  const handleValueChange = useCallback((event: ChangeEvent<HTMLTextAreaElement>): void => {
    const nextValue = event.target.value;
    const startedAtMs = perfNowMs();
    const perf = inputPerfRef.current;
    const previousInputAtMs = perf.lastInputAtMs;
    const previousValueLength = perf.lastValueLength;
    const sequence = perf.sequence + 1;
    perf.sequence = sequence;

    onValueChange(nextValue);

    const finishedAtMs = perfNowMs();
    const handlerDurationMs = finishedAtMs - startedAtMs;
    const sincePreviousInputMs = previousInputAtMs > 0 ? startedAtMs - previousInputAtMs : undefined;
    perf.lastInputAtMs = finishedAtMs;
    perf.lastValueLength = nextValue.length;
    perf.pendingInput = {
      sequence,
      startedAtMs,
      valueLength: nextValue.length,
      previousValueLength,
      handlerDurationMs,
    };

    const shouldReport =
      finishedAtMs - perf.lastInputReportAtMs >= PLANNING_CHAT_INPUT_REPORT_INTERVAL_MS ||
      handlerDurationMs >= PLANNING_CHAT_SLOW_INPUT_MS ||
      (sincePreviousInputMs !== undefined && sincePreviousInputMs >= PLANNING_CHAT_TRANSCRIPT_REPORT_INTERVAL_MS);
    if (!shouldReport) return;
    perf.lastInputReportAtMs = finishedAtMs;
    reportPlanningChatPerf('planning_chat_input_change', {
      inputSequence: sequence,
      handlerDurationMs: roundMs(handlerDurationMs),
      valueLength: nextValue.length,
      previousValueLength,
      deltaChars: nextValue.length - previousValueLength,
      sincePreviousInputMs: sincePreviousInputMs === undefined ? undefined : roundMs(sincePreviousInputMs),
      lineCount: lines.length,
      busy,
      readOnly,
      expanded,
      draftPlanAvailable,
      conversationKey: activeConversationKey,
    });
  }, [activeConversationKey, busy, draftPlanAvailable, expanded, lines.length, onValueChange, readOnly]);

  return (
    <section className="flex h-full min-h-0 flex-col border border-border bg-card">
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-2.5">
        <div className="min-w-0">
          <h1 className="truncate text-sm font-medium tracking-tight text-foreground">What do you want to build?</h1>
          <p className="mt-0.5 text-xs text-muted-foreground">Talk it through, then submit the plan to Invoker.</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {busy && (
            <span className="font-mono text-[11px] text-muted-foreground">working…</span>
          )}
          {readOnly && (
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
            onChange={handleValueChange}
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
    </section>
  );
}
