import { useCallback, useMemo, useRef, useState } from 'react';
import type { QueueStatus, TaskState, WorkerActionSummary, WorkerStatusEntry, WorkerStatusSnapshot, WorkflowMeta } from '../types.js';
import { getStatusColor } from '../lib/colors.js';
import {
  displayWorkerTaskId,
  formatWorkerValue,
  getActiveWorkerActions,
  getWorkerDisplayCopy,
  resolveWorkerActionTarget,
} from '../lib/worker-display.js';
import { WorkerActivityCard } from './WorkerActivityCard.js';

interface QueueViewProps {
  tasks: Map<string, TaskState>;
  workflows: Map<string, WorkflowMeta>;
  queueStatus?: QueueStatus | null;
  workerStatus: WorkerStatusSnapshot | null;
  readOnly: boolean;
  onStartWorker: (kind: string) => Promise<void> | void;
  onStopWorker: (kind: string) => Promise<void> | void;
  onSetWorkersEnabled?: (enabled: boolean) => Promise<void> | void;
  onTaskClick: (task: TaskState) => void;
  selectedTaskId: string | null;
  selectedWorkerKind: string | null;
  onSelectWorker: (kind: string) => void;
}

type WorkerActionRow = {
  action: WorkerActionSummary;
  worker: WorkerStatusEntry;
};

function actionRowKey(row: WorkerActionRow): string {
  return `${row.worker.kind}:${row.action.id}`;
}

function relatedTaskLabel(taskId: string, tasks: Map<string, TaskState>): string {
  return tasks.get(taskId)?.description || displayWorkerTaskId(taskId);
}

