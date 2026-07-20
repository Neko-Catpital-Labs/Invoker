import { useState } from 'react';
import type { FormEvent } from 'react';

export interface DraftPlanSummaryTask {
  readonly id?: string;
  readonly title?: string;
  readonly name?: string;
  readonly description?: string;
  readonly summary?: string;
}

export interface DraftPlanSummaryTaskGroup {
  readonly id?: string;
  readonly title?: string;
  readonly name?: string;
  readonly label?: string;
  readonly taskCount?: number;
  readonly count?: number;
  readonly taskIds?: readonly string[];
  readonly tasks?: readonly (DraftPlanSummaryTask | string)[];
}

export interface DraftPlanSummary {
  readonly planName?: string;
  readonly name?: string;
  readonly title?: string;
  readonly taskCount?: number;
  readonly count?: number;
  readonly taskGroups?: readonly DraftPlanSummaryTaskGroup[];
  readonly groups?: readonly DraftPlanSummaryTaskGroup[];
  readonly tasks?: readonly (DraftPlanSummaryTask | string)[];
  readonly summary?: string;
}

export type PlanningChatSendResponse =
  | string
  | {
      readonly reply?: string;
      readonly content?: string;
      readonly message?: string;
      readonly draftPlanSummary?: DraftPlanSummary | null;
      readonly planSubmitted?: boolean;
      readonly submittedPlanText?: string | null;
      readonly planText?: string | null;
    };

interface PlanningChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface InvokerTerminalProps {
  collapsed: boolean;
  onToggle: () => void;
  draftPlanSummary?: DraftPlanSummary | null;
  onPlanningChatSend?: (message: string) => Promise<PlanningChatSendResponse>;
  onClearPlanningChat?: () => void;
}

interface NormalizedTask {
  id: string;
  label: string;
}

interface NormalizedTaskGroup {
  id: string;
  label: string;
  taskCount: number;
  tasks: NormalizedTask[];
}

function assistantContentFromResponse(response: PlanningChatSendResponse): string {
  if (typeof response === 'string') return response;
  return response.reply ?? response.content ?? response.message ?? '';
}

function planName(summary: DraftPlanSummary): string {
  return summary.planName ?? summary.name ?? summary.title ?? 'Untitled plan';
}

function normalizeTask(task: DraftPlanSummaryTask | string, index: number): NormalizedTask {
  if (typeof task === 'string') {
    return { id: task || `task-${index + 1}`, label: task || `Task ${index + 1}` };
  }

  const id = task.id ?? task.name ?? task.title ?? `task-${index + 1}`;
  const label = task.description ?? task.title ?? task.name ?? task.id ?? `Task ${index + 1}`;
  return { id, label };
}

function normalizeTaskGroups(summary: DraftPlanSummary): NormalizedTaskGroup[] {
  const topLevelTasks = (summary.tasks ?? []).map(normalizeTask);
  const taskById = new Map(topLevelTasks.map((task) => [task.id, task]));
  const rawGroups = summary.taskGroups ?? summary.groups ?? [];

  if (rawGroups.length === 0) {
    return topLevelTasks.length > 0
      ? [{ id: 'tasks', label: 'Tasks', taskCount: topLevelTasks.length, tasks: topLevelTasks }]
      : [];
  }

  return rawGroups.map((group, groupIndex) => {
    const explicitTasks = (group.tasks ?? []).map(normalizeTask);
    const referencedTasks = (group.taskIds ?? []).map((taskId, taskIndex) => (
      taskById.get(taskId) ?? { id: taskId, label: taskId || `Task ${taskIndex + 1}` }
    ));
    const tasks = explicitTasks.length > 0 ? explicitTasks : referencedTasks;
    const label = group.title ?? group.name ?? group.label ?? `Group ${groupIndex + 1}`;
    const id = group.id ?? label;
    return {
      id,
      label,
      taskCount: group.taskCount ?? group.count ?? tasks.length,
      tasks,
    };
  });
}

function summaryTaskCount(summary: DraftPlanSummary, groups: NormalizedTaskGroup[]): number {
  return summary.taskCount ?? summary.count ?? groups.reduce((total, group) => total + group.taskCount, 0);
}

function pluralizeTasks(count: number): string {
  return `${count} ${count === 1 ? 'task' : 'tasks'}`;
}

