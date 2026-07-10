import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ChangeEvent } from 'react';
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
const PLANNING_CHAT_INPUT_SLOW_MS = 8;
const PLANNING_CHAT_INPUT_COMMIT_SLOW_MS = 16;
const PLANNING_CHAT_RENDER_SLOW_MS = 16;
const PLANNING_CHAT_PERF_REPORT_INTERVAL_MS = 1000;

interface PendingPlanningChatInputPerf {
  startedAt: number;
  handlerMs: number;
  valueLength: number;
  previousValueLength: number;
  lineCount: number;
  expanded: boolean;
  busy: boolean;
  readOnly: boolean;
  draftPlanAvailable: boolean;
}

interface PlanningChatRenderSnapshot {
  valueLength: number;
  lineCount: number;
  expanded: boolean;
  busy: boolean;
  readOnly: boolean;
  draftPlanAvailable: boolean;
  activeConversationKey: string;
}

function isTranscriptNearBottom(element: HTMLDivElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= TRANSCRIPT_BOTTOM_TOLERANCE_PX;
}

function nowPerformanceMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function roundDurationMs(durationMs: number): number {
  return Math.max(0, Math.round(durationMs));
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
  const renderStartedAt = nowPerformanceMs();
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const lastPerfReportAtRef = useRef<Record<string, number>>({});
  const pendingInputPerfRef = useRef<PendingPlanningChatInputPerf | null>(null);
  const previousRenderSnapshotRef = useRef<PlanningChatRenderSnapshot>({
    valueLength: value.length,
    lineCount: lines.length,
    expanded,
    busy,
    readOnly,
    draftPlanAvailable,
    activeConversationKey,
  });
  const [shouldFollowTranscript, setShouldFollowTranscript] = useState(true);

  const shouldReportPerf = useCallback((metric: string, durationMs: number, slowMs: number): boolean => {
    const now = Date.now();
    const previous = lastPerfReportAtRef.current[metric] ?? 0;
    if (durationMs < slowMs && now - previous < PLANNING_CHAT_PERF_REPORT_INTERVAL_MS) return false;
    lastPerfReportAtRef.current[metric] = now;
    return true;
  }, []);

  const reportUiPerf = useCallback((metric: string, data: Record<string, unknown>): void => {
    void window.invoker?.reportUiPerf?.(metric, data);
  }, []);

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

  useLayoutEffect(() => {
    const pending = pendingInputPerfRef.current;
    if (!pending || pending.valueLength !== value.length) return;
    pendingInputPerfRef.current = null;
    const durationMs = nowPerformanceMs() - pending.startedAt;
    if (!shouldReportPerf('planning_chat_input_commit', durationMs, PLANNING_CHAT_INPUT_COMMIT_SLOW_MS)) return;
    reportUiPerf('planning_chat_input_commit', {
      durationMs: roundDurationMs(durationMs),
      handlerMs: roundDurationMs(pending.handlerMs),
      valueLength: pending.valueLength,
      valueDelta: pending.valueLength - pending.previousValueLength,
      lineCount: lines.length,
      pendingLineCount: pending.lineCount,
      expanded: pending.expanded,
      busy: pending.busy,
      readOnly: pending.readOnly,
      draftPlanAvailable: pending.draftPlanAvailable,
    });
  }, [lines.length, reportUiPerf, shouldReportPerf, value.length]);

  useLayoutEffect(() => {
    const durationMs = nowPerformanceMs() - renderStartedAt;
    const previous = previousRenderSnapshotRef.current;
    const snapshot: PlanningChatRenderSnapshot = {
      valueLength: value.length,
      lineCount: lines.length,
      expanded,
      busy,
      readOnly,
      draftPlanAvailable,
      activeConversationKey,
    };
    previousRenderSnapshotRef.current = snapshot;

    const changed =
      previous.valueLength !== snapshot.valueLength ||
      previous.lineCount !== snapshot.lineCount ||
      previous.expanded !== snapshot.expanded ||
      previous.busy !== snapshot.busy ||
      previous.readOnly !== snapshot.readOnly ||
      previous.draftPlanAvailable !== snapshot.draftPlanAvailable ||
      previous.activeConversationKey !== snapshot.activeConversationKey;
    if (!changed || !shouldReportPerf('planning_chat_render_commit', durationMs, PLANNING_CHAT_RENDER_SLOW_MS)) return;
    reportUiPerf('planning_chat_render_commit', {
      durationMs: roundDurationMs(durationMs),
      valueLength: snapshot.valueLength,
      valueDelta: snapshot.valueLength - previous.valueLength,
      lineCount: snapshot.lineCount,
      lineDelta: snapshot.lineCount - previous.lineCount,
      expanded,
      busy,
      readOnly,
      draftPlanAvailable,
      conversationChanged: previous.activeConversationKey !== snapshot.activeConversationKey,
    });
  });

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

  const handleInputChange = useCallback((event: ChangeEvent<HTMLTextAreaElement>): void => {
    const startedAt = nowPerformanceMs();
    const nextValue = event.target.value;
    onValueChange(nextValue);
    const handlerMs = nowPerformanceMs() - startedAt;
    pendingInputPerfRef.current = {
      startedAt,
      handlerMs,
      valueLength: nextValue.length,
      previousValueLength: value.length,
      lineCount: lines.length,
      expanded,
      busy,
      readOnly,
      draftPlanAvailable,
    };
    if (!shouldReportPerf('planning_chat_input_change', handlerMs, PLANNING_CHAT_INPUT_SLOW_MS)) return;
    reportUiPerf('planning_chat_input_change', {
      durationMs: roundDurationMs(handlerMs),
      valueLength: nextValue.length,
      valueDelta: nextValue.length - value.length,
      lineCount: lines.length,
      expanded,
      busy,
      readOnly,
      draftPlanAvailable,
    });
  }, [
    busy,
    draftPlanAvailable,
    expanded,
    lines.length,
    onValueChange,
    readOnly,
    reportUiPerf,
    shouldReportPerf,
    value.length,
  ]);

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
            onChange={handleInputChange}
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
