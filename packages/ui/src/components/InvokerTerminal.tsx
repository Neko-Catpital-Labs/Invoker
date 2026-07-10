import { Profiler, useCallback, useEffect, useLayoutEffect, useRef, useState, type ProfilerOnRenderCallback } from 'react';
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
const PLANNING_CHAT_INPUT_PERF_INTERVAL_MS = 500;
const PLANNING_CHAT_INPUT_SLOW_MS = 16;
const PLANNING_CHAT_INPUT_BURST_CHANGES = 20;
const PLANNING_CHAT_RENDER_PERF_INTERVAL_MS = 1000;
const PLANNING_CHAT_RENDER_SLOW_MS = 16;
const PLANNING_CHAT_RENDER_BURST_COMMITS = 10;

type PlanningChatInputPerfWindow = {
  lastReportedAtMs: number | null;
  changesSinceLastReport: number;
  maxHandlerDurationMs: number;
  maxValueLength: number;
};

type PlanningChatRenderPerfWindow = {
  lastReportedAtMs: number | null;
  commitsSinceLastReport: number;
  maxActualDurationMs: number;
  maxBaseDurationMs: number;
};

function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function roundMs(durationMs: number): number {
  return Math.round(durationMs * 10) / 10;
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
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const inputPerfRef = useRef<PlanningChatInputPerfWindow>({
    lastReportedAtMs: null,
    changesSinceLastReport: 0,
    maxHandlerDurationMs: 0,
    maxValueLength: 0,
  });
  const renderPerfRef = useRef<PlanningChatRenderPerfWindow>({
    lastReportedAtMs: null,
    commitsSinceLastReport: 0,
    maxActualDurationMs: 0,
    maxBaseDurationMs: 0,
  });
  const [shouldFollowTranscript, setShouldFollowTranscript] = useState(true);

  const reportPlanningChatPerf = useCallback((metric: string, data: Record<string, unknown>): void => {
    void window.invoker?.reportUiPerf?.(metric, data);
  }, []);

  const recordInputPerf = useCallback((nextValue: string, previousValue: string, handlerDurationMs: number): void => {
    const stats = inputPerfRef.current;
    const currentTime = nowMs();
    stats.changesSinceLastReport += 1;
    stats.maxHandlerDurationMs = Math.max(stats.maxHandlerDurationMs, handlerDurationMs);
    stats.maxValueLength = Math.max(stats.maxValueLength, nextValue.length);

    const shouldReport =
      stats.lastReportedAtMs === null ||
      handlerDurationMs >= PLANNING_CHAT_INPUT_SLOW_MS ||
      stats.changesSinceLastReport >= PLANNING_CHAT_INPUT_BURST_CHANGES ||
      currentTime - stats.lastReportedAtMs >= PLANNING_CHAT_INPUT_PERF_INTERVAL_MS;
    if (!shouldReport) return;

    reportPlanningChatPerf('planning_chat_input_change', {
      conversationKey: activeConversationKey,
      handlerDurationMs: roundMs(handlerDurationMs),
      maxHandlerDurationMs: roundMs(stats.maxHandlerDurationMs),
      changesSinceLastReport: stats.changesSinceLastReport,
      valueLength: nextValue.length,
      maxValueLength: stats.maxValueLength,
      valueDeltaLength: nextValue.length - previousValue.length,
      lineCount: nextValue.length === 0 ? 0 : nextValue.split('\n').length,
      transcriptLineCount: lines.length,
      busy,
      expanded,
      readOnly,
    });
    stats.lastReportedAtMs = currentTime;
    stats.changesSinceLastReport = 0;
    stats.maxHandlerDurationMs = 0;
    stats.maxValueLength = nextValue.length;
  }, [activeConversationKey, busy, expanded, lines.length, readOnly, reportPlanningChatPerf]);

  const handleRenderPerf = useCallback<ProfilerOnRenderCallback>((
    _id,
    phase,
    actualDuration,
    baseDuration,
    _startTime,
    commitTime,
  ) => {
    const stats = renderPerfRef.current;
    stats.commitsSinceLastReport += 1;
    stats.maxActualDurationMs = Math.max(stats.maxActualDurationMs, actualDuration);
    stats.maxBaseDurationMs = Math.max(stats.maxBaseDurationMs, baseDuration);

    const shouldReport =
      stats.lastReportedAtMs === null ||
      actualDuration >= PLANNING_CHAT_RENDER_SLOW_MS ||
      stats.commitsSinceLastReport >= PLANNING_CHAT_RENDER_BURST_COMMITS ||
      commitTime - stats.lastReportedAtMs >= PLANNING_CHAT_RENDER_PERF_INTERVAL_MS;
    if (!shouldReport) return;

    reportPlanningChatPerf('planning_chat_render', {
      conversationKey: activeConversationKey,
      phase,
      actualDurationMs: roundMs(actualDuration),
      baseDurationMs: roundMs(baseDuration),
      maxActualDurationMs: roundMs(stats.maxActualDurationMs),
      maxBaseDurationMs: roundMs(stats.maxBaseDurationMs),
      commitsSinceLastReport: stats.commitsSinceLastReport,
      transcriptLineCount: lines.length,
      valueLength: value.length,
      busy,
      expanded,
      readOnly,
    });
    stats.lastReportedAtMs = commitTime;
    stats.commitsSinceLastReport = 0;
    stats.maxActualDurationMs = 0;
    stats.maxBaseDurationMs = 0;
  }, [activeConversationKey, busy, expanded, lines.length, readOnly, reportPlanningChatPerf, value.length]);

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

  const focusComposer = (): void => {
    inputRef.current?.focus();
  };

  return (
    <Profiler id="planning-chat" onRender={handleRenderPerf}>
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
            onChange={(event) => {
              const nextValue = event.target.value;
              const previousValue = value;
              const startedAt = nowMs();
              onValueChange(nextValue);
              recordInputPerf(nextValue, previousValue, nowMs() - startedAt);
            }}
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
    </Profiler>
  );
}
