import { describe, it, expect } from 'vitest';
import {
  formatElapsed,
  sortTasksForTimeline,
  computeBarWidths,
} from '../components/TimelineView.js';
import {
  buildWorkerTimelineEventRows,
  sortWorkerTimelineActions,
  sortWorkerTimelineEventRows,
} from '../lib/worker-timeline.js';
import type { TaskState, WorkerActionSummary } from '../types.js';

function makeTask(overrides: Partial<TaskState> & { id: string } & { startedAt?: Date; completedAt?: Date }): TaskState {
  const { startedAt, completedAt, ...rest } = overrides;
  return {
    description: `Task ${overrides.id}`,
    status: 'pending',
    dependencies: [],
    createdAt: new Date('2024-01-01T00:00:00Z'),
    config: {},
    execution: { startedAt, completedAt },
    ...rest,
  } as TaskState;
}

function makeWorkerAction(overrides: Partial<WorkerActionSummary> & { id: string; workerKind: string; createdAt: string }): WorkerActionSummary {
  return {
    id: overrides.id,
    workerKind: overrides.workerKind,
    actionType: 'repair',
    workflowId: 'wf-1',
    taskId: 'wf-1/task-a',
    subjectType: 'task',
    subjectId: 'wf-1/task-a',
    externalKey: `external:${overrides.id}`,
    status: 'completed',
    attemptCount: 1,
    createdAt: overrides.createdAt,
    updatedAt: overrides.createdAt,
    ...overrides,
  };
}

describe('formatElapsed', () => {
  it('formats sub-minute durations', () => {
    expect(formatElapsed(0)).toBe('0s');
    expect(formatElapsed(999)).toBe('0s');
    expect(formatElapsed(1000)).toBe('1s');
    expect(formatElapsed(59_999)).toBe('59s');
  });

  it('formats minutes and seconds', () => {
    expect(formatElapsed(60_000)).toBe('1m 0s');
    expect(formatElapsed(90_000)).toBe('1m 30s');
    expect(formatElapsed(3_599_999)).toBe('59m 59s');
  });

  it('formats hours and minutes', () => {
    expect(formatElapsed(3_600_000)).toBe('1h 0m');
    expect(formatElapsed(5_400_000)).toBe('1h 30m');
    expect(formatElapsed(7_200_000)).toBe('2h 0m');
  });

  it('returns 0s for negative values', () => {
    expect(formatElapsed(-1000)).toBe('0s');
  });
});

describe('sortTasksForTimeline', () => {
  it('places running tasks before completed', () => {
    const tasks = [
      makeTask({ id: 'a', status: 'completed', startedAt: new Date('2024-01-01T00:00:00Z') }),
      makeTask({ id: 'b', status: 'running', startedAt: new Date('2024-01-01T00:01:00Z') }),
    ];
    const sorted = sortTasksForTimeline(tasks);
    expect(sorted[0].id).toBe('b');
    expect(sorted[1].id).toBe('a');
  });

  it('places pending tasks last', () => {
    const tasks = [
      makeTask({ id: 'pending1', status: 'pending' }),
      makeTask({ id: 'running1', status: 'running', startedAt: new Date('2024-01-01T00:00:00Z') }),
      makeTask({ id: 'done1', status: 'completed', startedAt: new Date('2024-01-01T00:00:00Z') }),
    ];
    const sorted = sortTasksForTimeline(tasks);
    expect(sorted[0].id).toBe('running1');
    expect(sorted[2].id).toBe('pending1');
  });

  it('sorts same-status tasks by startedAt', () => {
    const tasks = [
      makeTask({ id: 'late', status: 'running', startedAt: new Date('2024-01-01T00:05:00Z') }),
      makeTask({ id: 'early', status: 'running', startedAt: new Date('2024-01-01T00:01:00Z') }),
    ];
    const sorted = sortTasksForTimeline(tasks);
    expect(sorted[0].id).toBe('early');
    expect(sorted[1].id).toBe('late');
  });

  it('handles empty array', () => {
    expect(sortTasksForTimeline([])).toEqual([]);
  });

  it('handles single task', () => {
    const tasks = [makeTask({ id: 'solo', status: 'running' })];
    const sorted = sortTasksForTimeline(tasks);
    expect(sorted).toHaveLength(1);
    expect(sorted[0].id).toBe('solo');
  });
});

