import { createHash } from 'node:crypto';

import type { Logger } from '@invoker/contracts';
import type { TaskEvent } from '@invoker/data-store';

import type { WorkerRuntimeDependencies } from '../worker-runtime-dependencies.js';
import type { WorkerRegistry } from '../worker-registry.js';
import { createWorkerRuntime, type WorkerRuntime, type WorkerTick } from '../worker-runtime.js';

export const THRASH_DETECTOR_WORKER_KIND = 'thrash-detector';
export const THRASH_DETECTED_EVENT_TYPE = 'thrash.detected';
export const THRASH_SOURCE_EVENT_TYPE = 'debug.auto-fix';
export const DEFAULT_THRASH_DETECTOR_INTERVAL_MINUTES = 15;
export const DEFAULT_THRASH_DETECTOR_INTERVAL_MS = DEFAULT_THRASH_DETECTOR_INTERVAL_MINUTES * 60_000;
export const DEFAULT_THRASH_DETECTOR_THRESHOLD_COUNT = 3;
export const DEFAULT_THRASH_DETECTOR_WINDOW_HOURS = 24;
export const DEFAULT_THRASH_DETECTOR_WINDOW_MS = DEFAULT_THRASH_DETECTOR_WINDOW_HOURS * 60 * 60_000;

export type AutoFixPhaseClassifier = (
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
  getTaskOutput?(taskId: string): string;
  logEvent?(taskId: string, eventType: string, payload?: unknown): void;
}

export interface ThrashDetectorWorkerConfig {
  enabled?: boolean;
  intervalMs?: number;
  thresholdCount?: number;
  windowMs?: number;
  tickOnStart?: boolean;
  classifyAutoFixRecoveryPhase?: AutoFixPhaseClassifier;
  store?: ThrashDetectorWorkerStore;
  onTick?: WorkerTick;
  now?: () => number;
}

export interface ThrashDetectorWorkerOptions extends ThrashDetectorWorkerConfig {
  logger: Logger;
  store: ThrashDetectorWorkerStore;
}

export interface ThrashDetection {
  signatureId: string;
  signature: string;
  count: number;
  matchingTaskIds: string[];
  latestTaskId: string;
  window: {
    hours: number;
    startsAt: string;
    endsAt: string;
  };
}

interface SignatureGroup {
  signatureId: string;
  signature: string;
  latestTaskId: string;
  latestCreatedAt: string;
  taskIds: Set<string>;
}

