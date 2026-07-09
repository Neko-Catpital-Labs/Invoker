import { describe, it, expect } from 'vitest';
import type { TaskHistoryEntry, TaskEvent, TaskState, TaskStatus } from '../types.js';
import {
  EMPTY_FILTER,
  applyDelta,
  filterHistory,
  taskMatchesSearch,
  type FilterState,
} from '../components/HistoryView.js';
import {
  categorizeEvent,
  friendlyEventLabel,
  payloadDetail,
  payloadErrorSummary,
} from '../lib/event-labels.js';

function makeEntry(overrides: Partial<TaskHistoryEntry> = {}): TaskHistoryEntry {
  return {
    id: 't1',
    description: 'Do the thing',
    status: 'completed' as TaskStatus,
    dependencies: [],
    createdAt: new Date('2026-07-01T10:00:00Z'),
    config: {},
    execution: {},
    taskStateVersion: 1,
    workflowName: 'Plan A',
    lastEventAt: '2026-07-01T10:05:00Z',
    eventCount: 3,
    ...overrides,
  };
}

function makeEvent(overrides: Partial<TaskEvent> = {}): TaskEvent {
  return {
    id: 1,
    taskId: 't1',
    eventType: 'task.running',
    createdAt: '2026-07-01T10:00:00Z',
    ...overrides,
  };
}

function filterWith(overrides: Partial<FilterState>): FilterState {
  return { ...EMPTY_FILTER, ...overrides };
}

describe('friendlyEventLabel', () => {
  it('maps the concrete event vocabulary to human-readable labels', () => {
    expect(friendlyEventLabel('task.running')).toBe('Running');
    expect(friendlyEventLabel('task.fixing_with_ai')).toBe('Submitted for autofix');
    expect(friendlyEventLabel('task.completed')).toBe('Completed');
    expect(friendlyEventLabel('task.failed')).toBe('Failed');
    expect(friendlyEventLabel('task.pending')).toBe('Pending');
    expect(friendlyEventLabel('task.executor.selected')).toBe('Executor selected');
  });

  it('falls back to the last segment title-cased for unknown events', () => {
    expect(friendlyEventLabel('some.unknown.event_name')).toBe('Name');
    expect(friendlyEventLabel('bareword')).toBe('Bareword');
  });
});

describe('categorizeEvent', () => {
  it('routes lifecycle events into visual categories', () => {
    expect(categorizeEvent('task.completed')).toBe('terminal-success');
    expect(categorizeEvent('task.failed')).toBe('terminal-failure');
    expect(categorizeEvent('task.cancelled')).toBe('terminal-failure');
    expect(categorizeEvent('task.stale')).toBe('terminal-failure');
    expect(categorizeEvent('task.running')).toBe('running');
    expect(categorizeEvent('task.fixing_with_ai')).toBe('autofix');
    expect(categorizeEvent('debug.auto-fix')).toBe('autofix');
    expect(categorizeEvent('task.awaiting_approval')).toBe('attention');
    expect(categorizeEvent('task.needs_input')).toBe('attention');
    expect(categorizeEvent('task.blocked')).toBe('attention');
    expect(categorizeEvent('task.deferred')).toBe('attention');
    expect(categorizeEvent('task.metadata.updated')).toBe('info');
  });
});

describe('payloadDetail / payloadErrorSummary', () => {
  it('extracts a phase from auto-fix debug payloads', () => {
    expect(payloadDetail(JSON.stringify({ phase: 'resolve-conflict-start' }))).toBe('resolve-conflict-start');
  });

  it('extracts a reason when phase is absent', () => {
    expect(payloadDetail(JSON.stringify({ reason: 'lease-expired' }))).toBe('lease-expired');
  });

  it('returns undefined for missing / unparseable payloads', () => {
    expect(payloadDetail(undefined)).toBeUndefined();
    expect(payloadDetail('not json')).toBeUndefined();
    expect(payloadDetail('{}')).toBeUndefined();
  });

  it('extracts exit code / error text from a failure payload', () => {
    const payload = JSON.stringify({ execution: { exitCode: 2, error: 'boom' } });
    expect(payloadErrorSummary(payload)).toEqual({ exitCode: 2, error: 'boom' });
  });

  it('reads exit code / error at the top level as well', () => {
    expect(payloadErrorSummary(JSON.stringify({ exitCode: 1 }))).toEqual({ exitCode: 1, error: undefined });
    expect(payloadErrorSummary(JSON.stringify({ error: 'nope' }))).toEqual({ exitCode: undefined, error: 'nope' });
  });

  it('returns undefined when the payload has no error fields', () => {
    expect(payloadErrorSummary(undefined)).toBeUndefined();
    expect(payloadErrorSummary(JSON.stringify({ phase: 'ok' }))).toBeUndefined();
  });
});

