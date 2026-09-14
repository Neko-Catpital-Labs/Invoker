import type { Logger } from '@invoker/contracts';
import type { TaskEvent } from '@invoker/data-store';

import { classifyAutoFixRecoveryPhase } from '../recovery-worker-observability.js';
import type { WorkerRuntimeDependencies } from '../worker-runtime-dependencies.js';
import type { WorkerRegistry } from '../worker-registry.js';
import { createWorkerRuntime, type WorkerRuntime, type WorkerTick } from '../worker-runtime.js';

export const THRASH_DETECTOR_WORKER_KIND = 'thrash-detector';
export const THRASH_DETECTED_EVENT_TYPE = 'thrash.detected';
export const DEFAULT_THRASH_DETECTOR_INTERVAL_MINUTES = 60;
export const DEFAULT_THRASH_DETECTOR_THRESHOLD_COUNT = 3;
export const DEFAULT_THRASH_DETECTOR_WINDOW_HOURS = 24;
export const DEFAULT_THRASH_DETECTOR_INTERVAL_MS = DEFAULT_THRASH_DETECTOR_INTERVAL_MINUTES * 60 * 1000;

export interface ThrashDetectorWorkerConfig {
  enabled?: boolean;
  intervalMs?: number;
  thresholdCount?: number;
  windowHours?: number;
  now?: () => Date;
  onTick?: WorkerTick;
}

export interface ThrashDetectorWorkerStore {
  listTaskEvents?(filters?: {
    eventTypes?: readonly string[];
    sortBy?: 'asc' | 'desc';
    limit?: number;
  }): TaskEvent[];
  logEvent?(taskId: string, eventType: string, payload?: unknown): void;
}

export interface ThrashDetectorWorkerOptions {
  logger: Logger;
  store: ThrashDetectorWorkerStore;
  intervalMs?: number;
  thresholdCount?: number;
  windowHours?: number;
  now?: () => Date;
  onTick?: WorkerTick;
}

interface SignatureBucket {
  signatureId: string;
  taskIds: Set<string>;
  count: number;
}

export function parseTaskEventPayload(event: TaskEvent): Record<string, unknown> {
  if (!event.payload) return {};
  if (typeof event.payload !== 'string') return {};
  try {
    const parsed: unknown = JSON.parse(event.payload);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function normalizeText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .toLowerCase()
    .replace(/\b[0-9a-f]{7,40}\b/g, '<sha>')
    .replace(/\/[^\s'"`]+/g, '<path>')
    .replace(/\d+/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
}

function payloadText(payload: Record<string, unknown>): string {
  return normalizeText(
    payload.terminalOutput
      ?? payload.output
      ?? payload.error
      ?? payload.message
      ?? payload.reason
      ?? '',
  );
}

export function buildThrashSignatureId(event: TaskEvent): string | undefined {
  const payload = parseTaskEventPayload(event);
  const phase = typeof payload.phase === 'string' ? payload.phase : '';
  const action = classifyAutoFixRecoveryPhase(phase, payload);
  const text = payloadText(payload);
  if (!action && !text) return undefined;
  return `${action ?? 'unknown'}:${text || phase || 'no-output'}`;
}

function recentlyDetectedSignatureIds(events: TaskEvent[], sinceMs: number): Set<string> {
  const seen = new Set<string>();
  for (const event of events) {
    if (event.eventType !== THRASH_DETECTED_EVENT_TYPE) continue;
    if (Date.parse(event.createdAt) < sinceMs) continue;
    const payload = parseTaskEventPayload(event);
    if (typeof payload.signatureId === 'string' && payload.signatureId.trim().length > 0) {
      seen.add(payload.signatureId);
    }
  }
  return seen;
}

export async function runThrashDetectorTick(options: ThrashDetectorWorkerOptions): Promise<void> {
  if (!options.store.listTaskEvents || !options.store.logEvent) {
    options.logger.warn?.(`[${THRASH_DETECTOR_WORKER_KIND}] store does not support task-event scan/audit write`, {
      module: THRASH_DETECTOR_WORKER_KIND,
    });
    return;
  }

  const thresholdCount = options.thresholdCount ?? DEFAULT_THRASH_DETECTOR_THRESHOLD_COUNT;
  const windowHours = options.windowHours ?? DEFAULT_THRASH_DETECTOR_WINDOW_HOURS;
  const nowMs = (options.now ?? (() => new Date()))().getTime();
  const sinceMs = nowMs - windowHours * 60 * 60 * 1000;
  const events = options.store.listTaskEvents({
    eventTypes: ['debug.auto-fix', THRASH_DETECTED_EVENT_TYPE],
    sortBy: 'desc',
    limit: 10_000,
  });
  const alreadyDetected = recentlyDetectedSignatureIds(events, sinceMs);
  const buckets = new Map<string, SignatureBucket>();

  for (const event of events) {
    if (event.eventType !== 'debug.auto-fix') continue;
    const createdMs = Date.parse(event.createdAt);
    if (!Number.isFinite(createdMs) || createdMs < sinceMs || createdMs > nowMs) continue;
    const signatureId = buildThrashSignatureId(event);
    if (!signatureId) continue;
    const bucket = buckets.get(signatureId) ?? {
      signatureId,
      taskIds: new Set<string>(),
      count: 0,
    };
    bucket.count += 1;
    bucket.taskIds.add(event.taskId);
    buckets.set(signatureId, bucket);
  }

  for (const bucket of buckets.values()) {
    if (bucket.count < thresholdCount) continue;
    if (alreadyDetected.has(bucket.signatureId)) continue;
    const matchingTaskIds = [...bucket.taskIds].sort();
    options.store.logEvent(matchingTaskIds[0] ?? THRASH_DETECTOR_WORKER_KIND, THRASH_DETECTED_EVENT_TYPE, {
      workerId: THRASH_DETECTOR_WORKER_KIND,
      kind: THRASH_DETECTOR_WORKER_KIND,
      action: 'detected',
      signatureId: bucket.signatureId,
      matchingTaskIds,
      count: bucket.count,
      window: {
        hours: windowHours,
        since: new Date(sinceMs).toISOString(),
        until: new Date(nowMs).toISOString(),
      },
    });
  }
}

export function createThrashDetectorWorker(config: ThrashDetectorWorkerOptions): WorkerRuntime {
  const onTick: WorkerTick = config.onTick ?? (async () => {
    await runThrashDetectorTick(config);
  });
  return createWorkerRuntime({
    kind: THRASH_DETECTOR_WORKER_KIND,
    logger: config.logger,
    onTick,
    intervalMs: config.intervalMs ?? DEFAULT_THRASH_DETECTOR_INTERVAL_MS,
    tickOnStart: true,
  });
}

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
