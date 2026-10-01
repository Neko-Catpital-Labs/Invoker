import { createHash } from 'node:crypto';

import type { Logger } from '@invoker/contracts';
import type { TaskEvent } from '@invoker/data-store';
import type { TaskState } from '@invoker/workflow-core';

import type { WorkerRuntimeDependencies } from '../worker-runtime-dependencies.js';
import type { WorkerRegistry } from '../worker-registry.js';
import { createWorkerRuntime, type WorkerRuntime, type WorkerTick } from '../worker-runtime.js';

export const THRASH_DETECTOR_WORKER_KIND = 'thrash-detector';
export const THRASH_DETECTED_EVENT_TYPE = 'thrash.detected';
export const DEFAULT_THRASH_DETECTOR_INTERVAL_MINUTES = 60;
export const DEFAULT_THRASH_DETECTOR_INTERVAL_MS = DEFAULT_THRASH_DETECTOR_INTERVAL_MINUTES * 60 * 1000;
export const DEFAULT_THRASH_DETECTOR_THRESHOLD_COUNT = 3;
export const DEFAULT_THRASH_DETECTOR_WINDOW_HOURS = 24;

export type RecoveryWorkerAuditAction = 'wakeup' | 'scan' | 'submit' | 'skip';

export interface ThrashDetectorWorkerConfig {
  enabled?: boolean;
  /** Poll cadence in milliseconds. Defaults to one hour. */
  intervalMs?: number;
  thresholdCount?: number;
  windowHours?: number;
  tickOnStart?: boolean;
  now?: () => Date;
  onTick?: WorkerTick;
}

export interface ThrashDetectorStore {
  listTaskEvents?(filters?: { eventTypes?: readonly string[]; sortBy?: 'asc' | 'desc'; limit?: number }): TaskEvent[];
  listWorkflows(): ReadonlyArray<{ id: string }>;
  loadTasks(workflowId: string): TaskState[];
  loadTasksForWorkflows?(workflowIds: string[]): TaskState[];
  loadTask?(taskId: string): TaskState | undefined;
  logEvent?(taskId: string, eventType: string, payload?: unknown): void;
}

export interface ThrashDetectorWorkerOptions {
  logger: Logger;
  store: ThrashDetectorStore;
  enabled?: boolean;
  thresholdCount?: number;
  windowHours?: number;
  now?: () => Date;
}

interface ParsedAutoFixEvent {
  event: TaskEvent;
  payload: Record<string, unknown>;
  task: TaskState | undefined;
}

