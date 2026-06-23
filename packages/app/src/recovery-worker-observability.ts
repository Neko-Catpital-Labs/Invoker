import type { TaskEvent, Workflow } from '@invoker/data-store';
import type { TaskState } from '@invoker/workflow-core';

import { RECOVERY_WORKER_KIND } from './worker-runtime.js';

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
  readonly autoFixAttempts?: number | null;
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
  listWorkflows(): Workflow[];
  loadTasks(workflowId: string): TaskState[];
  getEvents(taskId: string): TaskEvent[];
}

const RECOVERY_EVENT_TYPES: Record<RecoveryWorkerAuditAction, RecoveryWorkerAuditEventType> = {
  wakeup: 'recovery.worker.wakeup',
  scan: 'recovery.worker.scan',
  submit: 'recovery.worker.submit',
  skip: 'recovery.worker.skip',
};

export function recoveryWorkerEventType(action: RecoveryWorkerAuditAction): RecoveryWorkerAuditEventType {
  return RECOVERY_EVENT_TYPES[action];
}

export function classifyAutoFixRecoveryPhase(
  phase: string,
  details: Record<string, unknown> = {},
): RecoveryWorkerAuditAction | undefined {
  if (phase === 'delta-failed') return 'wakeup';
  if (phase === 'poll-failed' || phase === 'schedule-enter') return 'scan';
  if (phase === 'schedule-enqueued') return 'submit';
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
  const autoFixAttempts = typeof details.autoFixAttempts === 'number' || details.autoFixAttempts === null
    ? details.autoFixAttempts
    : undefined;

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
    ...(autoFixAttempts !== undefined ? { autoFixAttempts } : {}),
    details,
  };
}

export function collectRecoveryWorkerStatus(
  persistence: RecoveryWorkerStatusPersistence,
): RecoveryWorkerStatus {
  const status = emptyRecoveryWorkerStatus();
  const events: RecoveryWorkerStatusEvent[] = [];

  for (const workflow of persistence.listWorkflows()) {
    for (const task of persistence.loadTasks(workflow.id)) {
      for (const event of persistence.getEvents(task.id)) {
        if (!isRecoveryWorkerAuditEventType(event.eventType)) continue;
        const payload = parsePayload(event.payload);
        const action = actionForEventType(event.eventType);
        events.push({
          at: event.createdAt,
          taskId: event.taskId,
          eventType: event.eventType,
          action,
          ...(typeof payload.phase === 'string' ? { phase: payload.phase } : {}),
          ...(typeof payload.reason === 'string' ? { reason: payload.reason } : {}),
          ...(typeof payload.workflowId === 'string' || payload.workflowId === null ? { workflowId: payload.workflowId } : {}),
        });
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
