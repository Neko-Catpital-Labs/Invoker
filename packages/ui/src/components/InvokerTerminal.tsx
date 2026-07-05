import { useEffect, useRef } from 'react';

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

interface InvokerTerminalProps {
  lines: InvokerTerminalLine[];
  busy: boolean;
  value: string;
  selectedPresetKey: string;
  presetOptions: PlanningPresetOptionView[];
  draftPlanAvailable: boolean;
  draftPlanSummary?: { name: string; taskCount: number };
  readOnly?: boolean;
  expanded?: boolean;
  onValueChange: (value: string) => void;
  onSubmit: () => void;
  onSubmitDraft: () => void;
  onPresetChange: (presetKey: string) => void;
  onExpand: () => void;
  onCloseExpanded?: () => void;
  onCollapse?: () => void;
}

export function InvokerTerminal({
  lines,
  busy,
  value,
  selectedPresetKey,
  presetOptions,
  draftPlanAvailable,
  draftPlanSummary,
  readOnly = false,
  expanded = false,
  onValueChange,
  onSubmit,
  onSubmitDraft,
  onPresetChange,
  onExpand,
  onCloseExpanded,
  onCollapse,
}: InvokerTerminalProps): JSX.Element {
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!busy && !readOnly) {
      inputRef.current?.focus();
    }
  }, [busy, readOnly]);

  const focusComposer = (): void => {
    inputRef.current?.focus();
  };

  return (
    <section className={`flex min-h-0 flex-col rounded-3xl border border-gray-800 bg-gray-950/95 shadow-2xl ${expanded ? 'h-full' : ''}`}>
      <div className="flex items-start justify-between gap-4 border-b border-gray-900 px-5 py-4">
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-gray-50">What do you want to build?</h1>
          <p className="mt-1 text-sm text-gray-400">Talk it through, then submit the plan to Invoker.</p>
        </div>
        <div className="flex items-center gap-2">
          {busy && <span className="rounded-full bg-blue-500/10 px-3 py-1 text-xs text-blue-200">Working…</span>}
          {readOnly && <span className="rounded-full bg-gray-800 px-3 py-1 text-xs text-gray-300">Submitted</span>}
          {expanded ? (
            <button
              type="button"
              aria-label="Close planning chat"
              onClick={onCloseExpanded}
              className="rounded-full border border-gray-800 px-3 py-1 text-xs text-gray-300 hover:border-gray-600 hover:text-gray-100"
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
                  className="rounded-full border border-gray-800 px-3 py-1 text-xs text-gray-300 hover:border-gray-600 hover:text-gray-100"
                >
                  Collapse
                </button>
              )}
              <button
                type="button"
                aria-label="Expand planning chat"
                onClick={onExpand}
                className="rounded-full border border-gray-800 px-3 py-1 text-xs text-gray-300 hover:border-gray-600 hover:text-gray-100"
              >
                Expand
              </button>
            </>
          )}
        </div>
      </div>

      <div
        data-testid="invoker-terminal-transcript"
        className={`min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-5 text-sm ${expanded ? '' : 'max-h-64'}`}
      >
        {lines.map((line) => {
          const toneClass = line.tone === 'error'
            ? 'text-red-300'
            : line.tone === 'success'
              ? 'text-emerald-300'
              : line.tone === 'muted'
                ? 'text-gray-500'
                : line.role === 'assistant'
                  ? 'text-gray-200'
                  : 'text-gray-300';
          const label = line.role === 'user' ? 'You' : line.role === 'assistant' ? 'Invoker' : 'System';
          return (
            <div key={line.id} className="space-y-1">
              <div className="text-xs font-medium uppercase tracking-wide text-gray-500">{label}</div>
              <div className={`whitespace-pre-wrap leading-6 ${toneClass}`}>{line.text}</div>
            </div>
          );
        })}
      </div>

      {draftPlanAvailable && !readOnly && (
        <div
          data-testid="invoker-terminal-ready-bar"
          className="sticky bottom-0 z-10 mx-4 mb-3 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-emerald-500/30 bg-emerald-950/70 px-4 py-3 text-sm text-emerald-100 shadow-lg"
        >
          <span>
            {draftPlanSummary
              ? `Draft plan ready: "${draftPlanSummary.name}" (${draftPlanSummary.taskCount} steps).`
              : 'Draft plan ready.'}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onSubmitDraft}
              disabled={busy}
              className="rounded-full bg-emerald-300 px-4 py-2 text-sm font-medium text-emerald-950 hover:bg-emerald-200 disabled:cursor-wait disabled:opacity-50"
            >
              Submit to Invoker
            </button>
            <button
              type="button"
              onClick={focusComposer}
              className="rounded-full border border-emerald-400/40 px-4 py-2 text-sm text-emerald-100 hover:border-emerald-200"
            >
              Keep chatting
            </button>
          </div>
        </div>
      )}

      <form
        className="border-t border-gray-900 px-5 py-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (!value.trim() || busy || readOnly) return;
          onSubmit();
        }}
      >
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
          className="min-h-24 w-full resize-none rounded-2xl border border-gray-800 bg-gray-900/70 px-4 py-3 text-sm leading-6 text-gray-100 outline-none placeholder:text-gray-600 focus:border-blue-400 disabled:cursor-wait"
        />
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <label className="flex items-center gap-2 text-sm text-gray-400">
            <span>AI:</span>
            <select
              data-testid="invoker-terminal-harness"
              value={selectedPresetKey}
              onChange={(event) => onPresetChange(event.target.value)}
              disabled={readOnly}
              className="rounded-full border border-gray-800 bg-gray-950 px-3 py-2 text-sm text-gray-200 outline-none hover:border-gray-600 focus:border-blue-400"
            >
              {presetOptions.map((option) => (
                <option key={option.key} value={option.key}>{option.label}</option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            disabled={busy || readOnly || !value.trim()}
            className="rounded-full bg-blue-400 px-5 py-2 text-sm font-medium text-gray-950 hover:bg-blue-300 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Send
          </button>
        </div>
      </form>
    </section>
  );
}