describe('computeBarWidths', () => {
  const T0 = new Date('2024-01-01T00:00:00Z').getTime();
  const T1 = new Date('2024-01-01T00:01:00Z').getTime();
  const T2 = new Date('2024-01-01T00:02:00Z').getTime();

  it('returns zero-width bars for tasks with no startedAt', () => {
    const tasks = [makeTask({ id: 'a', status: 'pending' })];
    const bars = computeBarWidths(tasks, T2);
    expect(bars[0].widthPercent).toBe(0);
    expect(bars[0].offsetPercent).toBe(0);
  });

  it('returns zero-width bars when all tasks are pending', () => {
    const tasks = [
      makeTask({ id: 'a', status: 'pending' }),
      makeTask({ id: 'b', status: 'blocked' }),
    ];
    const bars = computeBarWidths(tasks, T2);
    expect(bars.every((bar) => bar.widthPercent === 0)).toBe(true);
  });

  it('computes correct offset and width for a single completed task', () => {
    const tasks = [
      makeTask({
        id: 'a',
        status: 'completed',
        startedAt: new Date(T0),
        completedAt: new Date(T2),
      }),
    ];
    const bars = computeBarWidths(tasks, T2);
    expect(bars[0].offsetPercent).toBe(0);
    expect(bars[0].widthPercent).toBe(100);
    expect(bars[0].durationMs).toBe(T2 - T0);
  });

  it('computes relative offsets for multiple tasks', () => {
    const tasks = [
      makeTask({
        id: 'first',
        status: 'completed',
        startedAt: new Date(T0),
        completedAt: new Date(T1),
      }),
      makeTask({
        id: 'second',
        status: 'completed',
        startedAt: new Date(T1),
        completedAt: new Date(T2),
      }),
    ];
    const bars = computeBarWidths(tasks, T2);
    const first = bars.find((bar) => bar.taskId === 'first')!;
    const second = bars.find((bar) => bar.taskId === 'second')!;

    expect(first.offsetPercent).toBe(0);
    expect(first.widthPercent).toBe(50);
    expect(second.offsetPercent).toBe(50);
    expect(second.widthPercent).toBe(50);
  });

  it('uses now for running tasks end time', () => {
    const tasks = [
      makeTask({
        id: 'running',
        status: 'running',
        startedAt: new Date(T0),
      }),
    ];
    const now = T0 + 30_000;
    const bars = computeBarWidths(tasks, now);
    expect(bars[0].durationMs).toBe(30_000);
    expect(bars[0].widthPercent).toBe(100);
  });

  it('preserves task id mapping', () => {
    const tasks = [
      makeTask({ id: 'x', status: 'completed', startedAt: new Date(T0), completedAt: new Date(T1) }),
      makeTask({ id: 'y', status: 'pending' }),
    ];
    const bars = computeBarWidths(tasks, T2);
    expect(bars[0].taskId).toBe('x');
    expect(bars[1].taskId).toBe('y');
  });
});

describe('worker timeline helpers', () => {
  it('expands completed actions into launched and finished rows', () => {
    const rows = buildWorkerTimelineEventRows(
      makeWorkerAction({
        id: 'repair',
        workerKind: 'autofix',
        createdAt: '2024-01-01T00:00:10Z',
        completedAt: '2024-01-01T00:00:20Z',
      }),
      Date.parse('2024-01-01T00:01:00Z'),
    );

    expect(rows).toEqual([
      expect.objectContaining({ eventKind: 'launched', timestampMs: Date.parse('2024-01-01T00:00:10Z') }),
      expect.objectContaining({ eventKind: 'finished', timestampMs: Date.parse('2024-01-01T00:00:20Z') }),
    ]);
  });

  it('drops the finished row when completedAt is invalid but keeps the launched row', () => {
    const rows = buildWorkerTimelineEventRows(
      makeWorkerAction({
        id: 'repair',
        workerKind: 'autofix',
        createdAt: '2024-01-01T00:00:10Z',
        completedAt: 'not-a-timestamp',
        updatedAt: '2024-01-01T00:00:40Z',
      }),
      Date.parse('2024-01-01T00:01:00Z'),
    );

    expect(rows).toEqual([
      expect.objectContaining({ eventKind: 'launched', timestampMs: Date.parse('2024-01-01T00:00:10Z') }),
    ]);
  });

  it('sorts event rows by timestamp, then action id, with launched before finished for one action', () => {
    const earlierRows = buildWorkerTimelineEventRows(
      makeWorkerAction({
        id: 'earlier',
        workerKind: 'autofix',
        createdAt: '2024-01-01T00:00:10Z',
      }),
      Date.parse('2024-01-01T00:01:00Z'),
    ) ?? [];
    const sameActionRows = buildWorkerTimelineEventRows(
      makeWorkerAction({
        id: 'same',
        workerKind: 'autofix',
        createdAt: '2024-01-01T00:00:20Z',
        completedAt: '2024-01-01T00:00:20Z',
      }),
      Date.parse('2024-01-01T00:01:00Z'),
    ) ?? [];
    const laterRows = buildWorkerTimelineEventRows(
      makeWorkerAction({
        id: 'later',
        workerKind: 'autofix',
        createdAt: '2024-01-01T00:00:20Z',
      }),
      Date.parse('2024-01-01T00:01:00Z'),
    ) ?? [];

    const sorted = sortWorkerTimelineEventRows([
      laterRows[0]!,
      sameActionRows[1]!,
      sameActionRows[0]!,
      earlierRows[0]!,
    ]);

    expect(sorted.map((row) => `${row.action.id}-${row.eventKind}`)).toEqual([
      'earlier-launched',
      'later-launched',
      'same-launched',
      'same-finished',
    ]);
  });

  it('re-sorts combined pages into ascending createdAt order', () => {
    const combined = sortWorkerTimelineActions([
      makeWorkerAction({
        id: 'newer-page',
        workerKind: 'autofix',
        createdAt: '2024-01-01T00:00:20Z',
      }),
      makeWorkerAction({
        id: 'older-page',
        workerKind: 'autofix',
        createdAt: '2024-01-01T00:00:10Z',
      }),
      makeWorkerAction({
        id: 'same-time-b',
        workerKind: 'autofix',
        createdAt: '2024-01-01T00:00:20Z',
      }),
      makeWorkerAction({
        id: 'same-time-a',
        workerKind: 'autofix',
        createdAt: '2024-01-01T00:00:20Z',
      }),
    ]);

    expect(combined.map((action) => action.id)).toEqual([
      'older-page',
      'newer-page',
      'same-time-a',
      'same-time-b',
    ]);
  });
});
