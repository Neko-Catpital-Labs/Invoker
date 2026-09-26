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
export const DEFAULT_THRASH_DETECTOR_WINDOW_MS = DEFAULT_THRASH_DETECTOR_WINDOW_HOURS * 60 * 60 * 1000;

const AUTO_FIX_EVENT_TYPE = 'debug.auto-fix';
const EVENT_SCAN_LIMIT = 10_000;
const FAILURE_TEXT_TAIL_CHARS = 4_000;

export type ThrashDetectorClassifier = (
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
  listWorkflows?(): ReadonlyArray<{ id: string }>;
  loadTasks?(workflowId: string): TaskState[];
  loadTask?(taskId: string): TaskState | undefined;
  getEvents?(taskId: string, sortBy?: 'asc' | 'desc', limit?: number, beforeId?: number): TaskEvent[];
  getTaskOutput?(taskId: string): string;
  logEvent?(taskId: string, eventType: string, payload?: unknown): void;
}

export interface ThrashDetectorWorkerConfig {
  enabled?: boolean;
  intervalMs?: number;
  thresholdCount?: number;
  windowMs?: number;
  tickOnStart?: boolean;
  classifyAutoFixRecoveryPhase?: ThrashDetectorClassifier;
  store?: ThrashDetectorWorkerStore;
  onTick?: WorkerTick;
  now?: () => number;
}

export interface ThrashDetectorWorkerOptions {
  logger: Logger;
  enabled?: boolean;
  intervalMs?: number;
  thresholdCount?: number;
  windowMs?: number;
  tickOnStart?: boolean;
  classifyAutoFixRecoveryPhase?: ThrashDetectorClassifier;
  store: ThrashDetectorWorkerStore;
  onTick?: WorkerTick;
  now?: () => number;
}

interface ThrashSignatureGroup {
  signatureId: string;
  signature: string;
  events: TaskEvent[];
  taskIds: Set<string>;
}

export async function runThrashDetectorTick(options: ThrashDetectorWorkerOptions): Promise<void> {
  if (options.enabled !== true) {
    options.logger.debug('[thrash-detector] disabled by config; no scan run', {
      module: THRASH_DETECTOR_WORKER_KIND,
    });
    return;
  }

  const store = options.store;
  if (!store.logEvent) {
    options.logger.warn('[thrash-detector] store has no logEvent; cannot record detections', {
      module: THRASH_DETECTOR_WORKER_KIND,
    });
    return;
  }

  const now = options.now?.() ?? Date.now();
  const thresholdCount = options.thresholdCount ?? DEFAULT_THRASH_DETECTOR_THRESHOLD_COUNT;
  const windowMs = options.windowMs ?? DEFAULT_THRASH_DETECTOR_WINDOW_MS;
  const windowStartedAt = new Date(now - windowMs).toISOString();
  const windowEndedAt = new Date(now).toISOString();
  const existingSignatureIds = collectExistingThrashSignatureIds(store);
  const groups = groupAutoFixEventsBySignature(
    listAutoFixEventsWithinWindow(store, now - windowMs),
    options,
  );

  for (const group of groups.values()) {
    if (group.events.length < thresholdCount) continue;
    if (existingSignatureIds.has(group.signatureId)) continue;

    const matchingTaskIds = [...group.taskIds].sort();
    store.logEvent(matchingTaskIds[0] ?? group.events[0]!.taskId, THRASH_DETECTED_EVENT_TYPE, {
      worker: THRASH_DETECTOR_WORKER_KIND,
      signatureId: group.signatureId,
      signature: group.signature,
      matchingTaskIds,
      count: group.events.length,
      thresholdCount,
      window: {
        hours: windowMs / 3_600_000,
        startedAt: windowStartedAt,
        endedAt: windowEndedAt,
      },
    });
    existingSignatureIds.add(group.signatureId);
    options.logger.info('[thrash-detector] recurring auto-fix signature detected', {
      module: THRASH_DETECTOR_WORKER_KIND,
      signatureId: group.signatureId,
      count: group.events.length,
      taskIds: matchingTaskIds,
    });
  }
}

function listAutoFixEventsWithinWindow(store: ThrashDetectorWorkerStore, cutoffMs: number): TaskEvent[] {
  const events = store.listTaskEvents
    ? store.listTaskEvents({ eventTypes: [AUTO_FIX_EVENT_TYPE], sortBy: 'desc', limit: EVENT_SCAN_LIMIT })
    : listAutoFixEventsByTaskScan(store);

  return events.filter((event) => Date.parse(event.createdAt) >= cutoffMs);
}

