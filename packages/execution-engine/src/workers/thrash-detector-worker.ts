import type { Logger } from '@invoker/contracts';
import type { TaskEvent } from '@invoker/data-store';
import type { TaskState } from '@invoker/workflow-core';

import { classifyAutoFixRecoveryPhase as defaultClassifyAutoFixRecoveryPhase } from '../recovery-worker-observability.js';
import type { WorkerRuntimeDependencies } from '../worker-runtime-dependencies.js';
import type { WorkerRegistry } from '../worker-registry.js';
import { createWorkerRuntime, type WorkerRuntime, type WorkerTick } from '../worker-runtime.js';

export const THRASH_DETECTOR_WORKER_KIND = 'thrash-detector';
export const THRASH_DETECTED_EVENT_TYPE = 'thrash.detected';
export const DEFAULT_THRASH_DETECTOR_INTERVAL_MINUTES = 60;
export const DEFAULT_THRASH_DETECTOR_INTERVAL_MS = DEFAULT_THRASH_DETECTOR_INTERVAL_MINUTES * 60 * 1000;
export const DEFAULT_THRASH_DETECTOR_THRESHOLD_COUNT = 3;
export const DEFAULT_THRASH_DETECTOR_WINDOW_HOURS = 24;
const DEBUG_AUTO_FIX_EVENT_TYPE = 'debug.auto-fix';
const DEFAULT_EVENT_SCAN_LIMIT = 1_000;

export type AutoFixRecoveryPhaseClassifier = (
  phase: string,
  details?: Record<string, unknown>,
) => string | undefined;

export interface ThrashDetectorWorkerStore {
  listTaskEvents?(filters?: {
    taskId?: string;
    eventTypes?: readonly string[];
    sortBy?: 'asc' | 'desc';
    limit?: number;
  }): TaskEvent[];
  logEvent?(taskId: string, eventType: string, payload?: unknown): void;
  loadTask?(taskId: string): TaskState | undefined;
  getTaskOutput?(taskId: string): string;
}

export interface ThrashDetectorWorkerConfig {
  enabled?: boolean;
  intervalMs?: number;
  thresholdCount?: number;
  windowHours?: number;
  eventScanLimit?: number;
  tickOnStart?: boolean;
  store?: ThrashDetectorWorkerStore;
  classifyAutoFixRecoveryPhase?: AutoFixRecoveryPhaseClassifier;
  now?: () => Date;
  onTick?: WorkerTick;
}

export interface ThrashDetectorWorkerOptions {
  logger: Logger;
  intervalMs?: number;
  thresholdCount: number;
  windowHours: number;
  eventScanLimit?: number;
  tickOnStart?: boolean;
  store: ThrashDetectorWorkerStore;
  classifyAutoFixRecoveryPhase: AutoFixRecoveryPhaseClassifier;
  now?: () => Date;
  onTick?: WorkerTick;
}

interface ParsedAutoFixEvent {
  event: TaskEvent;
  payload: Record<string, unknown>;
  signatureId: string;
}

interface SignatureBucket {
  signatureId: string;
  events: ParsedAutoFixEvent[];
}

