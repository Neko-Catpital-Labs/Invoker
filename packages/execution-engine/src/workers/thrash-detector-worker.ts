import { createHash } from 'node:crypto';

import type { Logger } from '@invoker/contracts';
import type { TaskEvent } from '@invoker/data-store';
import type { TaskState } from '@invoker/workflow-core';

import type { WorkerRuntimeDependencies } from '../worker-runtime-dependencies.js';
import type { WorkerRegistry } from '../worker-registry.js';
import { createWorkerRuntime, type WorkerRuntime, type WorkerTick } from '../worker-runtime.js';

export const THRASH_DETECTOR_WORKER_KIND = 'thrash-detector';
export const DEFAULT_THRASH_DETECTOR_INTERVAL_MINUTES = 15;
export const DEFAULT_THRASH_DETECTOR_INTERVAL_MS = DEFAULT_THRASH_DETECTOR_INTERVAL_MINUTES * 60 * 1000;
export const DEFAULT_THRASH_DETECTOR_THRESHOLD_COUNT = 3;
export const DEFAULT_THRASH_DETECTOR_WINDOW_HOURS = 24;
export const THRASH_DETECTED_EVENT_TYPE = 'thrash.detected';

export type AutoFixRecoveryPhaseClassifier = (
  phase: string,
  details?: Record<string, unknown>,
) => string | undefined;

export interface ThrashDetectorWorkerStore {
  listWorkflows(): ReadonlyArray<{ id: string }>;
  loadTasks(workflowId: string): TaskState[];
  loadTask?(taskId: string): TaskState | undefined;
  listTaskEvents?(filters?: {
    taskId?: string;
    eventTypes?: readonly string[];
    sortBy?: 'asc' | 'desc';
    limit?: number;
  }): TaskEvent[];
  getEvents?(taskId: string, sortBy?: 'asc' | 'desc', limit?: number, beforeId?: number): TaskEvent[];
  getTaskOutput?(taskId: string): string;
  logEvent?(taskId: string, eventType: string, payload?: unknown): void;
}

export interface ThrashDetectorWorkerConfig {
  enabled?: boolean;
  intervalMs?: number;
  thresholdCount?: number;
  windowHours?: number;
  tickOnStart?: boolean;
  store?: ThrashDetectorWorkerStore;
  classifyAutoFixRecoveryPhase?: AutoFixRecoveryPhaseClassifier;
  now?: () => Date;
  onTick?: WorkerTick;
}

export interface ThrashDetectorWorkerOptions {
  logger: Logger;
  store: ThrashDetectorWorkerStore;
  intervalMs?: number;
  thresholdCount: number;
  windowHours: number;
  tickOnStart?: boolean;
  classifyAutoFixRecoveryPhase: AutoFixRecoveryPhaseClassifier;
  now?: () => Date;
  onTick?: WorkerTick;
}

interface SignatureBucket {
  signatureId: string;
  phase: string;
  recoveryAction: string;
  normalizedOutput: string;
  taskIds: Set<string>;
  eventIds: number[];
  firstSeenAt: string;
  lastSeenAt: string;
}

export async function runThrashDetectorTick(options: ThrashDetectorWorkerOptions): Promise<void> {
  const store = options.store;
  if (!store.logEvent) {
    options.logger.warn(`[${THRASH_DETECTOR_WORKER_KIND}] store has no logEvent; skipping`);
    return;
  }

  const now = options.now?.() ?? new Date();
  const thresholdCount = Math.max(1, Math.floor(options.thresholdCount));
  const windowHours = Math.max(1, options.windowHours);
  const windowStart = new Date(now.getTime() - windowHours * 60 * 60 * 1000);
  const windowStartIso = windowStart.toISOString();
  const windowEndIso = now.toISOString();
  const events = listAutoFixEvents(store, windowStart);
  const tasksById = loadTasksById(store);
  const auditedSignatureIds = listAuditedSignatureIds(store, windowStart);
  const buckets = new Map<string, SignatureBucket>();

  for (const event of events) {
    const payload = parseEventPayload(event.payload);
    const phase = typeof payload.phase === 'string' ? payload.phase : 'unknown';
    const recoveryAction = options.classifyAutoFixRecoveryPhase(phase, payload) ?? 'unclassified';
    const task = store.loadTask?.(event.taskId) ?? tasksById.get(event.taskId);
    const terminalOutput = readTerminalOutput(store, event.taskId, task, payload);
    const normalizedOutput = normalizeFailureText(terminalOutput);
    if (!normalizedOutput) continue;

    const signatureId = buildSignatureId({ recoveryAction, phase, normalizedOutput });
    const bucket = buckets.get(signatureId) ?? {
      signatureId,
      phase,
      recoveryAction,
      normalizedOutput,
      taskIds: new Set<string>(),
      eventIds: [],
      firstSeenAt: event.createdAt,
      lastSeenAt: event.createdAt,
    };
    bucket.taskIds.add(event.taskId);
    bucket.eventIds.push(event.id);
    if (event.createdAt < bucket.firstSeenAt) bucket.firstSeenAt = event.createdAt;
    if (event.createdAt > bucket.lastSeenAt) bucket.lastSeenAt = event.createdAt;
    buckets.set(signatureId, bucket);
  }

  for (const bucket of [...buckets.values()].sort((a, b) => a.signatureId.localeCompare(b.signatureId))) {
    if (bucket.taskIds.size < thresholdCount) continue;
    if (auditedSignatureIds.has(bucket.signatureId)) continue;

    const matchingTaskIds = [...bucket.taskIds].sort();
    const eventTaskId = matchingTaskIds[0];
    if (!eventTaskId) continue;
    store.logEvent(eventTaskId, THRASH_DETECTED_EVENT_TYPE, {
      worker: THRASH_DETECTOR_WORKER_KIND,
      signatureId: bucket.signatureId,
      recoveryAction: bucket.recoveryAction,
      phase: bucket.phase,
      matchingTaskIds,
      count: matchingTaskIds.length,
      window: {
        hours: windowHours,
        start: windowStartIso,
        end: windowEndIso,
      },
      eventIds: bucket.eventIds.sort((a, b) => a - b),
      firstSeenAt: bucket.firstSeenAt,
      lastSeenAt: bucket.lastSeenAt,
    });
    auditedSignatureIds.add(bucket.signatureId);
    options.logger.warn(`[${THRASH_DETECTOR_WORKER_KIND}] detected recurring auto-fix signature`, {
      module: THRASH_DETECTOR_WORKER_KIND,
      signatureId: bucket.signatureId,
      count: matchingTaskIds.length,
      matchingTaskIds,
    });
  }
}