function listAutoFixEventsByTaskScan(store: ThrashDetectorWorkerStore): TaskEvent[] {
  const events: TaskEvent[] = [];
  for (const workflow of store.listWorkflows?.() ?? []) {
    for (const task of store.loadTasks?.(workflow.id) ?? []) {
      for (const event of store.getEvents?.(task.id, 'desc', 200) ?? []) {
        if (event.eventType === AUTO_FIX_EVENT_TYPE) events.push(event);
      }
    }
  }
  return events.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id);
}

function collectExistingThrashSignatureIds(store: ThrashDetectorWorkerStore): Set<string> {
  const events = store.listTaskEvents
    ? store.listTaskEvents({ eventTypes: [THRASH_DETECTED_EVENT_TYPE], sortBy: 'desc', limit: EVENT_SCAN_LIMIT })
    : listThrashDetectedEventsByTaskScan(store);
  const signatureIds = new Set<string>();
  for (const event of events) {
    const payload = parsePayload(event.payload);
    if (typeof payload.signatureId === 'string') signatureIds.add(payload.signatureId);
  }
  return signatureIds;
}

function listThrashDetectedEventsByTaskScan(store: ThrashDetectorWorkerStore): TaskEvent[] {
  const events: TaskEvent[] = [];
  for (const workflow of store.listWorkflows?.() ?? []) {
    for (const task of store.loadTasks?.(workflow.id) ?? []) {
      for (const event of store.getEvents?.(task.id, 'desc', 200) ?? []) {
        if (event.eventType === THRASH_DETECTED_EVENT_TYPE) events.push(event);
      }
    }
  }
  return events;
}

function groupAutoFixEventsBySignature(
  events: TaskEvent[],
  options: ThrashDetectorWorkerOptions,
): Map<string, ThrashSignatureGroup> {
  const groups = new Map<string, ThrashSignatureGroup>();
  for (const event of events) {
    const signature = buildFailureSignature(event, options);
    const signatureId = signatureIdFor(signature);
    const group = groups.get(signatureId) ?? {
      signatureId,
      signature,
      events: [],
      taskIds: new Set<string>(),
    };
    group.events.push(event);
    group.taskIds.add(event.taskId);
    groups.set(signatureId, group);
  }
  return groups;
}

function buildFailureSignature(event: TaskEvent, options: ThrashDetectorWorkerOptions): string {
  const payload = parsePayload(event.payload);
  const phase = typeof payload.phase === 'string' ? payload.phase : 'unknown';
  const action = options.classifyAutoFixRecoveryPhase?.(phase, payload) ?? 'unknown';
  const task = options.store.loadTask?.(event.taskId);
  const output = safeGetTaskOutput(options.store, event.taskId);
  const text = output
    || task?.execution?.error
    || stringPayloadField(payload, 'failureError')
    || stringPayloadField(payload, 'error')
    || stringPayloadField(payload, 'reason')
    || phase;
  return `action=${action}; text=${normalizeFailureText(text)}`;
}

function safeGetTaskOutput(store: ThrashDetectorWorkerStore, taskId: string): string {
  try {
    return tail(store.getTaskOutput?.(taskId) ?? '', FAILURE_TEXT_TAIL_CHARS);
  } catch {
    return '';
  }
}

function normalizeFailureText(text: string): string {
  return tail(text, FAILURE_TEXT_TAIL_CHARS)
    .toLowerCase()
    .replace(/\/[\w./-]+/g, '<path>')
    .replace(/\b[0-9a-f]{7,40}\b/g, '<sha>')
    .replace(/\b\d+\b/g, '<num>')
    .replace(/\s+/g, ' ')
    .trim();
}

function tail(text: string, maxChars: number): string {
  return text.length > maxChars ? text.slice(-maxChars) : text;
}

function signatureIdFor(signature: string): string {
  return createHash('sha256').update(signature).digest('hex').slice(0, 16);
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

function stringPayloadField(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

export function createThrashDetectorWorker(config: ThrashDetectorWorkerConfig & { logger: Logger }): WorkerRuntime {
  const options: ThrashDetectorWorkerOptions = {
    logger: config.logger,
    enabled: config.enabled,
    intervalMs: config.intervalMs,
    thresholdCount: config.thresholdCount,
    windowMs: config.windowMs,
    store: config.store ?? {},
    classifyAutoFixRecoveryPhase: config.classifyAutoFixRecoveryPhase,
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
    note: 'Aggregates recurring debug.auto-fix events by failure signature and records thrash.detected audit entries.',
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
