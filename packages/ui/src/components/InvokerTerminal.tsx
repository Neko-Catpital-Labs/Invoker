import { useMemo, useState, type FormEvent, type ReactElement } from 'react';
import type {
  DraftPlanSummary,
  DraftPlanTaskGroupSummary,
  DraftPlanTaskSummary,
  PlanningChatSendResult,
} from '../types.js';

interface InvokerTerminalProps {
  draftPlanSummary: DraftPlanSummary | null;
  canSubmitDraftPlan: boolean;
  onPlanningChatSend: (message: string, sessionId?: string | null) => Promise<PlanningChatSendResult>;
  onSubmitDraftPlan: () => Promise<void> | void;
  onClearDraftPlan: () => void;
}

interface TerminalMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface NormalizedTaskGroup {
  name: string;
  taskCount: number;
  tasks: readonly DraftPlanTaskSummary[];
}

function taskLabel(task: DraftPlanTaskSummary, index: number): string {
  return task.title ?? task.name ?? task.description ?? task.id ?? `Task ${index + 1}`;
}

function normalizeTaskGroups(summary: DraftPlanSummary): NormalizedTaskGroup[] {
  const groups = summary.taskGroups ?? [];
  if (groups.length === 0 && summary.tasks && summary.tasks.length > 0) {
    return [{ name: 'Tasks', taskCount: summary.tasks.length, tasks: summary.tasks }];
  }

  return groups.map((group: DraftPlanTaskGroupSummary, index) => {
    const tasks = group.tasks ?? [];
    return {
      name: group.name ?? `Group ${index + 1}`,
      taskCount: group.taskCount ?? tasks.length,
      tasks,
    };
  });
}

export function InvokerTerminal({
  draftPlanSummary,
  canSubmitDraftPlan,
  onPlanningChatSend,
  onSubmitDraftPlan,
  onClearDraftPlan,
}: InvokerTerminalProps): ReactElement {
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<TerminalMessage[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const taskGroups = useMemo(
    () => draftPlanSummary ? normalizeTaskGroups(draftPlanSummary) : [],
    [draftPlanSummary],
  );

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const message = input.trim();
    if (!message || pending) return;

    setInput('');
    setError(null);
    setPending(true);
    setMessages((prev) => [...prev, { role: 'user', content: message }]);

    try {
      const result = await onPlanningChatSend(message, sessionId);
      if (result.sessionId) setSessionId(result.sessionId);
      if (result.assistantMessage) {
        setMessages((prev) => [...prev, { role: 'assistant', content: result.assistantMessage ?? '' }]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  };

  return (
    <div data-testid="invoker-terminal" className="flex h-full min-h-0 gap-3">
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="min-h-0 flex-1 overflow-auto rounded border border-gray-800 bg-gray-900/80 px-3 py-2">
          {messages.length === 0 ? (
            <div className="text-xs text-gray-500">Planning session idle.</div>
          ) : (
            <div className="space-y-2">
              {messages.map((message, index) => (
                <div key={`${message.role}-${index}`} className="text-xs">
                  <span className={message.role === 'user' ? 'text-blue-300' : 'text-green-300'}>
                    {message.role === 'user' ? 'You' : 'Planner'}
                  </span>
                  <span className="ml-2 whitespace-pre-wrap text-gray-300">{message.content}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {error && (
          <div role="alert" className="text-xs text-red-300">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="flex gap-2">
          <input
            data-testid="invoker-terminal-planner-input"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="Message planner"
            className="min-w-0 flex-1 rounded border border-gray-700 bg-gray-900 px-2 py-1.5 text-xs text-gray-100 outline-none placeholder:text-gray-500 focus:border-blue-500"
          />
          <button
            data-testid="invoker-terminal-send"
            type="submit"
            disabled={!input.trim() || pending}
            className="rounded border border-blue-600 bg-blue-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-600 disabled:cursor-not-allowed disabled:border-gray-700 disabled:bg-gray-800 disabled:text-gray-500"
          >
            {pending ? 'Sending' : 'Send'}
          </button>
        </form>
      </div>

      <aside className="flex w-80 shrink-0 flex-col overflow-hidden rounded border border-gray-800 bg-gray-900/80">
        {draftPlanSummary ? (
          <div data-testid="invoker-terminal-ready-bar" className="flex h-full min-h-0 flex-col">
            <div className="border-b border-gray-800 px-3 py-2">
              <div className="text-[11px] font-medium uppercase text-green-300">Plan ready</div>
              <div className="mt-1 truncate text-sm font-semibold text-gray-100" title={draftPlanSummary.name}>
                {draftPlanSummary.name}
              </div>
              <div className="text-xs text-gray-400">
                {draftPlanSummary.taskCount} {draftPlanSummary.taskCount === 1 ? 'task' : 'tasks'}
              </div>
            </div>

            <div data-testid="invoker-terminal-ready-task-list" className="min-h-0 flex-1 overflow-auto px-3 py-2">
              {taskGroups.length > 0 ? (
                <div className="space-y-3">
                  {taskGroups.map((group, groupIndex) => (
                    <section key={`${group.name}-${groupIndex}`}>
                      <div className="flex items-center justify-between gap-2 text-xs">
                        <span className="truncate font-medium text-gray-200">{group.name}</span>
                        <span className="shrink-0 text-gray-500">
                          {group.taskCount} {group.taskCount === 1 ? 'task' : 'tasks'}
                        </span>
                      </div>
                      {group.tasks.length > 0 && (
                        <ol className="mt-1 space-y-1 text-xs text-gray-400">
                          {group.tasks.map((task, taskIndex) => (
                            <li key={task.id ?? `${group.name}-${taskIndex}`} className="truncate">
                              {taskLabel(task, taskIndex)}
                            </li>
                          ))}
                        </ol>
                      )}
                    </section>
                  ))}
                </div>
              ) : (
                <div className="text-xs text-gray-400">
                  {draftPlanSummary.taskCount} {draftPlanSummary.taskCount === 1 ? 'task' : 'tasks'}
                </div>
              )}
            </div>

            <div className="flex gap-2 border-t border-gray-800 px-3 py-2">
              <button
                data-testid="invoker-terminal-submit-draft-plan"
                type="button"
                disabled={!canSubmitDraftPlan}
                onClick={() => void onSubmitDraftPlan()}
                className="flex-1 rounded bg-green-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-600 disabled:cursor-not-allowed disabled:bg-gray-800 disabled:text-gray-500"
              >
                Submit
              </button>
              <button
                data-testid="invoker-terminal-clear-draft-plan"
                type="button"
                onClick={onClearDraftPlan}
                className="rounded border border-gray-700 px-3 py-1.5 text-xs text-gray-300 hover:bg-gray-800"
              >
                Clear
              </button>
            </div>
          </div>
        ) : (
          <div className="px-3 py-2 text-xs text-gray-500">No draft plan yet.</div>
        )}
      </aside>
    </div>
  );
}
