import { createHash } from 'node:crypto';

import type { Logger } from '@invoker/contracts';
import type { TaskEvent } from '@invoker/data-store';
import type { TaskState } from '@invoker/workflow-core';

import type { WorkerRuntimeDependencies } from '../worker-runtime-dependencies.js';
import type { WorkerRegistry } from '../worker-registry.js';
import { createWorkerRuntime, type WorkerRuntime, type WorkerTick } from '../worker-runtime.js';

export const THRASH_DETECTOR_WORKER_KIND = 'thrash-detector';
export const THRASH_DETECTED_EVENT_TYPE = 'thrash.detected';
export const DEFAULT_THRASH_DETECTOR_INTERVAL_MINUTES = 15;
export const DEFAULT_THRASH_DETECTOR_THRESHOLD_COUNT = 3;
export const DEFAULT_THRASH_DETECTOR_WINDOW_HOURS = 24;
export const DEFAULT_THRASH_DETECTOR_INTERVAL_MS = DEFAULT_THRASH_DETECTOR_INTERVAL_MINUTES * 60_000;

export type AutoFixRecoveryAction = 'wakeup' | 'scan' | 'submit' | 'skip';

export interface ThrashDetectorWorkerConfig {
  enabled?: boolean;
  intervalMs?: number;
  thresholdCount?: number;
  windowHours?: number;
  tickOnStart?: boolean;
  now?: () => Date;
  onTick?: WorkerTick;
}

export interface ThrashDetectorStore {
  getEventsByTypes?(eventTypes: readonly string[], sortBy: 'asc' | 'desc', limit: number): TaskEvent[];
  logEvent?(taskId: string, eventType: string, payload?: unknown): void;
  loadTask?(taskId: string): TaskState | undefined;
}

export interface ThrashDetectorWorkerOptions {
  logger: Logger;
  store: ThrashDetectorStore;
  enabled?: boolean;
  intervalMs?: number;
  thresholdCount?: number;
  windowHours?: number;
  tickOnStart?: boolean;
  now?: () => Date;
  onTick?: WorkerTick;
}

interface SignatureBucket {
  signatureId: string;
  signatureBasis: string;
  taskIds: Set<string>;
  events: TaskEvent[];
}

export function classifyAutoFixRecoveryPhase(
  phase: string,
  details: Record<string, unknown> = {},
): AutoFixRecoveryAction | undefined {
  if (phase === 'delta-failed') return 'wakeup';
  if (phase === 'poll-failed' || phase === 'schedule-enter') return 'scan';
  if (phase === 'schedule-enqueued' || phase === 'worker-autofix-submitted') return 'submit';
  if (phase === 'schedule-skip' || phase.endsWith('-skip')) return 'skip';
  if (details.reason && (phase.includes('skip') || phase.includes('error'))) return 'skip';
  return undefined;
}

function parsePayload(payload: string | undefined): Record<string, unknown> {
  if (!payload) return {};
  try {
    const parsed = JSON.parse(payload);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function normalizedText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[0-9a-f]{7,40}/gi, '<sha>')
    .replace(/\b\d+\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(-2_000);
}

function taskFailureText(task: TaskState | undefined): string {
  if (!task) return '';
  return [
    task.execution.error,
    task.execution.pendingFixError,
    task.execution.protocolErrorCode,
    task.execution.protocolErrorMessage,
    task.execution.failureClass,
  ].map(normalizedText).filter(Boolean).join('\n');
}

export function buildThrashSignatureId(signatureBasis: string): string {
  return createHash('sha256').update(signatureBasis).digest('hex').slice(0, 16);
}

function buildSignatureBasis(event: TaskEvent, task: TaskState | undefined): string | undefined {
  const payload = parsePayload(event.payload);
  const phase = typeof payload.phase === 'string' ? payload.phase : '';
  const recoveryAction = classifyAutoFixRecoveryPhase(phase, payload);
  if (!recoveryAction) return undefined;
  const failureText = normalizedText(payload.error)
    || normalizedText(payload.reason)
    || taskFailureText(task)
    || 'unknown-failure';
  return `${recoveryAction}:${phase}:${failureText}`;
}

function detectedSignatureIds(events: TaskEvent[]): Set<string> {
  const ids = new Set<string>();
  for (const event of events) {
    const payload = parsePayload(event.payload);
    const signatureId = typeof payload.signatureId === 'string' ? payload.signatureId : undefined;
    if (signatureId) ids.add(signatureId);
  }
  return ids;
}

export async function runThrashDetectorTick(options: ThrashDetectorWorkerOptions): Promise<void> {
  if (options.enabled === false) return;
  const thresholdCount = options.thresholdCount ?? DEFAULT_THRASH_DETECTOR_THRESHOLD_COUNT;
  const windowHours = options.windowHours ?? DEFAULT_THRASH_DETECTOR_WINDOW_HOURS;
  if (thresholdCount <= 0 || windowHours <= 0) return;

  const now = options.now?.() ?? new Date();
  const windowStart = new Date(now.getTime() - windowHours * 3_600_000);
  const recent = options.store.getEventsByTypes?.(['debug.auto-fix'], 'desc', 1_000) ?? [];
  const existing = detectedSignatureIds(
    options.store.getEventsByTypes?.([THRASH_DETECTED_EVENT_TYPE], 'desc', 1_000) ?? [],
  );

  const buckets = new Map<string, SignatureBucket>();
  for (const event of recent) {
    if (new Date(event.createdAt).getTime() < windowStart.getTime()) continue;
    const task = options.store.loadTask?.(event.taskId);
    const signatureBasis = buildSignatureBasis(event, task);
    if (!signatureBasis) continue;
    const signatureId = buildThrashSignatureId(signatureBasis);
    const bucket = buckets.get(signatureId) ?? {
      signatureId,
      signatureBasis,
      taskIds: new Set<string>(),
      events: [],
    };
    bucket.taskIds.add(event.taskId);
    bucket.events.push(event);
    buckets.set(signatureId, bucket);
  }

  for (const bucket of buckets.values()) {
    if (bucket.events.length < thresholdCount || existing.has(bucket.signatureId)) continue;
    const matchingTaskIds = [...bucket.taskIds].sort();
    options.store.logEvent?.(matchingTaskIds[0] ?? bucket.events[0]!.taskId, THRASH_DETECTED_EVENT_TYPE, {
      signatureId: bucket.signatureId,
      signatureBasis: bucket.signatureBasis,
      matchingTaskIds,
      count: bucket.events.length,
      window: {
        hours: windowHours,
        start: windowStart.toISOString(),
        end: now.toISOString(),
      },
    });
    existing.add(bucket.signatureId);
    options.logger.warn?.(`[${THRASH_DETECTOR_WORKER_KIND}] detected recurring auto-fix signature`, {
      module: THRASH_DETECTOR_WORKER_KIND,
      signatureId: bucket.signatureId,
      count: bucket.events.length,
      matchingTaskIds,
    });
  }
}

export function createThrashDetectorWorker(config: ThrashDetectorWorkerConfig & {
  logger: Logger;
  store: ThrashDetectorStore;
}): WorkerRuntime {
  const options: ThrashDetectorWorkerOptions = {
    logger: config.logger,
    store: config.store,
    enabled: config.enabled,
    intervalMs: config.intervalMs,
    thresholdCount: config.thresholdCount,
    windowHours: config.windowHours,
    tickOnStart: config.tickOnStart,
    now: config.now,
  };
  const onTick: WorkerTick = config.onTick ?? (async () => {
    await runThrashDetectorTick(options);
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
