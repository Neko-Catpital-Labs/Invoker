import { useState, useEffect, useMemo, useCallback } from 'react';
import type { TaskState, TaskStatus, TaskHistoryEntry, TaskEvent, TaskDelta, InvokerAPI } from '../types.js';
import {
  categorizeEvent,
  friendlyEventLabel,
  payloadDetail,
  payloadErrorSummary,
  type EventCategory,
} from '../lib/event-labels.js';

interface HistoryViewProps {
  onTaskClick: (task: TaskState) => void;
  selectedTaskId: string | null;
}

export interface FilterState {
  search: string;
  statuses: Set<TaskStatus>;
  workflowNames: Set<string>;
  dateFrom: string;
  dateTo: string;
}

export const EMPTY_FILTER: FilterState = {
  search: '',
  statuses: new Set(),
  workflowNames: new Set(),
  dateFrom: '',
  dateTo: '',
};

const STATUS_OPTIONS: readonly TaskStatus[] = [
  'completed',
  'failed',
  'running',
  'fixing_with_ai',
  'awaiting_approval',
  'needs_input',
  'blocked',
  'pending',
  'queued',
  'review_ready',
  'stale',
  'closed',
] as const;

const STATUS_LABEL: Record<TaskStatus, string> = {
  pending: 'Pending',
  queued: 'Queued',
  running: 'Running',
  fixing_with_ai: 'Autofixing',
  completed: 'Completed',
  failed: 'Failed',
  closed: 'Closed',
  needs_input: 'Needs input',
  blocked: 'Blocked',
  review_ready: 'Review ready',
  awaiting_approval: 'Awaiting approval',
  stale: 'Stale',
};

const STATUS_STYLE: Record<TaskStatus, string> = {
  pending: 'bg-gray-700 text-gray-200',
  queued: 'bg-cyan-800 text-cyan-100',
  running: 'bg-blue-700 text-blue-100',
  fixing_with_ai: 'bg-amber-700 text-amber-100',
  completed: 'bg-emerald-700 text-emerald-100',
  failed: 'bg-red-700 text-red-100',
  closed: 'bg-gray-600 text-gray-200',
  needs_input: 'bg-purple-700 text-purple-100',
  blocked: 'bg-red-900 text-red-100',
  review_ready: 'bg-teal-700 text-teal-100',
  awaiting_approval: 'bg-purple-700 text-purple-100',
  stale: 'bg-gray-700 text-gray-300',
};

const CATEGORY_DOT: Record<EventCategory, string> = {
  'terminal-success': 'bg-emerald-500',
  'terminal-failure': 'bg-red-500',
  running: 'bg-blue-500',
  autofix: 'bg-amber-500',
  attention: 'bg-purple-500',
  info: 'bg-gray-500',
};

function formatAbsolute(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.valueOf())) return '';
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remSeconds = seconds % 60;
  if (minutes < 60) return remSeconds ? `${minutes}m ${remSeconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  if (hours < 24) return remMinutes ? `${hours}h ${remMinutes}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours ? `${days}d ${remHours}h` : `${days}d`;
}

/**
 * Match a search query against the whole task row (description, workflow name,
 * event labels for expanded tasks, and error/exit-code payloads).
 */
export function taskMatchesSearch(
  entry: TaskHistoryEntry,
  query: string,
  events: TaskEvent[] | undefined,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (entry.description?.toLowerCase().includes(q)) return true;
  if (entry.workflowName?.toLowerCase().includes(q)) return true;
  const execError = entry.execution?.error;
  if (typeof execError === 'string' && execError.toLowerCase().includes(q)) return true;
  const exit = entry.execution?.exitCode;
  if (typeof exit === 'number' && String(exit).includes(q)) return true;
  for (const ev of events ?? []) {
    if (ev.eventType.toLowerCase().includes(q)) return true;
    if (friendlyEventLabel(ev.eventType).toLowerCase().includes(q)) return true;
    if (ev.payload && ev.payload.toLowerCase().includes(q)) return true;
  }
  return false;
}

