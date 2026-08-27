import type { Logger } from '@invoker/contracts';

import type { WorkerRuntimeDependencies } from '../worker-runtime-dependencies.js';
import type { WorkerRegistry } from '../worker-registry.js';
import { createWorkerRuntime, type WorkerRuntime, type WorkerTick } from '../worker-runtime.js';

export const THRASH_DETECTOR_WORKER_KIND = 'thrash-detector';
export const DEBUG_AUTO_FIX_EVENT_TYPE = 'debug.auto-fix';
export const THRASH_DETECTED_EVENT_TYPE = 'thrash.detected';

export const DEFAULT_THRASH_DETECTOR_INTERVAL_MINUTES = 30;
export const DEFAULT_THRASH_DETECTOR_INTERVAL_MS = DEFAULT_THRASH_DETECTOR_INTERVAL_MINUTES * 60 * 1000;
export const DEFAULT_THRASH_DETECTOR_THRESHOLD_COUNT = 3;
export const DEFAULT_THRASH_DETECTOR_WINDOW_HOURS = 24;
/** Bound on how many recent events a single tick scans per event type. */
export const DEFAULT_THRASH_DETECTOR_SCAN_LIMIT = 2000;

/** One event read back from the task event log, decoupled from `@invoker/data-store`'s TaskEvent. */
export interface ThrashDetectorSourceEvent {
  taskId: string;
  createdAt: string;
  payload?: unknown;
}

export interface ThrashDetectorWorkerStore {
  /** Every event of the given type(s) across all tasks, most recent first. */
  getEventsByTypes(
    eventTypes: readonly string[],
    sortBy: 'asc' | 'desc',
    limit: number,
  ): ThrashDetectorSourceEvent[];
  /** Full terminal output for a task; combined with the classified phase to form the failure signature. */
  getTaskOutput(taskId: string): string;
  /** Append the `thrash.detected` audit event. The worker never calls anything else on the store. */
  logEvent(taskId: string, eventType: string, payload?: unknown): void;
}

/**
 * Classifies a `debug.auto-fix` event's phase into a coarse recovery-action
 * bucket. Production wiring injects `classifyAutoFixRecoveryPhase` from
 * `@invoker/app` (execution-engine cannot depend on app, which already
 * depends on execution-engine); omitting it groups by the raw phase string
 * instead so no event is silently dropped. This keeps a single classifier
 * implementation reused via injection rather than a second one duplicated
 * here.
 */
export type ThrashPhaseClassifier = (
  phase: string,
  details: Record<string, unknown>,
) => string | undefined;

export interface ThrashDetectorWorkerConfig {
  /** Poll cadence in milliseconds. Defaults to thirty minutes. */
  intervalMs?: number;
  /** Distinct-task count within `windowHours` that crosses the thrash threshold. Default: 3. */
  thresholdCount?: number;
  /** Recurrence window in hours. Default: 24. */
  windowHours?: number;
  /** Bound on events scanned per tick. Default: 2000. */
  scanLimit?: number;
  classifyPhase?: ThrashPhaseClassifier;
  tickOnStart?: boolean;
  /** Test seam: override the clock. */
  now?: () => number;
  onTick?: WorkerTick;
}

export interface ThrashDetectorWorkerOptions extends ThrashDetectorWorkerConfig {
  logger: Logger;
  store: ThrashDetectorWorkerStore;
}