export function normalizeThrashFailureText(text: string): string {
  const stripped = text
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/\r/g, '\n')
    .replace(/\b[0-9a-f]{7,40}\b/gi, '<sha>')
    .replace(/\/[^\s'"]+/g, '<path>')
    .replace(/[A-Za-z]:\\[^\s'"]+/g, '<path>');

  return stripped
    .split('\n')
    .map((line) => line.trim().replace(/\s+/g, ' '))
    .filter(Boolean)
    .slice(-80)
    .join('\n')
    .toLowerCase();
}

export function planThrashDetections(options: {
  events: readonly TaskEvent[];
  existingDetections: readonly TaskEvent[];
  getTaskOutput: (taskId: string) => string;
  classifyAutoFixRecoveryPhase?: AutoFixPhaseClassifier;
  thresholdCount: number;
  windowMs: number;
  nowMs: number;
}): ThrashDetection[] {
  const windowStartMs = options.nowMs - options.windowMs;
  const alreadyDetected = new Set(
    options.existingDetections
      .map((event) => parseEventPayload(event.payload).signatureId)
      .filter((value): value is string => typeof value === 'string' && value.length > 0),
  );
  const groups = new Map<string, SignatureGroup>();

  for (const event of options.events) {
    if (event.eventType !== THRASH_SOURCE_EVENT_TYPE) continue;
    const createdMs = Date.parse(event.createdAt);
    if (!Number.isFinite(createdMs) || createdMs < windowStartMs || createdMs > options.nowMs) continue;
    const payload = parseEventPayload(event.payload);
    const phase = typeof payload.phase === 'string' ? payload.phase : 'unknown';
    const action = options.classifyAutoFixRecoveryPhase?.(phase, payload) ?? `phase:${phase}`;
    const outputText = normalizeThrashFailureText(options.getTaskOutput(event.taskId));
    const fallbackText = normalizePayloadFailureText(payload);
    const signature = `${action}\n${outputText || fallbackText || 'no-output'}`;
    const signatureId = hashSignature(signature);
    let group = groups.get(signatureId);
    if (!group) {
      group = {
        signatureId,
        signature,
        latestTaskId: event.taskId,
        latestCreatedAt: event.createdAt,
        taskIds: new Set<string>(),
      };
      groups.set(signatureId, group);
    }
    group.taskIds.add(event.taskId);
    if (event.createdAt.localeCompare(group.latestCreatedAt) > 0) {
      group.latestTaskId = event.taskId;
      group.latestCreatedAt = event.createdAt;
    }
  }

  const startsAt = new Date(windowStartMs).toISOString();
  const endsAt = new Date(options.nowMs).toISOString();
  const windowHours = options.windowMs / (60 * 60_000);
  return [...groups.values()]
    .filter((group) => group.taskIds.size >= options.thresholdCount)
    .filter((group) => !alreadyDetected.has(group.signatureId))
    .map((group) => ({
      signatureId: group.signatureId,
      signature: group.signature,
      count: group.taskIds.size,
      matchingTaskIds: [...group.taskIds].sort(),
      latestTaskId: group.latestTaskId,
      window: { hours: windowHours, startsAt, endsAt },
    }));
}

export async function runThrashDetectorTick(options: ThrashDetectorWorkerOptions): Promise<void> {
  if (options.enabled === false) {
    options.logger.debug?.(`[worker:${THRASH_DETECTOR_WORKER_KIND}] disabled by config`, {
      module: THRASH_DETECTOR_WORKER_KIND,
    });
    return;
  }

  const thresholdCount = options.thresholdCount ?? DEFAULT_THRASH_DETECTOR_THRESHOLD_COUNT;
  const windowMs = options.windowMs ?? DEFAULT_THRASH_DETECTOR_WINDOW_MS;
  const nowMs = options.now?.() ?? Date.now();
  if (!options.store.listTaskEvents || !options.store.getTaskOutput || !options.store.logEvent) {
    throw new Error('thrash-detector requires listTaskEvents, getTaskOutput, and logEvent persistence methods');
  }
  const events = options.store.listTaskEvents({
    eventTypes: [THRASH_SOURCE_EVENT_TYPE],
    sortBy: 'desc',
  });
  const existingDetections = options.store.listTaskEvents({
    eventTypes: [THRASH_DETECTED_EVENT_TYPE],
    sortBy: 'desc',
  });
  const detections = planThrashDetections({
    events,
    existingDetections,
    getTaskOutput: (taskId) => options.store.getTaskOutput!(taskId),
    classifyAutoFixRecoveryPhase: options.classifyAutoFixRecoveryPhase,
    thresholdCount,
    windowMs,
    nowMs,
  });

  for (const detection of detections) {
    const taskId = detection.latestTaskId;
    options.store.logEvent(taskId, THRASH_DETECTED_EVENT_TYPE, {
      workerId: THRASH_DETECTOR_WORKER_KIND,
      kind: THRASH_DETECTOR_WORKER_KIND,
      signatureId: detection.signatureId,
      signature: detection.signature,
      matchingTaskIds: detection.matchingTaskIds,
      count: detection.count,
      window: detection.window,
    });
    options.logger.warn(`[worker:${THRASH_DETECTOR_WORKER_KIND}] detected recurring auto-fix failure signature`, {
      module: THRASH_DETECTOR_WORKER_KIND,
      signatureId: detection.signatureId,
      count: detection.count,
      matchingTaskIds: detection.matchingTaskIds,
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
    tickOnStart: config.tickOnStart ?? true,
  });
}

export function registerThrashDetectorWorker(
  registry: WorkerRegistry<WorkerRuntimeDependencies>,
): WorkerRegistry<WorkerRuntimeDependencies> {
  registry.register({
    kind: THRASH_DETECTOR_WORKER_KIND,
    note: 'Aggregates recurring debug.auto-fix events by failure signature and emits thrash.detected audit events.',
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

function parseEventPayload(payload: unknown): Record<string, unknown> {
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

function normalizePayloadFailureText(payload: Record<string, unknown>): string {
  const candidates = [payload.reason, payload.error, payload.message]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  return normalizeThrashFailureText(candidates.join('\n'));
}

function hashSignature(signature: string): string {
  return createHash('sha256').update(signature).digest('hex').slice(0, 16);
}
