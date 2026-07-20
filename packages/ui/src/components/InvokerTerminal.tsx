import type { FormEvent, KeyboardEvent } from 'react';

export interface InvokerTerminalLine {
  id: number;
  text: string;
  role: 'user' | 'assistant' | 'system';
  reasoning?: string;
  tone?: 'muted' | 'error' | 'success';
}

export interface InvokerTerminalPlanningStream {
  text: string;
  status: 'streaming' | 'failed';
}

interface PlanningPresetOptionView {
  key: string;
  label: string;
}

interface DraftPlanSummaryView {
  name: string;
  taskCount: number;
  workflowCount?: number;
  taskGroups?: { workflow: string | null; tasks: string[] }[];
}

interface SubmitErrorView {
  title: string;
  message: string;
}

interface InvokerTerminalProps {
  lines: InvokerTerminalLine[];
  busy: boolean;
  value: string;
  selectedPresetKey: string;
  presetOptions: PlanningPresetOptionView[];
  draftPlanAvailable: boolean;
  draftPlanSummary?: DraftPlanSummaryView;
  planningStream?: InvokerTerminalPlanningStream | null;
  submitError?: SubmitErrorView | null;
  readOnly?: boolean;
  submittedPlanName?: string;
  activeConversationKey: string;
  onValueChange: (value: string) => void;
  onSubmit: () => void;
  onSubmitDraft: () => void;
  onPresetChange: (presetKey: string) => void;
  onExpand: () => void;
  onOpenGraph?: () => void;
}

function roleLabel(role: InvokerTerminalLine['role']): string {
  if (role === 'user') return 'You';
  if (role === 'assistant') return 'Invoker';
  return 'System';
}

function readySummary(summary?: DraftPlanSummaryView): string {
  if (!summary) return 'draft ready';
  const taskLabel = `${summary.taskCount} task${summary.taskCount === 1 ? '' : 's'}`;
  if (summary.workflowCount && summary.workflowCount > 1) {
    return `draft ready · "${summary.name}" · ${summary.workflowCount} workflows · ${taskLabel}`;
  }
  return `draft ready · "${summary.name}" · ${taskLabel}`;
}

