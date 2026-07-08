import { useCallback, useMemo, useRef, useState } from 'react';
import type { TaskState, WorkerActionSummary, WorkerStatusSnapshot } from '../types.js';
import { getStatusColor } from '../lib/colors.js';
import {
  displayWorkerTaskId,
  formatWorkerValue,
  getWorkerActionLabel,
  getWorkerDisplayCopy,
} from '../lib/worker-display.js';
import { useWorkerActionHistory, WORKER_ACTION_HISTORY_PAGE_SIZE } from '../hooks/useWorkerActionHistory.js';
import { WorkerActivityCard } from './WorkerActivityCard.js';

interface QueueViewProps {
  tasks: Map<string, TaskState>;
  workerStatus: WorkerStatusSnapshot | null;
  readOnly: boolean;
  onStartWorker: (kind: string) => Promise<void> | void;
  onStopWorker: (kind: string) => Promise<void> | void;
  onTaskClick: (task: TaskState) => void;
  selectedTaskId: string | null;
  selectedWorkerKind: string | null;
  onSelectWorker: (kind: string) => void;
  /** Page size for the history pane; each "load older" click fetches one more page. */
  historyPageSize?: number;
}

function actionTargetLabel(action: WorkerActionSummary, tasks: Map<string, TaskState>): string {
  if (action.taskId) {
    return tasks.get(action.taskId)?.description || displayWorkerTaskId(action.taskId);
  }
  return `${formatWorkerValue(action.subjectType)} ${action.subjectId}`;
}