interface SignatureBucket {
  signatureId: string;
  signature: string;
  action: RecoveryWorkerAuditAction | 'unclassified';
  matchingTaskIds: string[];
  events: ParsedAutoFixEvent[];
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

function positiveIntegerOrDefault(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function parsePayload(payload: string | undefined): Record<string, unknown> {
  if (!payload) return {};
  try {
    const parsed = JSON.parse(payload);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function createdAtMs(event: TaskEvent): number {
  const ms = Date.parse(event.createdAt);
  return Number.isFinite(ms) ? ms : 0;
}

function normalizeFailureText(text: string | undefined): string {
  return (text ?? '')
    .toLowerCase()
    .replace(/[a-f0-9]{7,40}/g, '<sha>')
    .replace(/\b\d+\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(-2_000);
}

export function buildThrashSignature(input: {
  phase: string;
  payload: Record<string, unknown>;
  task: TaskState | undefined;
}): { signatureId: string; signature: string; action: RecoveryWorkerAuditAction | 'unclassified' } {
  const action = classifyAutoFixRecoveryPhase(input.phase, input.payload) ?? 'unclassified';
  const failureText = normalizeFailureText(input.task?.execution.error);
  const fallbackReason = typeof input.payload.reason === 'string' ? normalizeFailureText(input.payload.reason) : '';
  const signature = [
    `action=${action}`,
    `failure=${failureText || fallbackReason || 'unknown'}`,
  ].join('|');
  const signatureId = createHash('sha256').update(signature).digest('hex').slice(0, 16);
  return { signatureId, signature, action };
}

function loadTaskMap(store: ThrashDetectorStore): Map<string, TaskState> {
  const workflows = store.listWorkflows();
  const tasks = store.loadTasksForWorkflows
    ? store.loadTasksForWorkflows(workflows.map((workflow) => workflow.id))
    : workflows.flatMap((workflow) => store.loadTasks(workflow.id));
  return new Map(tasks.map((task) => [task.id, task]));
}

function collectExistingDetectedSignatureIds(events: TaskEvent[], windowStartMs: number): Set<string> {
  const signatureIds = new Set<string>();
  for (const event of events) {
    if (createdAtMs(event) < windowStartMs) continue;
    const payload = parsePayload(event.payload);
    if (typeof payload.signatureId === 'string') {
      signatureIds.add(payload.signatureId);
    }
  }
  return signatureIds;
}

export async function runThrashDetectorTick(options: ThrashDetectorWorkerOptions): Promise<void> {
  if (options.enabled === false) return;
  if (!options.store.listTaskEvents || !options.store.logEvent) {
    options.logger.warn?.(`[${THRASH_DETECTOR_WORKER_KIND}] missing event-log methods; skipping`, {
      module: THRASH_DETECTOR_WORKER_KIND,
    });
    return;
  }

  const thresholdCount = positiveIntegerOrDefault(options.thresholdCount, DEFAULT_THRASH_DETECTOR_THRESHOLD_COUNT);
  const windowHours = positiveIntegerOrDefault(options.windowHours, DEFAULT_THRASH_DETECTOR_WINDOW_HOURS);
  const now = options.now?.() ?? new Date();
  const windowStartMs = now.getTime() - windowHours * 60 * 60 * 1000;
  const taskById = loadTaskMap(options.store);
  const events = options.store.listTaskEvents({
    eventTypes: ['debug.auto-fix', THRASH_DETECTED_EVENT_TYPE],
    sortBy: 'asc',
  });
  const existingDetected = collectExistingDetectedSignatureIds(
    events.filter((event) => event.eventType === THRASH_DETECTED_EVENT_TYPE),
    windowStartMs,
  );
  const buckets = new Map<string, SignatureBucket>();

  for (const event of events) {
    if (event.eventType !== 'debug.auto-fix') continue;
    if (createdAtMs(event) < windowStartMs) continue;
    const payload = parsePayload(event.payload);
    const phase = typeof payload.phase === 'string' ? payload.phase : '';
    if (!phase) continue;
    const task = options.store.loadTask?.(event.taskId) ?? taskById.get(event.taskId);
    const { signatureId, signature, action } = buildThrashSignature({ phase, payload, task });
    let bucket = buckets.get(signatureId);
    if (!bucket) {
      bucket = { signatureId, signature, action, matchingTaskIds: [], events: [] };
      buckets.set(signatureId, bucket);
    }
    if (!bucket.matchingTaskIds.includes(event.taskId)) {
      bucket.matchingTaskIds.push(event.taskId);
    }
    bucket.events.push({ event, payload, task });
  }

  for (const bucket of buckets.values()) {
    if (bucket.events.length < thresholdCount || existingDetected.has(bucket.signatureId)) continue;
    const latest = bucket.events[bucket.events.length - 1];
    options.store.logEvent(latest.event.taskId, THRASH_DETECTED_EVENT_TYPE, {
      workerId: THRASH_DETECTOR_WORKER_KIND,
      kind: THRASH_DETECTOR_WORKER_KIND,
      signatureId: bucket.signatureId,
      signature: bucket.signature,
      action: bucket.action,
      matchingTaskIds: bucket.matchingTaskIds,
      count: bucket.events.length,
      window: {
        hours: windowHours,
        startedAt: new Date(windowStartMs).toISOString(),
        endedAt: now.toISOString(),
      },
    });
  }
}

export function createThrashDetectorWorker(config: ThrashDetectorWorkerConfig & {
  logger: Logger;
  store: ThrashDetectorStore;
}): WorkerRuntime {
  const onTick: WorkerTick = config.onTick ?? (async () => {
    await runThrashDetectorTick({
      logger: config.logger,
      store: config.store,
      enabled: config.enabled,
      thresholdCount: config.thresholdCount,
      windowHours: config.windowHours,
      now: config.now,
    });
  });
  return createWorkerRuntime({
    kind: THRASH_DETECTOR_WORKER_KIND,
    logger: config.logger,
    onTick,
    intervalMs: config.intervalMs ?? DEFAULT_THRASH_DETECTOR_INTERVAL_MS,
    tickOnStart: config.tickOnStart ?? true,
    listWorkKeys: () => ['thrash-detector:scan'],
  });
}

/** Register the built-in thrash-detector worker. */
export function registerThrashDetectorWorker(
  registry: WorkerRegistry<WorkerRuntimeDependencies>,
): WorkerRegistry<WorkerRuntimeDependencies> {
  registry.register({
    kind: THRASH_DETECTOR_WORKER_KIND,
    note: 'Aggregates recurring debug.auto-fix events by failure signature and logs thrash.detected audit events.',
    source: 'built-in',
    factory: (deps: WorkerRuntimeDependencies): WorkerRuntime =>
      createThrashDetectorWorker({
        logger: deps.logger,
        store: deps.store,
        ...deps.thrashDetector,
      }),
  });
  return registry;
}
