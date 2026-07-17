import type { TaskEvent } from '@invoker/data-store';

import { RECOVERY_WORKER_KIND } from './workers/auto-fix-recovery.js';

export const RECOVERY_WORKER_ID = 'auto-fix-recovery';
export const RECOVERY_WORKER_OWNER = 'auto-fix';

export type RecoveryWorkerAuditAction = 'wakeup' | 'scan' | 'submit' | 'skip';
export type RecoveryWorkerAuditEventType = `recovery.worker.${RecoveryWorkerAuditAction}`;

export interface RecoveryWorkerAuditPayload {
  readonly workerId: string;
  readonly kind: string;
  readonly owner: string;
  readonly action: RecoveryWorkerAuditAction;
  readonly phase: string;
  readonly reason?: string;
  readonly trigger?: string;
  readonly status?: string;
  readonly workflowId?: string | null;
  readonly details?: Record<string, unknown>;
}

export interface RecoveryWorkerStatus {
  readonly kind: string;
  readonly workerId: string;
  readonly owner: string;
  readonly lastWakeupAt?: string;
  readonly lastScanAt?: string;
  readonly lastSubmitAt?: string;
  readonly lastSkipAt?: string;
  readonly lastSkipReason?: string;
  readonly lastSkipTaskId?: string;
  readonly wakeups: number;
  readonly scans: number;
  readonly submissions: number;
  readonly skips: number;
  readonly recent: RecoveryWorkerStatusEvent[];
}

export interface RecoveryWorkerStatusEvent {
  readonly at: string;
  readonly taskId: string;
  readonly eventType: RecoveryWorkerAuditEventType;
  readonly action: RecoveryWorkerAuditAction;
  readonly phase?: string;
  readonly reason?: string;
  readonly workflowId?: string | null;
}

export interface RecoveryWorkerStatusPersistence {
  getEventsByTypes?(
    eventTypes: readonly string[],
    sortBy: 'asc' | 'desc',
    limit: number,
  ): TaskEvent[];
  countEventsByTypes?(eventTypes: readonly string[]): Array<{
    eventType: string;
    count: number;
    lastCreatedAt: string | null;
  }>;
  listWorkflows?(): Array<{ id: string }>;
  loadTasks?(workflowId: string): Array<{ id: string }>;
  getEvents?(taskId: string): TaskEvent[];
}

const RECOVERY_EVENT_TYPES: Record<RecoveryWorkerAuditAction, RecoveryWorkerAuditEventType> = {
  wakeup: 'recovery.worker.wakeup',
  scan: 'recovery.worker.scan',
  submit: 'recovery.worker.submit',
  skip: 'recovery.worker.skip',
};

const ALL_RECOVERY_EVENT_TYPES = Object.values(RECOVERY_EVENT_TYPES);

export function recoveryWorkerEventType(action: RecoveryWorkerAuditAction): RecoveryWorkerAuditEventType {
  return RECOVERY_EVENT_TYPES[action];
}

export function classifyAutoFixRecoveryPhase(
  phase: string,
  details: Record<string, unknown> = {},
): RecoveryWorkerAuditAction | undefined {
  if (phase === 'delta-failed') return 'wakeup';
  if (phase === 'poll-failed' || phase === 'schedule-enter') return 'scan';
  if (phase === 'schedule-enqueued' || phase === 'worker-autofix-submitted') return 'submit';
  if (phase === 'schedule-skip' || phase.endsWith('-skip')) return 'skip';
  if (details.reason && (phase.includes('skip') || phase.includes('error'))) return 'skip';
  return undefined;
}