export function QueueView({
  tasks,
  workflows,
  queueStatus = null,
  workerStatus,
  readOnly,
  onStartWorker,
  onStopWorker,
  onSetWorkersEnabled,
  onTaskClick,
  selectedTaskId,
  selectedWorkerKind,
  onSelectWorker,
}: QueueViewProps) {
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map());

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

  const actionRows = useMemo<WorkerActionRow[]>(
    () => (workerStatus?.workers ?? []).flatMap((worker) =>
      getActiveWorkerActions(worker).map((action) => ({ action, worker })),
    ),
    [workerStatus],
  );
  const queueRunning = queueStatus?.running ?? [];
  const queueQueued = queueStatus?.queued ?? [];

  const queueTaskLabel = useCallback(
    (entry: { taskId: string; description?: string }) =>
      entry.description || tasks.get(entry.taskId)?.description || displayWorkerTaskId(entry.taskId),
    [tasks],
  );

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

  return (
    <div className="grid h-full min-h-0 grid-cols-[minmax(20rem,24rem)_minmax(28rem,1fr)] grid-rows-[minmax(0,1fr)] overflow-hidden bg-background">
      <section data-testid="action-queue-section" className="flex h-full min-h-0 flex-col overflow-hidden border-r border-border">
        <div className="shrink-0 border-b border-border p-4">
          <h3 className="text-lg font-semibold text-foreground">
            Worker Actions ({actionRows.length})
          </h3>
          <div className="mt-1 text-sm text-muted-foreground">
            Only work started by a worker process appears here.
          </div>
        </div>

        <div className="shrink-0 border-b border-border px-4 py-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <section data-testid="running-queue-section-running" className="rounded-md border border-border bg-card/60 p-3">
              <div className="text-sm font-medium text-foreground">Running ({queueRunning.length})</div>
              <div className="mt-2 space-y-1 text-xs text-muted-foreground">
                {queueRunning.length > 0 ? (
                  queueRunning.map((entry) => (
                    <div key={entry.taskId} className="truncate" title={queueTaskLabel(entry)}>
                      {queueTaskLabel(entry)}
                    </div>
                  ))
                ) : (
                  <div>No running tasks.</div>
                )}
              </div>
            </section>
            <section data-testid="running-queue-section-queued" className="rounded-md border border-border bg-card/60 p-3">
              <div className="text-sm font-medium text-foreground">Queued ({queueQueued.length})</div>
              <div className="mt-2 space-y-1 text-xs text-muted-foreground">
                {queueQueued.length > 0 ? (
                  queueQueued.map((entry) => (
                    <div key={entry.taskId} className="truncate" title={queueTaskLabel(entry)}>
                      {queueTaskLabel(entry)}
                    </div>
                  ))
                ) : (
                  <div>No queued tasks.</div>
                )}
              </div>
            </section>
          </div>
        </div>

        <div data-testid="worker-action-list" className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          <div className="space-y-1">
            {actionRows.map((row) => {
              const { action, worker } = row;
              const target = resolveWorkerActionTarget(action, tasks, workflows);
              const task = target.task;
              const rowKey = actionRowKey(row);
              const taskId = action.taskId;
              const upstream = task?.dependencies ?? [];
              const downstream = taskId ? dependentsMap.get(taskId) ?? [] : [];
              const hasRelationships = upstream.length > 0 || downstream.length > 0;
              const isExpanded = expandedRows.has(rowKey);
              const colors = getStatusColor(action.status);
              const copy = getWorkerDisplayCopy(worker.kind);
              const secondaryParts = [
                copy.name,
                formatWorkerValue(action.actionType),
                ...(target.workflowName ? [target.workflowName] : []),
              ];
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
                      : 'border-border bg-card/60 hover:border-border hover:bg-secondary/80'
                  }`}
                >
                  <div className="flex items-stretch">
                    {hasRelationships ? (
                      <button
                        type="button"
                        onClick={(e) => toggleExpanded(rowKey, e)}
                        className="flex w-8 shrink-0 items-center justify-center rounded-l-xl text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
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
                        <span className="truncate text-sm font-medium text-foreground">{target.taskTitle}</span>
                        <span className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-xs ${colors.bg} ${colors.border} ${colors.text}`}>
                          <span className={`h-1.5 w-1.5 rounded-full ${colors.dot}`} aria-hidden="true" />
                          {formatWorkerValue(action.status)}
                        </span>
                      </div>
                      <div className="mt-1 truncate text-xs text-muted-foreground">
                        {secondaryParts.join(' · ')}
                      </div>
                      {action.summary ? (
                        <div className="mt-1 truncate text-xs text-muted-foreground">{action.summary}</div>
                      ) : null}
                      {taskId && !task ? (
                        <div className="mt-1 truncate text-xs text-amber-300">Target task is not loaded.</div>
                      ) : null}
                    </button>
                  </div>
                  {isExpanded && taskId && (
                    <div className="mx-3 mb-3 border-t border-border pb-1 pt-2 text-xs" data-testid={`rels-${taskId}`}>
                      {upstream.length > 0 && (
                        <div className="mb-1">
                          <span className="text-muted-foreground">upstream: </span>
                          {upstream.map((depId) => (
                            <button
                              key={depId}
                              type="button"
                              onClick={(e) => handleRelatedClick(depId, e)}
                              className="mr-1 inline-block cursor-pointer rounded bg-secondary px-1.5 py-0.5 text-foreground hover:bg-secondary"
                            >
                              {relatedTaskLabel(depId, tasks)}
                            </button>
                          ))}
                        </div>
                      )}
                      {downstream.length > 0 && (
                        <div>
                          <span className="text-muted-foreground">downstream: </span>
                          {downstream.map((depId) => (
                            <button
                              key={depId}
                              type="button"
                              onClick={(e) => handleRelatedClick(depId, e)}
                              className="mr-1 inline-block cursor-pointer rounded bg-green-900 px-1.5 py-0.5 text-green-300 hover:bg-green-800"
                            >
                              {relatedTaskLabel(depId, tasks)}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
            {actionRows.length === 0 && (
              <div className="rounded-xl border border-border bg-card/60 p-4 text-sm text-muted-foreground">
                No worker action is running.
              </div>
            )}
          </div>
        </div>
      </section>

      <section data-testid="worker-processes-section" className="flex h-full min-h-0 flex-col overflow-hidden">
        <div data-testid="worker-process-scroll" className="min-h-0 flex-1 overflow-y-auto p-4">
          <WorkerActivityCard
            snapshot={workerStatus}
            selectedWorkerKind={selectedWorkerKind}
            readOnly={readOnly}
            onStartWorker={onStartWorker}
            onStopWorker={onStopWorker}
            onSetWorkersEnabled={onSetWorkersEnabled}
            onSelectWorker={onSelectWorker}
          />
        </div>
      </section>
    </div>
  );
}