export function InvokerTerminal({
  collapsed,
  onToggle,
  draftPlanSummary,
  onPlanningChatSend,
  onClearPlanningChat,
}: InvokerTerminalProps): JSX.Element {
  const [messages, setMessages] = useState<PlanningChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const taskGroups = draftPlanSummary ? normalizeTaskGroups(draftPlanSummary) : [];
  const taskCount = draftPlanSummary ? summaryTaskCount(draftPlanSummary, taskGroups) : 0;

  const sendMessage = async (message: string) => {
    const trimmed = message.trim();
    if (!trimmed || sending) return;

    setError(null);
    setSending(true);
    setMessages((prev) => [...prev, { role: 'user', content: trimmed }]);

    try {
      if (!onPlanningChatSend) {
        throw new Error('Planning chat is unavailable.');
      }
      const response = await onPlanningChatSend(trimmed);
      const assistantContent = assistantContentFromResponse(response);
      if (assistantContent) {
        setMessages((prev) => [...prev, { role: 'assistant', content: assistantContent }]);
      }
      setInput('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void sendMessage(input);
  };

  const handleSubmitPlan = () => {
    void sendMessage('yes');
  };

  const handleClear = () => {
    setMessages([]);
    setInput('');
    setError(null);
    onClearPlanningChat?.();
  };

  return (
    <div className="border-t border-gray-800 bg-gray-950">
      <div className="flex items-center justify-between gap-3 px-3 py-2 border-b border-gray-800">
        <div className="flex items-center gap-3 text-xs text-gray-300">
          <button className="hover:text-white">Terminal</button>
          <button className="hover:text-white">Logs</button>
          <button className="hover:text-white">Problems</button>
        </div>
        <button
          onClick={onToggle}
          aria-label={collapsed ? 'Expand terminal drawer' : 'Collapse terminal drawer'}
          className="rounded border border-gray-700 px-2 py-1 text-[11px] text-gray-300 hover:bg-gray-800"
        >
          {collapsed ? 'Expand' : 'Minimize'}
        </button>
      </div>

      {!collapsed && (
        <div className="h-56 overflow-auto px-3 py-2 text-xs text-gray-300">
          {draftPlanSummary && (
            <div
              data-testid="invoker-terminal-ready-bar"
              className="mb-3 rounded border border-emerald-800 bg-emerald-950/35 p-3"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-[11px] font-medium uppercase text-emerald-300">Draft ready</div>
                  <div
                    data-testid="invoker-terminal-ready-plan-name"
                    className="truncate text-sm font-semibold text-emerald-50"
                    title={planName(draftPlanSummary)}
                  >
                    {planName(draftPlanSummary)}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <div
                    data-testid="invoker-terminal-ready-task-count"
                    className="rounded border border-emerald-800 px-2 py-1 text-[11px] text-emerald-100"
                  >
                    {pluralizeTasks(taskCount)}
                  </div>
                  <button
                    data-testid="invoker-terminal-submit-plan"
                    onClick={handleSubmitPlan}
                    disabled={sending}
                    className="rounded bg-emerald-700 px-2 py-1 text-[11px] font-medium text-white hover:bg-emerald-600 disabled:opacity-50"
                  >
                    Submit
                  </button>
                  <button
                    data-testid="invoker-terminal-clear-plan"
                    onClick={handleClear}
                    className="rounded border border-emerald-800 px-2 py-1 text-[11px] text-emerald-100 hover:bg-emerald-900"
                  >
                    Clear
                  </button>
                </div>
              </div>

              {taskGroups.length > 0 && (
                <div data-testid="invoker-terminal-ready-task-list" className="mt-3 space-y-2">
                  {taskGroups.map((group) => (
                    <div key={group.id} data-testid={`invoker-terminal-ready-task-group-${group.id}`}>
                      <div className="flex items-center gap-2 text-[11px] font-medium text-emerald-200">
                        <span>{group.label}</span>
                        <span className="text-emerald-400">{pluralizeTasks(group.taskCount)}</span>
                      </div>
                      {group.tasks.length > 0 && (
                        <ul className="mt-1 space-y-1 text-gray-200">
                          {group.tasks.map((task) => (
                            <li key={task.id} className="flex gap-2">
                              <span className="font-mono text-[10px] text-emerald-400">{task.id}</span>
                              <span>{task.label}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {messages.length > 0 && (
            <div data-testid="invoker-terminal-messages" className="mb-3 space-y-2">
              {messages.map((message, index) => (
                <div key={`${message.role}-${index}`} className="rounded border border-gray-800 bg-gray-900/70 px-2 py-1.5">
                  <div className="mb-1 text-[10px] uppercase text-gray-500">{message.role}</div>
                  <div className="whitespace-pre-wrap text-gray-200">{message.content}</div>
                </div>
              ))}
            </div>
          )}

          <form onSubmit={handleSubmit} className="flex gap-2">
            <label htmlFor="invoker-terminal-input" className="sr-only">Planner message</label>
            <textarea
              id="invoker-terminal-input"
              data-testid="invoker-terminal-input"
              value={input}
              onChange={(event) => setInput(event.currentTarget.value)}
              rows={2}
              className="min-h-12 flex-1 resize-none rounded border border-gray-700 bg-gray-900 px-2 py-1.5 text-xs text-gray-100 outline-none focus:border-gray-500"
              placeholder="Describe the plan change"
            />
            <button
              data-testid="invoker-terminal-send"
              type="submit"
              disabled={sending || input.trim().length === 0}
              className="self-stretch rounded bg-gray-700 px-3 text-xs font-medium text-white hover:bg-gray-600 disabled:opacity-50"
            >
              Send
            </button>
          </form>
          {error && (
            <div data-testid="invoker-terminal-error" className="mt-2 text-[11px] text-red-300">
              {error}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