export function filterHistory(
  entries: TaskHistoryEntry[],
  filter: FilterState,
  eventsByTask: Map<string, TaskEvent[]>,
): TaskHistoryEntry[] {
  const fromMs = filter.dateFrom ? new Date(filter.dateFrom).valueOf() : Number.NEGATIVE_INFINITY;
  const toMsRaw = filter.dateTo ? new Date(filter.dateTo).valueOf() : Number.POSITIVE_INFINITY;
  const toMs = Number.isFinite(toMsRaw) ? toMsRaw + 24 * 60 * 60 * 1000 - 1 : toMsRaw;

  return entries.filter((entry) => {
    if (filter.statuses.size > 0 && !filter.statuses.has(entry.status)) return false;
    if (filter.workflowNames.size > 0 && !filter.workflowNames.has(entry.workflowName)) return false;
    const lastEventIso = entry.lastEventAt ?? undefined;
    const lastEventMs = lastEventIso ? new Date(lastEventIso).valueOf() : NaN;
    if (Number.isFinite(lastEventMs)) {
      if (lastEventMs < fromMs || lastEventMs > toMs) return false;
    } else if (filter.dateFrom || filter.dateTo) {
      return false;
    }
    if (filter.search && !taskMatchesSearch(entry, filter.search, eventsByTask.get(entry.id))) {
      return false;
    }
    return true;
  });
}

function StatusBadge({ status }: { status: TaskStatus }) {
  const style = STATUS_STYLE[status] ?? 'bg-gray-700 text-gray-200';
  const label = STATUS_LABEL[status] ?? status;
  return <span className={`px-2 py-0.5 rounded text-xs font-medium ${style}`}>{label}</span>;
}

function TimelineEntry({
  event,
  prevChronologicalCreatedAt,
}: {
  event: TaskEvent;
  prevChronologicalCreatedAt: string | undefined;
}) {
  const category = categorizeEvent(event.eventType);
  const label = friendlyEventLabel(event.eventType);
  const detail = payloadDetail(event.payload);
  const errorInfo = category === 'terminal-failure' ? payloadErrorSummary(event.payload) : undefined;

  const durationSincePrev = useMemo(() => {
    if (!prevChronologicalCreatedAt) return '';
    const currentMs = new Date(event.createdAt).valueOf();
    const prevMs = new Date(prevChronologicalCreatedAt).valueOf();
    if (!Number.isFinite(currentMs) || !Number.isFinite(prevMs)) return '';
    return formatDuration(currentMs - prevMs);
  }, [event.createdAt, prevChronologicalCreatedAt]);

  return (
    <li className="flex gap-3 py-1.5">
      <div className="flex flex-col items-center pt-1.5">
        <span className={`inline-block w-2 h-2 rounded-full ${CATEGORY_DOT[category]}`} />
        <span className="w-px flex-1 bg-gray-700 mt-1" aria-hidden="true" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span
            className="text-sm font-medium text-gray-100"
            title={event.eventType}
          >
            {label}
          </span>
          {detail && (
            <span className="text-xs text-gray-400 truncate" title={detail}>
              {detail}
            </span>
          )}
          <span className="text-xs text-gray-500 ml-auto shrink-0">
            {formatAbsolute(event.createdAt)}
          </span>
        </div>
        {durationSincePrev && (
          <div className="text-xs text-gray-500">
            +{durationSincePrev} since previous
          </div>
        )}
        {errorInfo && (
          <div className="mt-0.5 text-xs text-red-300 break-words">
            {typeof errorInfo.exitCode === 'number' && <span className="font-mono mr-2">exit {errorInfo.exitCode}</span>}
            {errorInfo.error && <span className="whitespace-pre-wrap">{errorInfo.error}</span>}
          </div>
        )}
      </div>
    </li>
  );
}

const HISTORY_EVENTS_PAGE_SIZE = 50;

function Timeline({
  taskId,
  events,
  loading,
  hasMore,
  loadingMore,
  onLoadMore,
}: {
  taskId: string;
  events: TaskEvent[] | undefined;
  loading: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
}) {
  if (loading) {
    return <div className="text-xs text-gray-500 py-2">Loading timeline...</div>;
  }
  if (!events || events.length === 0) {
    return <div className="text-xs text-gray-500 py-2">No recorded events for this task.</div>;
  }
  const newestFirst = events;
  return (
    <div>
      <ol
        className="mt-1 pl-1"
        aria-label={`Timeline for task ${taskId}`}
        data-testid={`history-timeline-${taskId}`}
      >
        {newestFirst.map((event, idxFromTop) => {
          const chronologicallyPrev = newestFirst[idxFromTop + 1]?.createdAt;
          return (
            <TimelineEntry
              key={event.id}
              event={event}
              prevChronologicalCreatedAt={chronologicallyPrev}
            />
          );
        })}
      </ol>
      {hasMore && (
        <button
          type="button"
          className="mt-2 text-xs text-indigo-300 hover:text-indigo-100"
          onClick={onLoadMore}
          disabled={loadingMore}
          data-testid={`history-load-more-${taskId}`}
        >
          {loadingMore ? 'Loading…' : 'Load more'}
        </button>
      )}
    </div>
  );
}

