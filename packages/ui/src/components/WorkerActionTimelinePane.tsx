import { useEffect, useMemo, useState } from 'react';
import type { TaskState, WorkerActionSummary, WorkflowMeta } from '../types.js';
import { useNow } from '../hooks/useNow.js';
import { useWorkerTimelineActions } from '../hooks/useWorkerTimelineActions.js';
import {
  displayWorkerTaskId,
  formatWorkerValue,
  getWorkerDisplayCopy,
  resolveWorkerActionTarget,
  ACTIVE_WORKER_ACTION_STATUSES,
} from '../lib/worker-display.js';
import {
  buildWorkerTimelineEventRows,
  sortWorkerTimelineActions,
  sortWorkerTimelineEventRows,
  type WorkerTimelineEventKind,
  type WorkerTimelineEventRow,
} from '../lib/worker-timeline.js';

interface WorkerActionTimelinePaneProps {
  tasks: Map<string, TaskState>;
  workflows: Map<string, WorkflowMeta>;
  selectedTaskId: string | null;
  selectedWorkflowId: string | null;
  onTaskClick: (task: TaskState) => void;
}

const ACTION_TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit',
});

function resolveDefaultWorkflowId(
  workflows: Map<string, WorkflowMeta>,
  selectedWorkflowId: string | null,
  selectedTaskId: string | null,
  tasks: Map<string, TaskState>,
): string | null {
  if (selectedWorkflowId) return selectedWorkflowId;
  const selectedTaskWorkflowId = selectedTaskId ? tasks.get(selectedTaskId)?.config.workflowId : undefined;
  if (selectedTaskWorkflowId && workflows.has(selectedTaskWorkflowId)) return selectedTaskWorkflowId;
  return [...workflows.values()]
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))[0]?.id ?? null;
}

function resolveWorkerActionTaskId(action: WorkerActionSummary): string | null {
  return action.taskId ?? (action.subjectType === 'task' ? action.subjectId : null);
}

function resolveWorkerActionTaskLabel(
  action: WorkerActionSummary,
  tasks: Map<string, TaskState>,
  workflows: Map<string, WorkflowMeta>,
): string {
  const target = resolveWorkerActionTarget(action, tasks, workflows);
  if (target.task?.description) return target.task.description;
  const taskId = resolveWorkerActionTaskId(action);
  return taskId ? displayWorkerTaskId(taskId) : target.taskTitle;
}

function matchesWorkerTimelineTaskSearch(
  action: WorkerActionSummary,
  taskSearch: string,
  tasks: Map<string, TaskState>,
  workflows: Map<string, WorkflowMeta>,
): boolean {
  const query = taskSearch.trim().toLocaleLowerCase();
  if (query === '') return true;
  return resolveWorkerActionTaskLabel(action, tasks, workflows).toLocaleLowerCase().includes(query);
}

function formatActionTimestamp(timestampMs: number): string {
  return ACTION_TIME_FORMATTER.format(new Date(timestampMs));
}

function formatWorkerEventLabel(eventKind: WorkerTimelineEventKind): string {
  return eventKind === 'launched' ? 'Launched' : 'Finished executing';
}

function describeWhy(action: WorkerActionSummary): { why: string | null; result: string | null } {
  return {
    why: action.reason ?? null,
    result: action.summary ?? null,
  };
}