export function normalizeThrashSignature(input: string): string {
  return input
    .toLowerCase()
    .replace(/[a-f0-9]{7,40}/g, '<sha>')
    .replace(/\b\d+\b/g, '<num>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
}

export function extractAutoFixThrashSignature(
  event: TaskEvent,
  payload: Record<string, unknown>,
  options: Pick<ThrashDetectorWorkerOptions, 'store' | 'classifyAutoFixRecoveryPhase'>,
): string | undefined {
  const phase = typeof payload.phase === 'string' ? payload.phase : '';
  const action = options.classifyAutoFixRecoveryPhase(phase, payload);
  if (!action) return undefined;

  const task = options.store.loadTask?.(event.taskId);
  const explicitFailure = [
    typeof payload.reason === 'string' ? payload.reason : '',
    typeof payload.error === 'string' ? payload.error : '',
    typeof payload.errorMessage === 'string' ? payload.errorMessage : '',
    typeof task?.execution?.error === 'string' ? task.execution.error : '',
  ].filter(Boolean).join('\n');
  const output = explicitFailure || (options.store.getTaskOutput?.(event.taskId) ?? '');
  const basis = [
    action,
    phase,
    explicitFailure,
    output,
  ].filter(Boolean).join('\n');

  const normalized = normalizeThrashSignature(basis);
  return normalized ? normalized : undefined;
}

export function runThrashDetectorTick(options: ThrashDetectorWorkerOptions): void {
  if (options.store.listTaskEvents === undefined || options.store.logEvent === undefined) {
    options.logger.debug?.(`[${THRASH_DETECTOR_WORKER_KIND}] skipped: event store unavailable`, {
      module: THRASH_DETECTOR_WORKER_KIND,
    });
    return;
  }

  const now = options.now?.() ?? new Date();
  const windowMs = options.windowHours * 60 * 60 * 1000;
  const cutoffMs = now.getTime() - windowMs;
  const events = options.store.listTaskEvents({
    eventTypes: [DEBUG_AUTO_FIX_EVENT_TYPE, THRASH_DETECTED_EVENT_TYPE],
    sortBy: 'desc',
    limit: options.eventScanLimit ?? DEFAULT_EVENT_SCAN_LIMIT,
  });
  const buckets = new Map<string, SignatureBucket>();
  const alreadyDetected = new Set<string>();

  for (const event of events) {
    const eventTime = Date.parse(event.createdAt);
    if (!Number.isFinite(eventTime) || eventTime < cutoffMs) continue;
    const payload = parsePayload(event.payload);
    if (event.eventType === THRASH_DETECTED_EVENT_TYPE) {
      const signatureId = typeof payload.signatureId === 'string' ? payload.signatureId : undefined;
      if (signatureId) alreadyDetected.add(signatureId);
      continue;
    }
    if (event.eventType !== DEBUG_AUTO_FIX_EVENT_TYPE) continue;
    const signatureId = extractAutoFixThrashSignature(event, payload, options);
    if (!signatureId) continue;
    const bucket = buckets.get(signatureId) ?? { signatureId, events: [] };
    bucket.events.push({ event, payload, signatureId });
    buckets.set(signatureId, bucket);
  }

  for (const bucket of buckets.values()) {
    if (bucket.events.length < options.thresholdCount) continue;
    if (alreadyDetected.has(bucket.signatureId)) continue;
    const ordered = bucket.events.slice().sort((a, b) => a.event.id - b.event.id);
    const matchingTaskIds = Array.from(new Set(ordered.map((entry) => entry.event.taskId)));
    const anchorTaskId = matchingTaskIds[0];
    if (!anchorTaskId) continue;
    options.store.logEvent(anchorTaskId, THRASH_DETECTED_EVENT_TYPE, {
      signatureId: bucket.signatureId,
      matchingTaskIds,
      count: bucket.events.length,
      window: {
        hours: options.windowHours,
        since: new Date(cutoffMs).toISOString(),
        until: now.toISOString(),
      },
      eventIds: ordered.map((entry) => entry.event.id),
      phases: Array.from(new Set(ordered
        .map((entry) => entry.payload.phase)
        .filter((phase): phase is string => typeof phase === 'string'))),
    });
    alreadyDetected.add(bucket.signatureId);
    options.logger.info(`[${THRASH_DETECTOR_WORKER_KIND}] detected repeated auto-fix failure signature`, {
      module: THRASH_DETECTOR_WORKER_KIND,
      signatureId: bucket.signatureId,
      count: bucket.events.length,
      matchingTaskIds,
    });
  }
}

export function createThrashDetectorWorker(config: ThrashDetectorWorkerConfig & { logger: Logger }): WorkerRuntime {
  const store = config.store;
  if (!store) {
    throw new Error('thrash-detector worker requires a store');
  }
  const classifyAutoFixRecoveryPhase = config.classifyAutoFixRecoveryPhase ?? defaultClassifyAutoFixRecoveryPhase;
  const options: ThrashDetectorWorkerOptions = {
    logger: config.logger,
    intervalMs: config.intervalMs,
    thresholdCount: config.thresholdCount ?? DEFAULT_THRASH_DETECTOR_THRESHOLD_COUNT,
    windowHours: config.windowHours ?? DEFAULT_THRASH_DETECTOR_WINDOW_HOURS,
    eventScanLimit: config.eventScanLimit,
    tickOnStart: config.tickOnStart,
    store,
    classifyAutoFixRecoveryPhase,
    now: config.now,
  };
  const onTick: WorkerTick = config.onTick ?? (async () => {
    runThrashDetectorTick(options);
  });
  return createWorkerRuntime({
    kind: THRASH_DETECTOR_WORKER_KIND,
    logger: config.logger,
    onTick,
    intervalMs: config.intervalMs ?? DEFAULT_THRASH_DETECTOR_INTERVAL_MS,
    tickOnStart: config.tickOnStart ?? true,
  });
}

/** Register the built-in thrash-detector worker. */
export function registerThrashDetectorWorker(
  registry: WorkerRegistry<WorkerRuntimeDependencies>,
): WorkerRegistry<WorkerRuntimeDependencies> {
  registry.register({
    kind: THRASH_DETECTOR_WORKER_KIND,
    note: 'Aggregates recurring debug.auto-fix events by failure signature and records thrash.detected audit events.',
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