function HistoryRow({
  entry,
  selected,
  expanded,
  events,
  eventsLoading,
  hasMore,
  loadingMore,
  onToggleExpand,
  onLoadMore,
  onSelect,
}: {
  entry: TaskHistoryEntry;
  selected: boolean;
  expanded: boolean;
  events: TaskEvent[] | undefined;
  eventsLoading: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  onToggleExpand: (taskId: string) => void;
  onLoadMore: (taskId: string) => void;
  onSelect: (task: TaskState) => void;
}) {
  const rowClass = selected
    ? 'bg-indigo-900/60 border-indigo-600'
    : 'bg-gray-800 border-gray-800 hover:border-gray-600';
  return (
    <li
      className={`border rounded-md ${rowClass} transition-colors`}
      data-testid={`history-row-${entry.id}`}
    >
      <div className="flex items-start gap-2 px-3 py-2">
        <button
          type="button"
          onClick={() => onToggleExpand(entry.id)}
          className="mt-0.5 text-gray-400 hover:text-gray-100 w-4 shrink-0"
          aria-expanded={expanded}
          aria-label={expanded ? 'Collapse timeline' : 'Expand timeline'}
          data-testid={`history-expand-${entry.id}`}
        >
          {expanded ? '▾' : '▸'}
        </button>
        <button
          type="button"
          onClick={() => onSelect(entry)}
          className="flex-1 min-w-0 text-left"
        >
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-sm text-gray-100 truncate max-w-full" title={entry.description}>
              {entry.description}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-x-2 mt-1 text-xs text-gray-400">
            <StatusBadge status={entry.status} />
            <span className="truncate" title={entry.workflowName}>
              {entry.workflowName}
            </span>
            <span className="ml-auto shrink-0" title={entry.lastEventAt ?? undefined}>
              {formatAbsolute(entry.lastEventAt)}
            </span>
          </div>
        </button>
      </div>
      {expanded && (
        <div className="px-3 pb-2 pl-8 border-t border-gray-700/60">
          <Timeline
            taskId={entry.id}
            events={events}
            loading={eventsLoading}
            hasMore={hasMore}
            loadingMore={loadingMore}
            onLoadMore={() => onLoadMore(entry.id)}
          />
        </div>
      )}
    </li>
  );
}