export function InvokerTerminal({
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
  submittedPlanName,
  activeConversationKey,
  onValueChange,
  onSubmit,
  onSubmitDraft,
  onPresetChange,
  onExpand,
  onOpenGraph,
}: InvokerTerminalProps): JSX.Element {
  const inputDisabled = busy || readOnly;
  const sendDisabled = inputDisabled || value.trim().length === 0;
  const inputCursorClass = readOnly ? 'disabled:cursor-not-allowed' : 'disabled:cursor-wait';

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!sendDisabled) onSubmit();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    if (!sendDisabled) onSubmit();
  };

  return (
    <section
      aria-label="Planning terminal"
      data-testid="invoker-terminal"
      data-conversation-key={activeConversationKey}
      className="flex h-full min-h-0 flex-col bg-gray-950 text-gray-100"
    >
      <div className="flex items-center justify-between border-b border-gray-800 px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold text-gray-100">Planning chat</h2>
          <div className="mt-1 text-xs text-gray-400">
            {readOnly ? 'submitted' : busy ? 'Planning your next steps...' : 'Still discussing'}
          </div>
        </div>
        <button
          type="button"
          aria-label="Expand planning chat"
          onClick={onExpand}
          className="rounded border border-gray-700 px-2.5 py-1 text-xs text-gray-300 hover:bg-gray-900"
        >
          Expand
        </button>
      </div>

      <div
        data-testid="invoker-terminal-transcript"
        className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-5 text-sm leading-6"
      >
        {lines.length === 0 && !planningStream?.text ? (
          <div data-testid="invoker-terminal-empty-hero" className="flex h-full min-h-[180px] flex-col justify-center gap-2">
            <h3 className="text-lg font-semibold text-gray-100">What do you want to build?</h3>
            <p className="max-w-xl text-sm text-gray-400">
              Describe a goal, ask questions, or compare approaches. Invoker will help scope the plan before anything is submitted.
            </p>
          </div>
        ) : (
          <>
            {lines.map((line) => (
              <article key={line.id} className="rounded border border-gray-800 bg-gray-900/60 px-3 py-2">
                <div className="text-[11px] font-medium uppercase tracking-wide text-gray-500">{roleLabel(line.role)}</div>
                {line.reasoning ? (
                  <details data-testid="invoker-terminal-thinking" className="mt-2 rounded border border-gray-800 bg-gray-950 px-2 py-1 text-xs text-gray-400">
                    <summary className="cursor-pointer">Thinking</summary>
                    <div className="mt-1 whitespace-pre-wrap">{line.reasoning}</div>
                  </details>
                ) : null}
                <div className={`mt-1 whitespace-pre-wrap ${
                  line.tone === 'error'
                    ? 'text-red-300'
                    : line.tone === 'success'
                      ? 'text-emerald-300'
                      : line.tone === 'muted'
                        ? 'text-gray-400'
                        : 'text-gray-100'
                }`}
                >
                  {line.text}
                </div>
              </article>
            ))}
            {planningStream?.text ? (
              <div
                data-testid="invoker-terminal-planner-stream"
                data-state={planningStream.status}
                className={`rounded border px-3 py-2 ${
                  planningStream.status === 'failed'
                    ? 'border-red-700 bg-red-950/30 text-red-200'
                    : 'border-gray-700 bg-gray-900/70 text-gray-100'
                }`}
              >
                <div className="flex items-center justify-between gap-3 text-xs">
                  <span className="font-medium text-gray-400">Planner stream</span>
                  <span>{planningStream.status === 'failed' ? 'failed' : 'live'}</span>
                </div>
                <div className="mt-2 whitespace-pre-wrap">{planningStream.text}</div>
              </div>
            ) : null}
          </>
        )}
      </div>

      {submitError && !readOnly ? (
        <div data-testid="invoker-terminal-submit-error" className="border-t border-red-800 bg-red-950/30 px-4 py-3 text-sm text-red-100">
          <div className="font-semibold">{submitError.title}</div>
          <div className="mt-1 whitespace-pre-wrap text-xs leading-5">{submitError.message}</div>
          <div className="mt-3 flex flex-wrap gap-2">
            {draftPlanAvailable ? (
              <button
                type="button"
                onClick={onSubmitDraft}
                disabled={busy}
                className="rounded bg-red-700 px-3 py-1.5 text-xs font-medium text-white disabled:cursor-wait disabled:opacity-50"
              >
                Retry submit
              </button>
            ) : null}
            <button type="button" className="rounded border border-gray-700 px-3 py-1.5 text-xs text-gray-200">
              Keep chatting
            </button>
          </div>
        </div>
      ) : null}

      {draftPlanAvailable && !readOnly ? (
        <div data-testid="invoker-terminal-ready-bar" className="border-t border-gray-800 bg-gray-900 px-4 py-3 text-sm">
          <div className="font-semibold text-gray-100">Plan draft ready</div>
          <p className="mt-1 text-xs text-gray-400">{readySummary(draftPlanSummary)}</p>
          {draftPlanSummary?.taskGroups?.length ? (
            <div data-testid="invoker-terminal-plan-tasks" className="mt-3 max-h-48 overflow-y-auto rounded border border-gray-800 bg-gray-950 px-3 py-2 text-xs text-gray-300">
              {draftPlanSummary.taskGroups.map((group, groupIndex) => (
                <div key={group.workflow ?? `group-${groupIndex}`} className="mb-2 last:mb-0">
                  {group.workflow ? <div className="font-semibold text-gray-100">{group.workflow}</div> : null}
                  <ul className={group.workflow ? 'mt-1 border-l border-gray-700 pl-3' : ''}>
                    {group.tasks.map((task, taskIndex) => (
                      <li key={taskIndex}>{task}</li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          ) : null}
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={onSubmitDraft}
              disabled={busy}
              className="rounded bg-amber-400 px-3 py-1.5 text-xs font-medium text-gray-950 disabled:cursor-wait disabled:opacity-50"
            >
              Submit to Invoker
            </button>
            {onOpenGraph ? (
              <button
                type="button"
                data-testid="invoker-terminal-open-graph"
                onClick={onOpenGraph}
                className="rounded border border-gray-700 px-3 py-1.5 text-xs text-gray-200"
              >
                Open graph
              </button>
            ) : null}
            <button type="button" className="rounded border border-gray-700 px-3 py-1.5 text-xs text-gray-200">
              Keep chatting
            </button>
          </div>
        </div>
      ) : null}

      {readOnly && submittedPlanName ? (
        <div data-testid="invoker-terminal-submitted-bar" className="border-t border-gray-800 bg-gray-900 px-4 py-3 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-xs text-gray-400">
              Plan ready · &quot;{submittedPlanName}&quot; · review the graph, then Start ready work
            </span>
            {onOpenGraph ? (
              <button
                type="button"
                data-testid="invoker-terminal-open-graph"
                onClick={onOpenGraph}
                className="rounded bg-amber-400 px-3 py-1.5 text-xs font-medium text-gray-950"
              >
                Open graph
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      <form className="border-t border-gray-800 px-4 py-3" onSubmit={handleSubmit}>
        <textarea
          data-testid="invoker-terminal-input"
          value={value}
          disabled={inputDisabled}
          rows={3}
          onChange={(event) => onValueChange(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={readOnly ? 'This planning session was already submitted.' : 'Describe the change or ask a planning question.'}
          className={`w-full resize-none rounded border border-gray-800 bg-gray-900 px-3 py-2 text-sm text-gray-100 placeholder:text-gray-500 ${inputCursorClass}`}
        />
        <div className="mt-2 flex items-center justify-between gap-3">
          <label className="flex items-center gap-2 text-xs text-gray-400">
            <span>Agent</span>
            <select
              data-testid="invoker-terminal-harness"
              value={selectedPresetKey}
              onChange={(event) => onPresetChange(event.target.value)}
              disabled={readOnly}
              className="rounded border border-gray-800 bg-gray-950 px-2 py-1 text-xs text-gray-100"
            >
              {presetOptions.map((option) => (
                <option key={option.key} value={option.key}>{option.label}</option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            aria-label="Send"
            disabled={sendDisabled}
            className="rounded bg-amber-400 px-3 py-1.5 text-xs font-medium text-gray-950 disabled:cursor-not-allowed disabled:bg-gray-700 disabled:text-gray-400"
          >
            Send
          </button>
        </div>
      </form>
    </section>
  );
}