export function buildRecoveryWorkerAuditPayload(
  action: RecoveryWorkerAuditAction,
  phase: string,
  details: Record<string, unknown> = {},
): RecoveryWorkerAuditPayload {
  const reason = typeof details.reason === 'string' ? details.reason : undefined;
  const trigger = phase.startsWith('delta-')
    ? 'delta'
    : phase.startsWith('poll-')
      ? 'poll'
      : undefined;
  const workflowId = typeof details.workflowId === 'string' || details.workflowId === null
    ? details.workflowId
    : undefined;
  const status = typeof details.status === 'string' ? details.status : undefined;

  return {
    workerId: RECOVERY_WORKER_ID,
    kind: RECOVERY_WORKER_KIND,
    owner: RECOVERY_WORKER_OWNER,
    action,
    phase,
    ...(reason !== undefined ? { reason } : {}),
    ...(trigger !== undefined ? { trigger } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(workflowId !== undefined ? { workflowId } : {}),
    details,
  };
}

export function collectRecoveryWorkerStatus(
  persistence: RecoveryWorkerStatusPersistence,
): RecoveryWorkerStatus {
  const status = emptyRecoveryWorkerStatus();

  if (typeof persistence.countEventsByTypes === 'function'
    && typeof persistence.getEventsByTypes === 'function') {
    return collectFromAggregates(persistence, status);
  }

  return collectFromLegacyScan(persistence, status);
}

function collectFromAggregates(
  persistence: RecoveryWorkerStatusPersistence,
  status: RecoveryWorkerStatus,
): RecoveryWorkerStatus {
  const counts = persistence.countEventsByTypes!(ALL_RECOVERY_EVENT_TYPES);
  const countByType = new Map(counts.map((row) => [row.eventType, row]));

  const wakeups = countByType.get(RECOVERY_EVENT_TYPES.wakeup)?.count ?? 0;
  const scans = countByType.get(RECOVERY_EVENT_TYPES.scan)?.count ?? 0;
  const submissions = countByType.get(RECOVERY_EVENT_TYPES.submit)?.count ?? 0;
  const skips = countByType.get(RECOVERY_EVENT_TYPES.skip)?.count ?? 0;

  const lastWakeupAt = countByType.get(RECOVERY_EVENT_TYPES.wakeup)?.lastCreatedAt ?? undefined;
  const lastScanAt = countByType.get(RECOVERY_EVENT_TYPES.scan)?.lastCreatedAt ?? undefined;
  const lastSubmitAt = countByType.get(RECOVERY_EVENT_TYPES.submit)?.lastCreatedAt ?? undefined;

  const recentEvents = persistence.getEventsByTypes!(ALL_RECOVERY_EVENT_TYPES, 'desc', 10)
    .filter((event): event is TaskEvent & { eventType: RecoveryWorkerAuditEventType } =>
      isRecoveryWorkerAuditEventType(event.eventType))
    .map((event) => toStatusEvent(event));

  let lastSkip = recentEvents.find((event) => event.action === 'skip');
  if (!lastSkip) {
    const lastSkipEvent = persistence.getEventsByTypes!([RECOVERY_EVENT_TYPES.skip], 'desc', 1)[0];
    if (lastSkipEvent && isRecoveryWorkerAuditEventType(lastSkipEvent.eventType)) {
      lastSkip = toStatusEvent(lastSkipEvent as TaskEvent & { eventType: RecoveryWorkerAuditEventType });
    }
  }

  return {
    ...status,
    ...(lastWakeupAt ? { lastWakeupAt } : {}),
    ...(lastScanAt ? { lastScanAt } : {}),
    ...(lastSubmitAt ? { lastSubmitAt } : {}),
    ...(lastSkip ? {
      lastSkipAt: lastSkip.at,
      lastSkipReason: lastSkip.reason ?? 'unknown',
      lastSkipTaskId: lastSkip.taskId,
    } : {}),
    wakeups,
    scans,
    submissions,
    skips,
    recent: recentEvents,
  };
}

function collectFromLegacyScan(
  persistence: RecoveryWorkerStatusPersistence,
  status: RecoveryWorkerStatus,
): RecoveryWorkerStatus {
  const events: RecoveryWorkerStatusEvent[] = [];

  for (const workflow of persistence.listWorkflows?.() ?? []) {
    for (const task of persistence.loadTasks?.(workflow.id) ?? []) {
      for (const event of persistence.getEvents?.(task.id) ?? []) {
        if (!isRecoveryWorkerAuditEventType(event.eventType)) continue;
        events.push(toStatusEvent(event as TaskEvent & { eventType: RecoveryWorkerAuditEventType }));
      }
    }
  }

  events.sort((a, b) => a.at.localeCompare(b.at) || a.taskId.localeCompare(b.taskId));

  let lastWakeupAt: string | undefined;
  let lastScanAt: string | undefined;
  let lastSubmitAt: string | undefined;
  let lastSkip: RecoveryWorkerStatusEvent | undefined;
  let wakeups = 0;
  let scans = 0;
  let submissions = 0;
  let skips = 0;

  for (const event of events) {
    if (event.action === 'wakeup') {
      wakeups += 1;
      lastWakeupAt = event.at;
    } else if (event.action === 'scan') {
      scans += 1;
      lastScanAt = event.at;
    } else if (event.action === 'submit') {
      submissions += 1;
      lastSubmitAt = event.at;
    } else if (event.action === 'skip') {
      skips += 1;
      lastSkip = event;
    }
  }

  return {
    ...status,
    ...(lastWakeupAt !== undefined ? { lastWakeupAt } : {}),
    ...(lastScanAt !== undefined ? { lastScanAt } : {}),
    ...(lastSubmitAt !== undefined ? { lastSubmitAt } : {}),
    ...(lastSkip !== undefined ? {
      lastSkipAt: lastSkip.at,
      lastSkipReason: lastSkip.reason ?? 'unknown',
      lastSkipTaskId: lastSkip.taskId,
    } : {}),
    wakeups,
    scans,
    submissions,
    skips,
    recent: events.slice(-10).reverse(),
  };
}

function toStatusEvent(
  event: TaskEvent & { eventType: RecoveryWorkerAuditEventType },
): RecoveryWorkerStatusEvent {
  const payload = parsePayload(event.payload);
  const action = actionForEventType(event.eventType);
  return {
    at: event.createdAt,
    taskId: event.taskId,
    eventType: event.eventType,
    action,
    ...(typeof payload.phase === 'string' ? { phase: payload.phase } : {}),
    ...(typeof payload.reason === 'string' ? { reason: payload.reason } : {}),
    ...(typeof payload.workflowId === 'string' || payload.workflowId === null
      ? { workflowId: payload.workflowId }
      : {}),
  };
}

function emptyRecoveryWorkerStatus(): RecoveryWorkerStatus {
  return {
    kind: RECOVERY_WORKER_KIND,
    workerId: RECOVERY_WORKER_ID,
    owner: RECOVERY_WORKER_OWNER,
    wakeups: 0,
    scans: 0,
    submissions: 0,
    skips: 0,
    recent: [],
  };
}

function parsePayload(payload: unknown): Record<string, unknown> {
  if (!payload) return {};
  if (typeof payload === 'object' && !Array.isArray(payload)) return payload as Record<string, unknown>;
  if (typeof payload !== 'string') return {};
  try {
    const parsed = JSON.parse(payload);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function isRecoveryWorkerAuditEventType(value: string): value is RecoveryWorkerAuditEventType {
  return value === 'recovery.worker.wakeup'
    || value === 'recovery.worker.scan'
    || value === 'recovery.worker.submit'
    || value === 'recovery.worker.skip';
}

function actionForEventType(eventType: RecoveryWorkerAuditEventType): RecoveryWorkerAuditAction {
  return eventType.slice('recovery.worker.'.length) as RecoveryWorkerAuditAction;
}