describe('taskMatchesSearch', () => {
  it('matches on description and workflow name case-insensitively', () => {
    const entry = makeEntry({ description: 'Refactor Foo', workflowName: 'Nightly' });
    expect(taskMatchesSearch(entry, 'foo', undefined)).toBe(true);
    expect(taskMatchesSearch(entry, 'NIGHTLY', undefined)).toBe(true);
    expect(taskMatchesSearch(entry, 'unrelated', undefined)).toBe(false);
  });

  it('matches on friendly event labels and raw event types', () => {
    const entry = makeEntry({ description: '-', workflowName: '-' });
    const events = [makeEvent({ eventType: 'task.fixing_with_ai' })];
    expect(taskMatchesSearch(entry, 'autofix', events)).toBe(true);
    expect(taskMatchesSearch(entry, 'fixing_with_ai', events)).toBe(true);
  });

  it('matches on raw event payload text', () => {
    const entry = makeEntry({ description: '-', workflowName: '-' });
    const events = [makeEvent({ payload: JSON.stringify({ error: 'unique-payload-token' }) })];
    expect(taskMatchesSearch(entry, 'unique-payload-token', events)).toBe(true);
    expect(taskMatchesSearch(entry, 'missing-token', events)).toBe(false);
  });

  it('matches on execution error and exit code', () => {
    const entry = makeEntry({
      description: '-',
      workflowName: '-',
      execution: { error: 'Segmentation fault', exitCode: 139 },
    });
    expect(taskMatchesSearch(entry, 'segmentation', undefined)).toBe(true);
    expect(taskMatchesSearch(entry, '139', undefined)).toBe(true);
  });

  it('treats empty / whitespace queries as always-matching', () => {
    expect(taskMatchesSearch(makeEntry(), '   ', undefined)).toBe(true);
  });
});

describe('filterHistory', () => {
  const events = new Map<string, TaskEvent[]>();

  it('filters by status (multi-select OR)', () => {
    const entries = [
      makeEntry({ id: 't1', status: 'completed' }),
      makeEntry({ id: 't2', status: 'failed' }),
      makeEntry({ id: 't3', status: 'running' }),
    ];
    const filter = filterWith({ statuses: new Set<TaskStatus>(['completed', 'failed']) });
    const out = filterHistory(entries, filter, events);
    expect(out.map((e) => e.id)).toEqual(['t1', 't2']);
  });

  it('filters by workflow name (multi-select OR)', () => {
    const entries = [
      makeEntry({ id: 't1', workflowName: 'Plan A' }),
      makeEntry({ id: 't2', workflowName: 'Plan B' }),
      makeEntry({ id: 't3', workflowName: 'Plan C' }),
    ];
    const filter = filterWith({ workflowNames: new Set(['Plan A', 'Plan C']) });
    const out = filterHistory(entries, filter, events);
    expect(out.map((e) => e.id)).toEqual(['t1', 't3']);
  });

  it('filters by date range using lastEventAt inclusive of end-of-day', () => {
    const entries = [
      makeEntry({ id: 't1', lastEventAt: '2026-07-01T05:00:00Z' }),
      makeEntry({ id: 't2', lastEventAt: '2026-07-03T23:59:00Z' }),
      makeEntry({ id: 't3', lastEventAt: '2026-07-05T00:01:00Z' }),
    ];
    // Pin local date parsing so end-of-day inclusion is stable across timezones.
    const from = new Date(2026, 6, 2);
    const to = new Date(2026, 6, 4);
    const pad = (n: number) => String(n).padStart(2, '0');
    const toDateInput = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const filter = filterWith({ dateFrom: toDateInput(from), dateTo: toDateInput(to) });
    const out = filterHistory(entries, filter, events);
    expect(out.map((e) => e.id)).toEqual(['t2']);
  });

  it('filters with only dateFrom or only dateTo', () => {
    const entries = [
      makeEntry({ id: 't1', lastEventAt: '2026-07-01T05:00:00Z' }),
      makeEntry({ id: 't2', lastEventAt: '2026-07-03T12:00:00Z' }),
      makeEntry({ id: 't3', lastEventAt: '2026-07-05T00:01:00Z' }),
    ];
    const pad = (n: number) => String(n).padStart(2, '0');
    const toDateInput = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
    expect(filterHistory(entries, filterWith({ dateFrom: toDateInput(2026, 7, 3) }), events).map((e) => e.id)).toEqual(['t2', 't3']);
    expect(filterHistory(entries, filterWith({ dateTo: toDateInput(2026, 7, 3) }), events).map((e) => e.id)).toEqual(['t1', 't2']);
  });

  it('searches through cached events via eventsByTask', () => {
    const entries = [
      makeEntry({ id: 't1', description: 'Alpha', status: 'completed' }),
      makeEntry({ id: 't2', description: 'Beta', status: 'completed' }),
    ];
    const eventsByTask = new Map<string, TaskEvent[]>([
      ['t2', [makeEvent({ taskId: 't2', eventType: 'task.failed', payload: JSON.stringify({ error: 'needle-in-payload' }) })]],
    ]);
    const out = filterHistory(entries, filterWith({ search: 'needle-in-payload' }), eventsByTask);
    expect(out.map((e) => e.id)).toEqual(['t2']);
  });

  it('combines search with filters (AND across kinds)', () => {
    const entries = [
      makeEntry({ id: 't1', description: 'Alpha', status: 'completed' }),
      makeEntry({ id: 't2', description: 'Beta', status: 'completed' }),
      makeEntry({ id: 't3', description: 'Alpha', status: 'failed' }),
    ];
    const filter = filterWith({
      statuses: new Set<TaskStatus>(['completed']),
      search: 'alpha',
    });
    const out = filterHistory(entries, filter, events);
    expect(out.map((e) => e.id)).toEqual(['t1']);
  });

  it('excludes tasks with no lastEventAt when a date range is set', () => {
    const entries = [makeEntry({ id: 't1', lastEventAt: null })];
    const filter = filterWith({ dateFrom: '2026-07-01' });
    expect(filterHistory(entries, filter, events)).toHaveLength(0);
  });

  it('can filter closed tasks by status', () => {
    const entries = [
      makeEntry({ id: 't1', status: 'completed' }),
      makeEntry({ id: 't2', status: 'closed' }),
    ];
    const out = filterHistory(entries, filterWith({ statuses: new Set<TaskStatus>(['closed']) }), events);
    expect(out.map((e) => e.id)).toEqual(['t2']);
  });
});