export interface ThrashSignatureGroup {
  signatureId: string;
  taskIds: string[];
  /** Task id of the most recent matching event; used as the anchor for the audit log entry. */
  anchorTaskId: string;
  count: number;
  windowHours: number;
  windowStart: string;
  windowEnd: string;
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

/** Dependency-free FNV-1a hash, used only to keep signature ids compact. */
function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Normalize terminal output text into a stable signature component by
 * stripping volatile tokens (hashes, timestamps, digit runs) so the same
 * underlying failure hashes the same way across retries and tasks.
 */
export function normalizeFailureText(text: string): string {
  return text
    .slice(-2000)
    .replace(/\b[0-9a-f]{7,40}\b/gi, '<hash>')
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?/g, '<timestamp>')
    .replace(/\d+/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim();
}

export function buildThrashSignatureId(phaseBucket: string, normalizedOutput: string): string {
  return `${phaseBucket || 'unknown'}:${fnv1a(normalizedOutput)}`;
}

/**
 * Pure decision function: group `debug.auto-fix` events within `windowHours`
 * by failure signature (classified phase + normalized terminal-output text),
 * and return one group per signature whose distinct-task count has crossed
 * `thresholdCount`. No side effects — the caller decides whether/how to
 * persist the result, so this stays testable without a real store or clock.
 */
export function planThrashDetection(
  events: readonly ThrashDetectorSourceEvent[],
  getTaskOutput: (taskId: string) => string,
  opts: {
    now: number;
    windowHours: number;
    thresholdCount: number;
    classifyPhase?: ThrashPhaseClassifier;
  },
): ThrashSignatureGroup[] {
  const windowStartMs = opts.now - opts.windowHours * 60 * 60 * 1000;

  const bySignature = new Map<string, {
    taskIds: Set<string>;
    earliestAt: number;
    latestAt: number;
    latestTaskId: string;
  }>();

  for (const event of events) {
    const createdAtMs = new Date(event.createdAt).getTime();
    if (!Number.isFinite(createdAtMs) || createdAtMs < windowStartMs || createdAtMs > opts.now) continue;

    const payload = parsePayload(event.payload);
    const phase = typeof payload.phase === 'string' ? payload.phase : 'unknown';
    const phaseBucket = opts.classifyPhase?.(phase, payload) ?? phase;
    const normalizedOutput = normalizeFailureText(getTaskOutput(event.taskId));
    const signatureId = buildThrashSignatureId(phaseBucket, normalizedOutput);

    const existing = bySignature.get(signatureId);
    if (!existing) {
      bySignature.set(signatureId, {
        taskIds: new Set([event.taskId]),
        earliestAt: createdAtMs,
        latestAt: createdAtMs,
        latestTaskId: event.taskId,
      });
      continue;
    }
    existing.taskIds.add(event.taskId);
    if (createdAtMs < existing.earliestAt) existing.earliestAt = createdAtMs;
    if (createdAtMs > existing.latestAt) {
      existing.latestAt = createdAtMs;
      existing.latestTaskId = event.taskId;
    }
  }

  const results: ThrashSignatureGroup[] = [];
  for (const [signatureId, group] of bySignature) {
    if (group.taskIds.size < opts.thresholdCount) continue;
    results.push({
      signatureId,
      taskIds: [...group.taskIds].sort(),
      anchorTaskId: group.latestTaskId,
      count: group.taskIds.size,
      windowHours: opts.windowHours,
      windowStart: new Date(group.earliestAt).toISOString(),
      windowEnd: new Date(group.latestAt).toISOString(),
    });
  }
  return results;
}

/** True when an already-logged `thrash.detected` event covers this exact (or a larger) task set for this signature. */
function alreadyRecorded(
  existingThrashEvents: readonly ThrashDetectorSourceEvent[],
  group: ThrashSignatureGroup,
): boolean {
  for (const event of existingThrashEvents) {
    const payload = parsePayload(event.payload);
    if (payload.signatureId !== group.signatureId) continue;
    const recordedTaskIds = Array.isArray(payload.taskIds) ? payload.taskIds as unknown[] : [];
    if (group.taskIds.every((taskId) => recordedTaskIds.includes(taskId))) return true;
  }
  return false;
}

export function createThrashDetectorWorker(options: ThrashDetectorWorkerOptions): WorkerRuntime {
  const thresholdCount = options.thresholdCount ?? DEFAULT_THRASH_DETECTOR_THRESHOLD_COUNT;
  const windowHours = options.windowHours ?? DEFAULT_THRASH_DETECTOR_WINDOW_HOURS;
  const scanLimit = options.scanLimit ?? DEFAULT_THRASH_DETECTOR_SCAN_LIMIT;
  const now = options.now ?? (() => Date.now());

  return createWorkerRuntime({
    kind: THRASH_DETECTOR_WORKER_KIND,
    logger: options.logger,
    intervalMs: options.intervalMs ?? DEFAULT_THRASH_DETECTOR_INTERVAL_MS,
    tickOnStart: options.tickOnStart ?? true,
    onTick: async (ctx) => {
      ctx.signal?.throwIfAborted();
      await options.onTick?.(ctx);
      ctx.signal?.throwIfAborted();

      const events = options.store.getEventsByTypes([DEBUG_AUTO_FIX_EVENT_TYPE], 'desc', scanLimit);
      const groups = planThrashDetection(events, (taskId) => options.store.getTaskOutput(taskId), {
        now: now(),
        windowHours,
        thresholdCount,
        classifyPhase: options.classifyPhase,
      });
      if (groups.length === 0) return;

      const existingThrashEvents = options.store.getEventsByTypes([THRASH_DETECTED_EVENT_TYPE], 'desc', scanLimit);

      for (const group of groups) {
        if (ctx.signal?.aborted) return;
        if (alreadyRecorded(existingThrashEvents, group)) continue;

        options.store.logEvent(group.anchorTaskId, THRASH_DETECTED_EVENT_TYPE, {
          worker: THRASH_DETECTOR_WORKER_KIND,
          signatureId: group.signatureId,
          taskIds: group.taskIds,
          count: group.count,
          windowHours: group.windowHours,
          windowStart: group.windowStart,
          windowEnd: group.windowEnd,
        });
        options.logger.warn(
          `[${THRASH_DETECTOR_WORKER_KIND}] signature ${group.signatureId} crossed threshold: `
          + `${group.count} tasks in ${group.windowHours}h`,
          {
            module: THRASH_DETECTOR_WORKER_KIND,
            signatureId: group.signatureId,
            taskIds: group.taskIds,
          },
        );
      }
    },
  });
}

/** Register the built-in thrash-detector worker. */
export function registerThrashDetectorWorker(
  registry: WorkerRegistry<WorkerRuntimeDependencies>,
): WorkerRegistry<WorkerRuntimeDependencies> {
  registry.register({
    kind: THRASH_DETECTOR_WORKER_KIND,
    note: 'Aggregates recurring debug.auto-fix events by failure signature and logs one thrash.detected audit event per signature past threshold.',
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