export function createThrashDetectorWorker(config: ThrashDetectorWorkerConfig & { logger: Logger }): WorkerRuntime {
  if (!config.store) {
    throw new Error('thrash-detector worker requires a store');
  }
  if (!config.classifyAutoFixRecoveryPhase) {
    throw new Error('thrash-detector worker requires classifyAutoFixRecoveryPhase');
  }
  const options: ThrashDetectorWorkerOptions = {
    logger: config.logger,
    store: config.store,
    intervalMs: config.intervalMs,
    thresholdCount: config.thresholdCount ?? DEFAULT_THRASH_DETECTOR_THRESHOLD_COUNT,
    windowHours: config.windowHours ?? DEFAULT_THRASH_DETECTOR_WINDOW_HOURS,
    tickOnStart: config.tickOnStart,
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
        store: deps.thrashDetector?.store ?? deps.store,
        classifyAutoFixRecoveryPhase: deps.thrashDetector?.classifyAutoFixRecoveryPhase,
        ...deps.thrashDetector,
      }),
  });
  return registry;
}

function listAutoFixEvents(store: ThrashDetectorWorkerStore, windowStart: Date): TaskEvent[] {
  const windowStartMs = windowStart.getTime();
  if (store.listTaskEvents) {
    return store.listTaskEvents({
      eventTypes: ['debug.auto-fix'],
      sortBy: 'desc',
      limit: 2_000,
    }).filter((event) => Date.parse(event.createdAt) >= windowStartMs);
  }

  const events: TaskEvent[] = [];
  for (const workflow of store.listWorkflows()) {
    for (const task of store.loadTasks(workflow.id)) {
      for (const event of store.getEvents?.(task.id, 'desc', 200) ?? []) {
        if (event.eventType !== 'debug.auto-fix') continue;
        if (Date.parse(event.createdAt) < windowStartMs) continue;
        events.push(event);
      }
    }
  }
  return events;
}

function listAuditedSignatureIds(store: ThrashDetectorWorkerStore, windowStart: Date): Set<string> {
  const signatureIds = new Set<string>();
  const events = store.listTaskEvents
    ? store.listTaskEvents({ eventTypes: [THRASH_DETECTED_EVENT_TYPE], sortBy: 'desc', limit: 2_000 })
    : listLegacyEventsOfType(store, THRASH_DETECTED_EVENT_TYPE);
  for (const event of events) {
    if (Date.parse(event.createdAt) < windowStart.getTime()) continue;
    const payload = parseEventPayload(event.payload);
    if (typeof payload.signatureId === 'string') signatureIds.add(payload.signatureId);
  }
  return signatureIds;
}

function listLegacyEventsOfType(store: ThrashDetectorWorkerStore, eventType: string): TaskEvent[] {
  const events: TaskEvent[] = [];
  for (const workflow of store.listWorkflows()) {
    for (const task of store.loadTasks(workflow.id)) {
      for (const event of store.getEvents?.(task.id, 'desc', 200) ?? []) {
        if (event.eventType === eventType) events.push(event);
      }
    }
  }
  return events;
}

function loadTasksById(store: ThrashDetectorWorkerStore): Map<string, TaskState> {
  const tasks = new Map<string, TaskState>();
  for (const workflow of store.listWorkflows()) {
    for (const task of store.loadTasks(workflow.id)) {
      tasks.set(task.id, task);
    }
  }
  return tasks;
}

function parseEventPayload(payload: unknown): Record<string, unknown> {
  if (typeof payload !== 'string') return isRecord(payload) ? payload : {};
  try {
    const parsed = JSON.parse(payload);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function readTerminalOutput(
  store: ThrashDetectorWorkerStore,
  taskId: string,
  task: TaskState | undefined,
  payload: Record<string, unknown>,
): string {
  const output = store.getTaskOutput?.(taskId);
  if (typeof output === 'string' && output.trim()) return output;
  for (const key of ['diagnostics', 'errorMessage', 'latestError', 'error']) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return task?.execution.error ?? '';
}

function normalizeFailureText(text: string): string {
  return text
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-30)
    .join('\n')
    .replace(/[a-f0-9]{40}/gi, '<sha>')
    .replace(/[a-f0-9]{7,12}/gi, '<sha-short>')
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g, '<timestamp>')
    .replace(/\b\d+\b/g, '<num>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1_000);
}

function buildSignatureId(input: {
  recoveryAction: string;
  phase: string;
  normalizedOutput: string;
}): string {
  return createHash('sha256')
    .update(JSON.stringify(input))
    .digest('hex')
    .slice(0, 16);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
