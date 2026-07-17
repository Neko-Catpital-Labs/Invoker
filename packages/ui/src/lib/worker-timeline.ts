import type { WorkerActionSummary } from '../types.js';
import { ACTIVE_WORKER_ACTION_STATUSES } from './worker-display.js';

export type WorkerTimelineEventKind = 'launched' | 'finished';

export interface WorkerTimelineActionBounds {
  readonly startMs: number;
  readonly endMs: number;
  readonly isActive: boolean;
}

export interface WorkerTimelineEventRow {
  readonly action: WorkerActionSummary;
  readonly eventKind: WorkerTimelineEventKind;
  readonly timestampMs: number;
}

function parseMs(value: string | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

export function compareWorkerTimelineActions(a: WorkerActionSummary, b: WorkerActionSummary): number {
  const createdA = Date.parse(a.createdAt);
  const createdB = Date.parse(b.createdAt);
  if (Number.isFinite(createdA) && Number.isFinite(createdB) && createdA !== createdB) {
    return createdA - createdB;
  }
  if (Number.isFinite(createdA) !== Number.isFinite(createdB)) {
    return Number.isFinite(createdA) ? -1 : 1;
  }
  return a.id.localeCompare(b.id);
}

export function sortWorkerTimelineActions(actions: readonly WorkerActionSummary[]): WorkerActionSummary[] {
  return [...actions].sort(compareWorkerTimelineActions);
}

export function compareWorkerTimelineEventRows(
  a: WorkerTimelineEventRow,
  b: WorkerTimelineEventRow,
): number {
  if (a.timestampMs !== b.timestampMs) return a.timestampMs - b.timestampMs;
  const idOrder = a.action.id.localeCompare(b.action.id);
  if (idOrder !== 0) return idOrder;
  if (a.eventKind === b.eventKind) return 0;
  return a.eventKind === 'launched' ? -1 : 1;
}

export function sortWorkerTimelineEventRows(
  rows: readonly WorkerTimelineEventRow[],
): WorkerTimelineEventRow[] {
  return [...rows].sort(compareWorkerTimelineEventRows);
}

export function getWorkerTimelineActionBounds(
  action: WorkerActionSummary,
  nowMs: number,
): WorkerTimelineActionBounds | null {
  const startMs = parseMs(action.createdAt);
  if (startMs === null) return null;
  const isActive = ACTIVE_WORKER_ACTION_STATUSES.has(action.status);
  if (isActive) {
    return { startMs, endMs: nowMs, isActive: true };
  }
  const endMs = parseMs(action.completedAt) ?? parseMs(action.updatedAt) ?? startMs;
  return { startMs, endMs, isActive: false };
}

export function buildWorkerTimelineEventRows(
  action: WorkerActionSummary,
  nowMs: number,
): WorkerTimelineEventRow[] | null {
  const bounds = getWorkerTimelineActionBounds(action, nowMs);
  if (!bounds) return null;
  const rows: WorkerTimelineEventRow[] = [
    {
      action,
      eventKind: 'launched',
      timestampMs: bounds.startMs,
    },
  ];
  const finishedMs = parseMs(action.completedAt);
  if (finishedMs !== null) {
    rows.push({
      action,
      eventKind: 'finished',
      timestampMs: finishedMs,
    });
  }
  return rows;
}