export function WorkerActionTimelinePane({
  tasks,
  workflows,
  selectedTaskId,
  selectedWorkflowId,
  onTaskClick,
}: WorkerActionTimelinePaneProps) {
  const defaultWorkflowId = useMemo(
    () => resolveDefaultWorkflowId(workflows, selectedWorkflowId, selectedTaskId, tasks),
    [selectedTaskId, selectedWorkflowId, tasks, workflows],
  );
  const [workflowOverrideId, setWorkflowOverrideId] = useState<string | null>(null);
  const [workerFilter, setWorkerFilter] = useState<Set<string>>(() => new Set());
  const [taskFilter, setTaskFilter] = useState('');

  useEffect(() => {
    if (workflowOverrideId && !workflows.has(workflowOverrideId)) {
      setWorkflowOverrideId(null);
    }
  }, [workflowOverrideId, workflows]);

  const workflowId = workflowOverrideId && workflows.has(workflowOverrideId)
    ? workflowOverrideId
    : defaultWorkflowId;

  const { actions, loading, loadingMore, hasMore, loadMore } = useWorkerTimelineActions(workflowId);

  useEffect(() => {
    setWorkerFilter(new Set());
    setTaskFilter('');
  }, [workflowId]);

  const sortedActions = useMemo(() => sortWorkerTimelineActions(actions), [actions]);
  const workerKinds = useMemo(() => {
    const seen = new Set<string>();
    const values: string[] = [];
    for (const action of sortedActions) {
      if (seen.has(action.workerKind)) continue;
      seen.add(action.workerKind);
      values.push(action.workerKind);
    }
    return values.sort((a, b) => getWorkerDisplayCopy(a).name.localeCompare(getWorkerDisplayCopy(b).name));
  }, [sortedActions]);

  const filteredActions = useMemo(() => sortedActions.filter((action) => {
    if (workerFilter.size > 0 && !workerFilter.has(action.workerKind)) return false;
    return matchesWorkerTimelineTaskSearch(action, taskFilter, tasks, workflows);
  }), [sortedActions, taskFilter, tasks, workflows, workerFilter]);

  const now = useNow(
    1000,
    filteredActions.some((action) => ACTIVE_WORKER_ACTION_STATUSES.has(action.status)),
  );

  const timelineRows = useMemo(() => {
    const rows: WorkerTimelineEventRow[] = [];
    for (const action of filteredActions) {
      const actionRows = buildWorkerTimelineEventRows(action, now);
      if (!actionRows) {
        console.warn('[worker-timeline] skipped action with invalid timestamp', {
          id: action.id,
          workerKind: action.workerKind,
        });
        continue;
      }
      rows.push(...actionRows);
      if (action.completedAt && actionRows.length === 1) {
        console.warn('[worker-timeline] skipped action with invalid timestamp', {
          id: action.id,
          workerKind: action.workerKind,
        });
      }
    }
    return sortWorkerTimelineEventRows(rows);
  }, [filteredActions, now]);

  const totalRowCount = useMemo(
    () => sortedActions.reduce((count, action) => count + (buildWorkerTimelineEventRows(action, now)?.length ?? 0), 0),
    [sortedActions, now],
  );
  const hasTaskFilter = taskFilter.trim() !== '';
  const anyFilterActive = workflowOverrideId !== null || workerFilter.size > 0 || hasTaskFilter;

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="worker-timeline-view">
      <div className="space-y-3 border-b border-gray-800 bg-gray-900/40 p-3">
        <div className="flex flex-wrap items-center gap-2">
          {workflows.size > 1 ? (
            <select
              data-testid="worker-timeline-workflow-select"
              aria-label="Workflow"
              value={workflowId ?? ''}
              onChange={(event) => setWorkflowOverrideId(event.target.value || null)}
              className="min-w-0 rounded border border-border-strong bg-muted px-2 py-1 text-xs text-foreground focus:border-border-strong focus:outline-none"
            >
              {[...workflows.values()]
                .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
                .map((workflow) => (
                  <option key={workflow.id} value={workflow.id}>{workflow.name}</option>
                ))}
            </select>
          ) : null}
          <input
            type="search"
            data-testid="worker-timeline-task-search"
            value={taskFilter}
            onChange={(event) => setTaskFilter(event.target.value)}
            placeholder="Search tasks"
            className="flex-1 bg-gray-900 border border-gray-700 rounded px-2 py-1 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-indigo-500"
            aria-label="Search tasks"
          />
          <span className="shrink-0 text-xs text-gray-500">{timelineRows.length} / {totalRowCount}</span>
          {anyFilterActive ? (
            <button
              type="button"
              onClick={() => {
                setWorkflowOverrideId(null);
                setWorkerFilter(new Set());
                setTaskFilter('');
              }}
              className="shrink-0 text-xs text-gray-400 hover:text-gray-100"
            >
              Clear
            </button>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-1.5" aria-label="Filter by worker">
          {workerKinds.map((workerKind) => {
            const active = workerFilter.has(workerKind);
            return (
              <button
                key={workerKind}
                type="button"
                data-testid={`worker-timeline-filter-${workerKind}`}
                aria-pressed={active}
                onClick={() => {
                  setWorkerFilter((current) => {
                    const next = new Set(current);
                    if (next.has(workerKind)) next.delete(workerKind);
                    else next.add(workerKind);
                    return next;
                  });
                }}
                className={`rounded px-2 py-1 text-xs ${active ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-secondary'}`}
              >
                {getWorkerDisplayCopy(workerKind).name}
              </button>
            );
          })}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading && sortedActions.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Loading worker actions…</div>
        ) : sortedActions.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            No worker actions recorded for this workflow yet.
          </div>
        ) : filteredActions.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            No worker actions match the current filters.
          </div>
        ) : timelineRows.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            No matching worker actions have valid timestamps.
          </div>
        ) : (
          <>
            <ol className="space-y-1.5 p-3" data-testid="worker-timeline-list">
              {timelineRows.map((row) => {
                const target = resolveWorkerActionTarget(row.action, tasks, workflows);
                const taskId = resolveWorkerActionTaskId(row.action);
                const taskLabel = resolveWorkerActionTaskLabel(row.action, tasks, workflows);
                const taskWarning = !target.task && Boolean(taskId);
                const interactive = Boolean(target.task);
                const detail = describeWhy(row.action);
                const worker = getWorkerDisplayCopy(row.action.workerKind);
                const selected = target.task?.id === selectedTaskId;
                return (
                  <li
                    key={`${row.action.id}-${row.eventKind}`}
                    data-testid={`worker-timeline-row-${row.action.id}-${row.eventKind}`}
                  >
                    <button
                      type="button"
                      data-testid={`worker-timeline-action-${row.action.id}-${row.eventKind}`}
                      disabled={!interactive}
                      onClick={() => {
                        if (target.task) onTaskClick(target.task);
                      }}
                      className={`w-full rounded px-3 py-2 text-left ${selected ? 'bg-secondary/60' : ''} ${interactive ? 'cursor-pointer hover:bg-secondary/40' : 'cursor-default opacity-90'}`}
                      title={`${worker.name} · ${formatWorkerValue(row.action.actionType)} · ${taskLabel}`}
                    >
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                        <span className="font-medium text-foreground">{worker.name}</span>
                        <span className="text-muted-foreground">{formatWorkerValue(row.action.actionType)}</span>
                        <span className="text-muted-foreground">{formatWorkerEventLabel(row.eventKind)}</span>
                        <span className="text-foreground">{taskLabel}</span>
                        <span className="ml-auto text-xs text-muted-foreground">
                          {formatActionTimestamp(row.timestampMs)}
                        </span>
                      </div>
                      {detail.why ? (
                        <div className="mt-1 text-xs text-muted-foreground">
                          <span className="font-medium text-foreground/80">Why:</span>{' '}
                          {detail.why}
                        </div>
                      ) : null}
                      {detail.result ? (
                        <div className="mt-1 text-xs text-muted-foreground">
                          <span className="font-medium text-foreground/80">Result:</span>{' '}
                          {detail.result}
                        </div>
                      ) : null}
                      {taskWarning ? (
                        <div className="mt-1 text-xs text-amber-300">Target task is not loaded.</div>
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ol>
            {hasMore ? (
              <div className="flex justify-center px-3 pb-3">
                <button
                  type="button"
                  data-testid="worker-timeline-load-more"
                  onClick={() => void loadMore()}
                  disabled={loadingMore}
                  className="rounded border border-border-strong bg-muted px-3 py-1.5 text-sm text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {loadingMore ? 'Loading…' : 'Load older worker actions'}
                </button>
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