export function QueueView({
  tasks,
  workerStatus,
  readOnly,
  onStartWorker,
  onStopWorker,
  onTaskClick,
  selectedTaskId,
  selectedWorkerKind,
  onSelectWorker,
  historyPageSize = WORKER_ACTION_HISTORY_PAGE_SIZE,
}: QueueViewProps) {
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  const { actions, loading, loadingMore, hasMore, error, loadMore } = useWorkerActionHistory(
    selectedWorkerKind,
    historyPageSize,
  );

  /** Reverse index: taskId → list of task IDs that depend on it. */
  const dependentsMap = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const [, task] of tasks) {
      for (const dep of task.dependencies) {
        let list = map.get(dep);
        if (!list) {
          list = [];
          map.set(dep, list);
        }
        list.push(task.id);
      }
    }
    return map;
  }, [tasks]);

  const toggleExpanded = useCallback((rowKey: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(rowKey)) next.delete(rowKey);
      else next.add(rowKey);
      return next;
    });
  }, []);

  const handleRelatedClick = useCallback(
    (taskId: string, e: React.MouseEvent) => {
      e.stopPropagation();
      const task = tasks.get(taskId);
      if (task) onTaskClick(task);
      const el = rowRefs.current.get(taskId);
      if (el?.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    },
    [tasks, onTaskClick],
  );

  const copy = selectedWorkerKind ? getWorkerDisplayCopy(selectedWorkerKind) : null;
  const subtitle = copy
    ? `Recorded actions for ${copy.name}, newest first.`
    : 'Select a worker process to see its history.';

  let emptyState: JSX.Element | null = null;
  if (actions.length === 0) {
    if (!selectedWorkerKind) {
      emptyState = (
        <div className="rounded-xl border border-gray-800 bg-gray-850/60 p-4 text-sm text-gray-400">
          Select a worker process to see its recorded history.
        </div>
      );
    } else if (loading) {
      emptyState = (
        <div data-testid="worker-history-loading" className="rounded-xl border border-gray-800 bg-gray-850/60 p-4 text-sm text-gray-400">
          Loading history…
        </div>
      );
    } else if (error) {
      emptyState = (
        <div data-testid="worker-history-error" className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-4 text-sm text-rose-200">
          Couldn’t load history: {error}
        </div>
      );
    } else {
      emptyState = (
        <div className="rounded-xl border border-gray-800 bg-gray-850/60 p-4 text-sm text-gray-400">
          {copy?.noActionText}
        </div>
      );
    }
  }

  return (
    <div className="grid h-full min-h-0 grid-cols-[minmax(20rem,24rem)_minmax(28rem,1fr)] overflow-hidden bg-gray-900">
      <section data-testid="action-queue-section" className="flex h-full min-h-0 flex-col overflow-hidden border-r border-gray-800">
        <div className="shrink-0 border-b border-gray-800 p-4">
          <h3 data-testid="worker-history-title" className="text-lg font-semibold text-gray-100">
            History ({actions.length})
          </h3>
          <div className="mt-1 text-sm text-gray-400">{subtitle}</div>
        </div>

        <div data-testid="worker-action-list" className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          <div className="space-y-1">
            {actions.map((action) => {
              const task = action.taskId ? tasks.get(action.taskId) ?? null : null;
              const rowKey = action.id;
              const taskId = action.taskId;
              const upstream = task?.dependencies ?? [];
              const downstream = taskId ? dependentsMap.get(taskId) ?? [] : [];
              const hasRelationships = upstream.length > 0 || downstream.length > 0;
              const isExpanded = expandedRows.has(rowKey);
              const colors = getStatusColor(action.status);
              const label = getWorkerActionLabel(action);
              return (
                <div
                  key={rowKey}
                  ref={(el) => {
                    if (el && taskId) rowRefs.current.set(taskId, el);
                  }}
                  data-row-id={taskId ?? action.id}
                  className={`rounded-xl border ${
                    taskId && selectedTaskId === taskId
                      ? 'border-cyan-500/80 bg-cyan-950/30 ring-1 ring-cyan-500/60'
                      : 'border-gray-800 bg-gray-850/60 hover:border-gray-700 hover:bg-gray-800/80'
                  }`}
                >
                  <div className="flex items-stretch">
                    {hasRelationships ? (
                      <button
                        type="button"
                        onClick={(e) => toggleExpanded(rowKey, e)}
                        className="flex w-8 shrink-0 items-center justify-center rounded-l-xl text-sm text-gray-400 hover:bg-gray-700 hover:text-gray-100"
                        aria-label={isExpanded ? 'Collapse relationships' : 'Expand relationships'}
                        aria-expanded={isExpanded}
                        data-testid={`queue-rels-toggle-action-${taskId}`}
                      >
                        {isExpanded ? '▾' : '▸'}
                      </button>
                    ) : (
                      <div className="w-8 shrink-0" aria-hidden="true" />
                    )}
                    <button
                      type="button"
                      disabled={!task}
                      onClick={() => task && onTaskClick(task)}
                      className={`min-w-0 flex-1 p-3 text-left ${task ? 'cursor-pointer' : 'cursor-default'}`}
                    >
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium text-gray-100">{label}</span>
                        <span className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-xs ${colors.bg} ${colors.border} ${colors.text}`}>
                          <span className={`h-1.5 w-1.5 rounded-full ${colors.dot}`} aria-hidden="true" />
                          {formatWorkerValue(action.status)}
                        </span>
                      </div>
                      <div className="mt-1 truncate text-xs text-gray-400">
                        {actionTargetLabel(action, tasks)}
                      </div>
                      {action.summary ? (
                        <div className="mt-1 truncate text-xs text-gray-500">{action.summary}</div>
                      ) : null}
                      {taskId && !task ? (
                        <div className="mt-1 truncate text-xs text-amber-300">Target task is not loaded.</div>
                      ) : null}
                    </button>
                  </div>
                  {isExpanded && taskId && (
                    <div className="mx-3 mb-3 border-t border-gray-700 pb-1 pt-2 text-xs" data-testid={`rels-${taskId}`}>
                      {upstream.length > 0 && (
                        <div className="mb-1">
                          <span className="text-gray-500">upstream: </span>
                          {upstream.map((depId) => (
                            <button
                              key={depId}
                              type="button"
                              onClick={(e) => handleRelatedClick(depId, e)}
                              className="mr-1 inline-block cursor-pointer rounded bg-blue-900 px-1.5 py-0.5 text-blue-300 hover:bg-blue-800"
                            >
                              {displayWorkerTaskId(depId)}
                            </button>
                          ))}
                        </div>
                      )}
                      {downstream.length > 0 && (
                        <div>
                          <span className="text-gray-500">downstream: </span>
                          {downstream.map((depId) => (
                            <button
                              key={depId}
                              type="button"
                              onClick={(e) => handleRelatedClick(depId, e)}
                              className="mr-1 inline-block cursor-pointer rounded bg-green-900 px-1.5 py-0.5 text-green-300 hover:bg-green-800"
                            >
                              {displayWorkerTaskId(depId)}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
            {emptyState}
            {hasMore ? (
              <button
                type="button"
                data-testid="worker-history-load-more"
                onClick={loadMore}
                disabled={loadingMore}
                className="mt-2 w-full rounded-xl border border-gray-800 bg-gray-850/60 px-3 py-2 text-sm text-gray-300 hover:border-gray-700 hover:bg-gray-800/80 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {loadingMore ? 'Loading…' : 'Load older actions'}
              </button>
            ) : null}
            {error && actions.length > 0 ? (
              <div data-testid="worker-history-error" className="mt-2 rounded-xl border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
                Couldn’t load more history: {error}
              </div>
            ) : null}
          </div>
        </div>
      </section>

      <section data-testid="worker-processes-section" className="flex h-full min-h-0 flex-col overflow-hidden">
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <WorkerActivityCard
            snapshot={workerStatus}
            selectedWorkerKind={selectedWorkerKind}
            readOnly={readOnly}
            onStartWorker={onStartWorker}
            onStopWorker={onStopWorker}
            onSelectWorker={onSelectWorker}
          />
        </div>
      </section>
    </div>
  );
}
