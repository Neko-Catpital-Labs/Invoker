import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button } from './primitives/index.js';

export interface InvokerTerminalLine {
  id: number;
  text: string;
  role: 'user' | 'assistant' | 'system';
  reasoning?: string;
  tone?: 'muted' | 'error' | 'success';
}

interface PlanningPresetOptionView {
  key: string;
  label: string;
}

const TRANSCRIPT_BOTTOM_TOLERANCE_PX = 32;
const PLANNING_CHAT_RENDER_REPORT_MIN_INTERVAL_MS = 250;
const PLANNING_CHAT_RENDER_SLOW_MS = 8;

function perfNowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function roundMs(value: number): number {
  return Math.round(value * 10) / 10;
}

function reportPlanningChatPerf(metric: string, data: Record<string, unknown>): void {
  void window.invoker?.reportUiPerf?.(metric, data);
}

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
  const renderStartedAt = perfNowMs();
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const lastInputAtRef = useRef<number | null>(null);
  const inputSequenceRef = useRef(0);
  const lastRenderReportAtRef = useRef(0);
  const previousCommitRef = useRef<{
    activeConversationKey: string;
    busy: boolean;
    lineCount: number;
    readOnly: boolean;
    valueLength: number;
  } | null>(null);
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
    if (!busy && !readOnly) {
      inputRef.current?.focus();
    }
  }, [busy, readOnly]);

  useEffect(() => {
    const endedAt = perfNowMs();
    const durationMs = endedAt - renderStartedAt;
    const previous = previousCommitRef.current;
    const lineCount = lines.length;
    const valueLength = value.length;
    const changed = !previous ||
      previous.activeConversationKey !== activeConversationKey ||
      previous.busy !== busy ||
      previous.lineCount !== lineCount ||
      previous.readOnly !== readOnly ||
      previous.valueLength !== valueLength;
    const due = endedAt - lastRenderReportAtRef.current >= PLANNING_CHAT_RENDER_REPORT_MIN_INTERVAL_MS;
    if (changed && (durationMs >= PLANNING_CHAT_RENDER_SLOW_MS || due)) {
      lastRenderReportAtRef.current = endedAt;
      const lastInputAt = lastInputAtRef.current;
      reportPlanningChatPerf('planning_chat_render_commit', {
        durationMs: roundMs(durationMs),
        activeConversationKey,
        busy,
        expanded,
        inputSequence: inputSequenceRef.current,
        lineCount,
        readOnly,
        reasoningLineCount: lines.reduce((count, line) => count + (line.reasoning ? 1 : 0), 0),
        shouldFollowTranscript,
        sinceLastInputMs: lastInputAt === null ? undefined : Math.max(0, Math.round(endedAt - lastInputAt)),
        valueLength,
      });
    }
    previousCommitRef.current = {
      activeConversationKey,
      busy,
      lineCount,
      readOnly,
      valueLength,
    };
  });

  const focusComposer = (): void => {
    inputRef.current?.focus();
  };

  const handleValueChange = useCallback((nextValue: string): void => {
    const startedAt = perfNowMs();
    const previousLength = value.length;
    onValueChange(nextValue);
    const endedAt = perfNowMs();
    const previousInputAt = lastInputAtRef.current;
    const inputSequence = inputSequenceRef.current + 1;
    inputSequenceRef.current = inputSequence;
    lastInputAtRef.current = endedAt;
    reportPlanningChatPerf('planning_chat_input_change', {
      durationMs: roundMs(endedAt - startedAt),
      activeConversationKey,
      busy,
      deltaChars: nextValue.length - previousLength,
      expanded,
      inputSequence,
      lineCount: lines.length,
      previousValueLength: previousLength,
      readOnly,
      sincePreviousInputMs: previousInputAt === null ? undefined : Math.max(0, Math.round(endedAt - previousInputAt)),
      valueLength: nextValue.length,
    });
  }, [activeConversationKey, busy, expanded, lines.length, onValueChange, readOnly, value.length]);

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
            onChange={(event) => handleValueChange(event.target.value)}
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