function FilterBar({
  filter,
  onChange,
  workflowNames,
  visibleCount,
  totalCount,
}: {
  filter: FilterState;
  onChange: (next: FilterState) => void;
  workflowNames: string[];
  visibleCount: number;
  totalCount: number;
}) {
  const toggleStatus = useCallback(
    (status: TaskStatus) => {
      const next = new Set(filter.statuses);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      onChange({ ...filter, statuses: next });
    },
    [filter, onChange],
  );

  const toggleWorkflow = useCallback(
    (name: string) => {
      const next = new Set(filter.workflowNames);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      onChange({ ...filter, workflowNames: next });
    },
    [filter, onChange],
  );

  const anyActive =
    filter.search !== '' ||
    filter.statuses.size > 0 ||
    filter.workflowNames.size > 0 ||
    filter.dateFrom !== '' ||
    filter.dateTo !== '';

  return (
    <div className="border-b border-gray-800 p-3 space-y-3 bg-gray-900/40">
      <div className="flex items-center gap-2">
        <input
          type="search"
          value={filter.search}
          onChange={(e) => onChange({ ...filter, search: e.target.value })}
          placeholder="Search description, workflow, event, error…"
          className="flex-1 bg-gray-900 border border-gray-700 rounded px-2 py-1 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-indigo-500"
          aria-label="Search history"
        />
        <span className="text-xs text-gray-500 shrink-0">
          {visibleCount} / {totalCount}
        </span>
        {anyActive && (
          <button
            type="button"
            onClick={() => onChange(EMPTY_FILTER)}
            className="text-xs text-gray-400 hover:text-gray-100 shrink-0"
          >
            Clear
          </button>
        )}
      </div>
      <div className="flex flex-wrap gap-1.5" aria-label="Filter by status">
        {STATUS_OPTIONS.map((status) => {
          const active = filter.statuses.has(status);
          return (
            <button
              key={status}
              type="button"
              onClick={() => toggleStatus(status)}
              className={`text-xs px-2 py-0.5 rounded border transition-colors ${
                active
                  ? `${STATUS_STYLE[status]} border-transparent`
                  : 'bg-transparent text-gray-400 border-gray-700 hover:border-gray-500'
              }`}
              aria-pressed={active}
            >
              {STATUS_LABEL[status]}
            </button>
          );
        })}
      </div>
      {workflowNames.length > 0 && (
        <div className="flex flex-wrap gap-1.5" aria-label="Filter by workflow">
          {workflowNames.map((name) => {
            const active = filter.workflowNames.has(name);
            return (
              <button
                key={name}
                type="button"
                onClick={() => toggleWorkflow(name)}
                className={`text-xs px-2 py-0.5 rounded border transition-colors max-w-[240px] truncate ${
                  active
                    ? 'bg-indigo-700 text-indigo-100 border-transparent'
                    : 'bg-transparent text-gray-400 border-gray-700 hover:border-gray-500'
                }`}
                aria-pressed={active}
                title={name}
              >
                {name}
              </button>
            );
          })}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2 text-xs text-gray-400">
        <label className="flex items-center gap-1">
          <span>From</span>
          <input
            type="date"
            value={filter.dateFrom}
            onChange={(e) => onChange({ ...filter, dateFrom: e.target.value })}
            className="bg-gray-900 border border-gray-700 rounded px-1.5 py-0.5 text-xs text-gray-100"
            aria-label="From date"
          />
        </label>
        <label className="flex items-center gap-1">
          <span>To</span>
          <input
            type="date"
            value={filter.dateTo}
            onChange={(e) => onChange({ ...filter, dateTo: e.target.value })}
            className="bg-gray-900 border border-gray-700 rounded px-1.5 py-0.5 text-xs text-gray-100"
            aria-label="To date"
          />
        </label>
      </div>
    </div>
  );
}

export function applyDelta(prev: TaskHistoryEntry[], delta: TaskDelta): TaskHistoryEntry[] {
  const nowIso = new Date().toISOString();
  if (delta.type === 'removed') {
    return prev.filter((entry) => entry.id !== delta.taskId);
  }
  if (delta.type === 'created') {
    const existingIdx = prev.findIndex((e) => e.id === delta.task.id);
    const existing = existingIdx >= 0 ? prev[existingIdx] : undefined;
    const entry: TaskHistoryEntry = {
      ...delta.task,
      workflowName: existing?.workflowName ?? '',
      lastEventAt: nowIso,
      eventCount: (existing?.eventCount ?? 0) + 1,
    };
    if (existingIdx >= 0) {
      const next = prev.slice();
      next[existingIdx] = entry;
      return sortByLastEvent(next);
    }
    return sortByLastEvent([entry, ...prev]);
  }
  const idx = prev.findIndex((e) => e.id === delta.taskId);
  if (idx < 0) return prev;
  const existing = prev[idx];
  const changes = delta.changes;
  const nextStatus = changes.status ?? existing.status;
  const nextExecution = { ...existing.execution, ...(changes.execution ?? {}) };
  const nextConfig = { ...existing.config, ...(changes.config ?? {}) };
  const updated: TaskHistoryEntry = {
    ...existing,
    status: nextStatus,
    description: changes.description ?? existing.description,
    dependencies: changes.dependencies ?? existing.dependencies,
    execution: nextExecution,
    config: nextConfig,
    taskStateVersion: delta.taskStateVersion,
    lastEventAt: nowIso,
    eventCount: existing.eventCount + 1,
  };
  const next = prev.slice();
  next[idx] = updated;
  return sortByLastEvent(next);
}

function getInvoker(): InvokerAPI | undefined {
  return typeof window !== 'undefined' ? window.invoker : undefined;
}

function sortByLastEvent(entries: TaskHistoryEntry[]): TaskHistoryEntry[] {
  return entries.slice().sort((a, b) => {
    const at = a.lastEventAt ? new Date(a.lastEventAt).valueOf() : 0;
    const bt = b.lastEventAt ? new Date(b.lastEventAt).valueOf() : 0;
    return bt - at;
  });
}

export function HistoryView({ onTaskClick, selectedTaskId }: HistoryViewProps) {
  const [entries, setEntries] = useState<TaskHistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<FilterState>(EMPTY_FILTER);
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  const [eventsByTask, setEventsByTask] = useState<Map<string, TaskEvent[]>>(new Map());
  const [eventsHasMoreByTask, setEventsHasMoreByTask] = useState<Map<string, boolean>>(new Map());
  const [eventsLoadingTaskId, setEventsLoadingTaskId] = useState<string | null>(null);
  const [eventsLoadingMoreTaskId, setEventsLoadingMoreTaskId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const invoker = getInvoker();
    if (!invoker?.getHistoryTasks) {
      setLoading(false);
      setEntries([]);
      return;
    }
    invoker.getHistoryTasks().then((rows) => {
      if (cancelled) return;
      setEntries(sortByLastEvent(rows));
      setLoading(false);
    }).catch(() => {
      if (cancelled) return;
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const refetchEvents = useCallback(async (taskId: string) => {
    const invoker = getInvoker();
    if (!invoker?.getEvents) return;
    setEventsLoadingTaskId(taskId);
    try {
      const evs = await invoker.getEvents(taskId, {
        limit: HISTORY_EVENTS_PAGE_SIZE,
        sortBy: 'desc',
      });
      setEventsByTask((prev) => {
        const next = new Map(prev);
        next.set(taskId, evs);
        return next;
      });
      setEventsHasMoreByTask((prev) => {
        const next = new Map(prev);
        next.set(taskId, evs.length >= HISTORY_EVENTS_PAGE_SIZE);
        return next;
      });
    } finally {
      setEventsLoadingTaskId((current) => (current === taskId ? null : current));
    }
  }, []);

  const loadMoreEvents = useCallback(async (taskId: string) => {
    const invoker = getInvoker();
    if (!invoker?.getEvents) return;
    const existing = eventsByTask.get(taskId) ?? [];
    const oldest = existing[existing.length - 1];
    if (!oldest) return;
    setEventsLoadingMoreTaskId(taskId);
    try {
      const page = await invoker.getEvents(taskId, {
        limit: HISTORY_EVENTS_PAGE_SIZE,
        sortBy: 'desc',
        beforeId: oldest.id,
      });
      setEventsByTask((prev) => {
        const next = new Map(prev);
        const current = next.get(taskId) ?? [];
        const seen = new Set(current.map((event) => event.id));
        next.set(taskId, [...current, ...page.filter((event) => !seen.has(event.id))]);
        return next;
      });
      setEventsHasMoreByTask((prev) => {
        const next = new Map(prev);
        next.set(taskId, page.length >= HISTORY_EVENTS_PAGE_SIZE);
        return next;
      });
    } finally {
      setEventsLoadingMoreTaskId((current) => (current === taskId ? null : current));
    }
  }, [eventsByTask]);

  useEffect(() => {
    const invoker = getInvoker();
    if (!invoker?.onTaskGraphEvent) return;
    return invoker.onTaskGraphEvent((event) => {
      if (event.type !== 'delta') return;
      const delta = event.delta;
      setEntries((prev) => applyDelta(prev, delta));
      const affectedId = 'taskId' in delta ? delta.taskId : delta.task.id;
      if (affectedId && expandedTaskId === affectedId) {
        void refetchEvents(affectedId);
      }
    });
  }, [expandedTaskId, refetchEvents]);

  const toggleExpand = useCallback(
    (taskId: string) => {
      setExpandedTaskId((current) => {
        if (current === taskId) return null;
        void refetchEvents(taskId);
        return taskId;
      });
    },
    [refetchEvents],
  );

  const workflowNames = useMemo(() => {
    const seen = new Set<string>();
    const ordered: string[] = [];
    for (const entry of entries) {
      if (!entry.workflowName || seen.has(entry.workflowName)) continue;
      seen.add(entry.workflowName);
      ordered.push(entry.workflowName);
    }
    return ordered;
  }, [entries]);

  const filtered = useMemo(
    () => filterHistory(entries, filter, eventsByTask),
    [entries, filter, eventsByTask],
  );

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
        Loading history...
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col" data-testid="history-view">
      <FilterBar
        filter={filter}
        onChange={setFilter}
        workflowNames={workflowNames}
        visibleCount={filtered.length}
        totalCount={entries.length}
      />
      {entries.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
          No task history yet
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
          No tasks match the current filters
        </div>
      ) : (
        <ul className="flex-1 overflow-y-auto p-3 space-y-1.5" aria-label="Task history" data-testid="history-task-list">
          {filtered.map((entry) => (
            <HistoryRow
              key={entry.id}
              entry={entry}
              selected={selectedTaskId === entry.id}
              expanded={expandedTaskId === entry.id}
              events={eventsByTask.get(entry.id)}
              eventsLoading={eventsLoadingTaskId === entry.id}
              hasMore={eventsHasMoreByTask.get(entry.id) === true}
              loadingMore={eventsLoadingMoreTaskId === entry.id}
              onToggleExpand={toggleExpand}
              onLoadMore={loadMoreEvents}
              onSelect={onTaskClick}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
