import { type ChangeEvent, type KeyboardEvent, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
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
const PLANNING_CHAT_RENDER_SLOW_MS = 16;
const PLANNING_CHAT_RENDER_SAMPLE_EVERY = 5;
const PLANNING_CHAT_TRANSCRIPT_SCROLL_SLOW_MS = 8;

function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function roundMs(value: number): number {
  return Math.round(value * 10) / 10;
}

function countTextLines(value: string): number {
  if (value.length === 0) return 0;
  let count = 1;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === '\n') count += 1;
  }
  return count;
}

function reportPlanningChatPerf(metric: string, data: Record<string, unknown>): void {
  if (typeof window === 'undefined') return;
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
  const renderStartedAt = nowMs();
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const lineCountRef = useRef(lines.length);
  const expandedRef = useRef(expanded);
  const activeConversationKeyRef = useRef(activeConversationKey);
  const inputChangeCountRef = useRef(0);
  const renderPerfRef = useRef({
    renderCount: 0,
    lastLineCount: -1,
    lastValueLength: -1,
    lastConversationKey: '',
  });
  const [shouldFollowTranscript, setShouldFollowTranscript] = useState(true);
  lineCountRef.current = lines.length;
  expandedRef.current = expanded;
  activeConversationKeyRef.current = activeConversationKey;

  const scrollTranscriptToBottom = useCallback((reason: string, lineCount: number): void => {
    const transcript = transcriptRef.current;
    if (!transcript) return;
    const startedAt = nowMs();
    transcript.scrollTop = transcript.scrollHeight;
    const durationMs = nowMs() - startedAt;
    if (durationMs >= PLANNING_CHAT_TRANSCRIPT_SCROLL_SLOW_MS || reason === 'conversation-change') {
      reportPlanningChatPerf('planning_chat_transcript_scroll', {
        durationMs: roundMs(durationMs),
        reason,
        lineCount,
        scrollHeight: transcript.scrollHeight,
        clientHeight: transcript.clientHeight,
        expanded: expandedRef.current,
        conversationKey: activeConversationKeyRef.current,
      });
    }
  }, []);

  useLayoutEffect(() => {
    setShouldFollowTranscript(true);
    scrollTranscriptToBottom('conversation-change', lineCountRef.current);
  }, [activeConversationKey, scrollTranscriptToBottom]);

  useLayoutEffect(() => {
    if (shouldFollowTranscript) {
      scrollTranscriptToBottom('line-change', lines.length);
    }
  }, [lines.length, scrollTranscriptToBottom, shouldFollowTranscript]);

  useLayoutEffect(() => {
    const durationMs = nowMs() - renderStartedAt;
    const state = renderPerfRef.current;
    state.renderCount += 1;
    const lineCountChanged = state.lastLineCount !== lines.length || state.lastConversationKey !== activeConversationKey;
    const inputLengthChanged = state.lastValueLength !== value.length;
    const shouldSampleInputRender = inputLengthChanged && state.renderCount % PLANNING_CHAT_RENDER_SAMPLE_EVERY === 0;

    state.lastLineCount = lines.length;
    state.lastValueLength = value.length;
    state.lastConversationKey = activeConversationKey;

    if (durationMs < PLANNING_CHAT_RENDER_SLOW_MS && !lineCountChanged && !shouldSampleInputRender) {
      return;
    }

    reportPlanningChatPerf('planning_chat_render', {
      durationMs: roundMs(durationMs),
      renderCount: state.renderCount,
      lineCount: lines.length,
      inputLength: value.length,
      inputLineCount: countTextLines(value),
      busy,
      readOnly,
      expanded,
      conversationKey: activeConversationKey,
      lineCountChanged,
      inputLengthChanged,
    });
  });

  const handleTranscriptScroll = useCallback((): void => {
    const transcript = transcriptRef.current;
    if (!transcript) return;
    setShouldFollowTranscript(isTranscriptNearBottom(transcript));
  }, []);

  const handleInputChange = useCallback((event: ChangeEvent<HTMLTextAreaElement>): void => {
    const startedAt = nowMs();
    const nextValue = event.target.value;
    onValueChange(nextValue);
    const durationMs = nowMs() - startedAt;
    inputChangeCountRef.current += 1;
    reportPlanningChatPerf('planning_chat_input_change', {
      durationMs: roundMs(durationMs),
      inputChangeCount: inputChangeCountRef.current,
      valueLength: nextValue.length,
      previousValueLength: value.length,
      deltaLength: nextValue.length - value.length,
      inputLineCount: countTextLines(nextValue),
      transcriptLineCount: lines.length,
      busy,
      readOnly,
      expanded,
      conversationKey: activeConversationKey,
    });
  }, [activeConversationKey, busy, expanded, lines.length, onValueChange, readOnly, value.length]);

  const handleInputKeyDown = useCallback((event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && !busy && !readOnly && value.trim()) {
      event.preventDefault();
      onSubmit();
    }
  }, [busy, onSubmit, readOnly, value]);

  useEffect(() => {
    if (!busy && !readOnly) {
      inputRef.current?.focus();
    }
  }, [busy, readOnly]);

  const focusComposer = (): void => {
    inputRef.current?.focus();
  };

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
    </section>
  );
}