describe('applyDelta', () => {
  const nowIso = new Date().toISOString();

  function makeTask(id: string, status: TaskStatus = 'pending', description = 'x'): TaskState {
    return {
      id,
      description,
      status,
      dependencies: [],
      createdAt: new Date(nowIso),
      config: {},
      execution: {},
      taskStateVersion: 1,
    };
  }

  it('appends a created task with a fresh lastEventAt', () => {
    const list: TaskHistoryEntry[] = [];
    const out = applyDelta(list, { type: 'created', task: makeTask('t1') });
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('t1');
    expect(out[0].lastEventAt).toBeTruthy();
    expect(out[0].eventCount).toBe(1);
  });

  it('upserts a created delta for an existing id, preserving workflowName', () => {
    const start: TaskHistoryEntry[] = [
      makeEntry({ id: 't1', workflowName: 'Plan A', eventCount: 3, lastEventAt: '2026-07-01T10:00:00Z' }),
      makeEntry({ id: 't2', workflowName: 'Plan B', lastEventAt: '2026-07-01T11:00:00Z' }),
    ];
    const out = applyDelta(start, {
      type: 'created',
      task: makeTask('t1', 'running', 'Updated description'),
    });
    expect(out[0].id).toBe('t1');
    expect(out[0].workflowName).toBe('Plan A');
    expect(out[0].description).toBe('Updated description');
    expect(out[0].eventCount).toBe(4);
  });

  it('applies updated deltas by merging changes into the matched entry', () => {
    const start: TaskHistoryEntry[] = [
      makeEntry({
        id: 't1',
        status: 'pending',
        taskStateVersion: 1,
        eventCount: 2,
        description: 'old',
        dependencies: ['dep-a'],
        config: { command: 'echo old' },
      }),
    ];
    const out = applyDelta(start, {
      type: 'updated',
      taskId: 't1',
      changes: {
        status: 'running',
        description: 'new',
        dependencies: ['dep-b'],
        config: { command: 'echo new' },
        execution: { branch: 'feat/x' },
      },
      taskStateVersion: 2,
      previousTaskStateVersion: 1,
    });
    expect(out[0].status).toBe('running');
    expect(out[0].taskStateVersion).toBe(2);
    expect(out[0].description).toBe('new');
    expect(out[0].dependencies).toEqual(['dep-b']);
    expect(out[0].config.command).toBe('echo new');
    expect(out[0].execution.branch).toBe('feat/x');
    expect(out[0].eventCount).toBe(3);
  });

  it('ignores updated deltas for unknown tasks', () => {
    const start: TaskHistoryEntry[] = [makeEntry({ id: 't1' })];
    const out = applyDelta(start, {
      type: 'updated',
      taskId: 'nope',
      changes: { status: 'running' },
      taskStateVersion: 2,
      previousTaskStateVersion: 1,
    });
    expect(out).toEqual(start);
  });

  it('removes tasks on removed deltas and no-ops unknown removals', () => {
    const start: TaskHistoryEntry[] = [makeEntry({ id: 't1' }), makeEntry({ id: 't2' })];
    expect(applyDelta(start, {
      type: 'removed',
      taskId: 't1',
      previousTaskStateVersion: 1,
    }).map((e) => e.id)).toEqual(['t2']);
    expect(applyDelta(start, {
      type: 'removed',
      taskId: 'missing',
      previousTaskStateVersion: 1,
    })).toEqual(start);
  });

  it('re-sorts the list so the most recently updated task is on top', () => {
    const start: TaskHistoryEntry[] = [
      makeEntry({ id: 't-newer', lastEventAt: '2026-07-01T12:00:00Z' }),
      makeEntry({ id: 't-older', lastEventAt: '2026-07-01T10:00:00Z' }),
    ];
    const out = applyDelta(start, {
      type: 'updated',
      taskId: 't-older',
      changes: { status: 'completed' },
      taskStateVersion: 2,
      previousTaskStateVersion: 1,
    });
    expect(out[0].id).toBe('t-older');
  });
});
