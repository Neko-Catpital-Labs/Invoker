import { createHash } from 'node:crypto';

import type { Logger } from '@invoker/contracts';
import type { TaskEvent } from '@invoker/data-store';
import type { TaskState } from '@invoker/workflow-core';

import { classifyAutoFixRecoveryPhase } from '../auto-fix-recovery.js';
import type { WorkerRuntimeDependencies } from '../worker-runtime-dependencies.js';
import type { WorkerRegistry } from '../worker-registry.js';
import { createWorkerRuntime, type WorkerRuntime, type WorkerTick } from '../worker-runtime.js';

export const THRASH_DETECTOR_WORKER_KIND = 'thrash-detector';
export const THRASH_DETECTED_EVENT_TYPE = 'thrash.detected';
export const DEFAULT_THRASH_DETECTOR_INTERVAL_MINUTES = 15;
export const DEFAULT_THRASH_DETECTOR_INTERVAL_MS = DEFAULT_THRASH_DETECTOR_INTERVAL_MINUTES * 60 * 1000;
export const DEFAULT_THRASH_DETECTOR_THRESHOLD_COUNT = 3;
export const DEFAULT_THRASH_DETECTOR_WINDOW_HOURS = 24;
const DEBUG_AUTO_FIX_EVENT_TYPE = 'debug.auto-fix';
const FALLBACK_EVENT_SCAN_LIMIT = 5_000;

export interface ThrashDetectorWorkerConfig {
  enabled?: boolean;
  intervalMs?: number;
  thresholdCount?: number;
  windowHours?: number;
  tickOnStart?: boolean;
  store?: ThrashDetectorWorkerStore;
  now?: () => Date;
  onTick?: WorkerTick;
}

export interface ThrashDetectorWorkerStore {
  listWorkflows(): ReadonlyArray<{ id: string }>;
  loadTasks(workflowId: string): TaskState[];
  loadTask?(taskId: string): TaskState | undefined;
  getTaskOutput?(taskId: string): string;
  getEventsByTypes?(eventTypes: readonly string[], sortBy: 'asc' | 'desc', limit: number): TaskEvent[];
  listTaskEvents?(filters?: {
    eventTypes?: readonly string[];
    sortBy?: 'asc' | 'desc';
    limit?: number;
  }): TaskEvent[];
  logEvent?(taskId: string, eventType: string, payload?: unknown): void;
}

export interface ThrashDetectorWorkerOptions {
  logger: Logger;
  enabled?: boolean;
  thresholdCount: number;
  windowHours: number;
  store: ThrashDetectorWorkerStore;
  now?: () => Date;
}

interface ParsedAutoFixEvent {
  event: TaskEvent;
  payload: Record<string, unknown>;
  task?: TaskState;
  signatureId: string;
  signatureBasis: {
    action: string;
    phase: string;
    terminalOutput: string;
  };
}

interface ThrashSignatureGroup {
  signatureId: string;
  signatureBasis: ParsedAutoFixEvent['signatureBasis'];
  events: ParsedAutoFixEvent[];
  matchingTaskIds: string[];
}

export interface ThrashDetection {
  signatureId: string;
  signatureBasis: ParsedAutoFixEvent['signatureBasis'];
  matchingTaskIds: string[];
  count: number;
  window: {
    hours: number;
    startedAt: string;
    endedAt: string;
  };
  thresholdCount: number;
  eventIds: number[];
}

function parseEventPayload(payload: string | undefined): Record<string, unknown> {
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

function taskWorkflowId(task: TaskState | undefined, taskId: string): string | undefined {
  if (task?.config.workflowId) return task.config.workflowId;
  const slashIndex = taskId.indexOf('/');
  return slashIndex > 0 ? taskId.slice(0, slashIndex) : undefined;
}

function loadTask(store: ThrashDetectorWorkerStore, taskId: string): TaskState | undefined {
  const direct = store.loadTask?.(taskId);
  if (direct) return direct;
  const workflowId = taskWorkflowId(undefined, taskId);
  if (workflowId) {
    return store.loadTasks(workflowId).find((task) => task.id === taskId);
  }
  for (const workflow of store.listWorkflows()) {
    const found = store.loadTasks(workflow.id).find((task) => task.id === taskId);
    if (found) return found;
  }
  return undefined;
}

function normalizeTerminalOutput(text: string): string {
  const normalized = text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-40)
    .join('\n')
    .replace(/\b\/(?:[\w.-]+\/){2,}[\w.-]+\b/g, '<path>')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  return normalized.slice(0, 2_000);
}

function eventTerminalText(
  store: ThrashDetectorWorkerStore,
  taskId: string,
  task: TaskState | undefined,
  payload: Record<string, unknown>,
): string {
  const output = store.getTaskOutput?.(taskId);
  if (output && output.trim().length > 0) return output;
  if (task?.execution.error) return task.execution.error;
  const reason = payload.reason;
  return typeof reason === 'string' ? reason : '';
}

function signatureForEvent(
  store: ThrashDetectorWorkerStore,
  event: TaskEvent,
): ParsedAutoFixEvent {
  const payload = parseEventPayload(event.payload);
  const phase = typeof payload.phase === 'string' ? payload.phase : 'unknown';
  const action = classifyAutoFixRecoveryPhase(phase, payload) ?? 'unclassified';
  const task = loadTask(store, event.taskId);
  const terminalOutput = normalizeTerminalOutput(eventTerminalText(store, event.taskId, task, payload));
  const signatureBasis = { action, phase, terminalOutput };
  const signatureId = createHash('sha256')
    .update(JSON.stringify(signatureBasis))
    .digest('hex')
    .slice(0, 16);
  return { event, payload, task, signatureId, signatureBasis };
}

function listEvents(store: ThrashDetectorWorkerStore, eventType: string): TaskEvent[] {
  if (store.listTaskEvents) {
    return store.listTaskEvents({ eventTypes: [eventType], sortBy: 'desc' });
  }
  return store.getEventsByTypes?.([eventType], 'desc', FALLBACK_EVENT_SCAN_LIMIT) ?? [];
}

function detectedSignatureIds(store: ThrashDetectorWorkerStore): Set<string> {
  const signatures = new Set<string>();
  for (const event of listEvents(store, THRASH_DETECTED_EVENT_TYPE)) {
    const payload = parseEventPayload(event.payload);
    if (typeof payload.signatureId === 'string') signatures.add(payload.signatureId);
  }
  return signatures;
}

export function collectThrashDetections(options: ThrashDetectorWorkerOptions): ThrashDetection[] {
  const now = options.now?.() ?? new Date();
  const windowMs = options.windowHours * 60 * 60 * 1000;
  const windowStartMs = now.getTime() - windowMs;
  const alreadyDetected = detectedSignatureIds(options.store);
  const groups = new Map<string, ThrashSignatureGroup>();

  for (const event of listEvents(options.store, DEBUG_AUTO_FIX_EVENT_TYPE)) {
    const eventTime = Date.parse(event.createdAt);
    if (!Number.isFinite(eventTime) || eventTime < windowStartMs || eventTime > now.getTime()) continue;
    const parsed = signatureForEvent(options.store, event);
    const group = groups.get(parsed.signatureId) ?? {
      signatureId: parsed.signatureId,
      signatureBasis: parsed.signatureBasis,
      events: [],
      matchingTaskIds: [],
    };
    group.events.push(parsed);
    if (!group.matchingTaskIds.includes(event.taskId)) {
      group.matchingTaskIds.push(event.taskId);
    }
    groups.set(parsed.signatureId, group);
  }

  const detections: ThrashDetection[] = [];
  for (const group of groups.values()) {
    if (alreadyDetected.has(group.signatureId)) continue;
    if (group.matchingTaskIds.length < options.thresholdCount) continue;
    detections.push({
      signatureId: group.signatureId,
      signatureBasis: group.signatureBasis,
      matchingTaskIds: group.matchingTaskIds.sort(),
      count: group.matchingTaskIds.length,
      thresholdCount: options.thresholdCount,
      window: {
        hours: options.windowHours,
        startedAt: new Date(windowStartMs).toISOString(),
        endedAt: now.toISOString(),
      },
      eventIds: group.events.map((entry) => entry.event.id).sort((a, b) => a - b),
    });
  }

  return detections.sort((a, b) => a.signatureId.localeCompare(b.signatureId));
}

export async function runThrashDetectorTick(options: ThrashDetectorWorkerOptions): Promise<void> {
  if (options.enabled === false) {
    options.logger.debug?.(`[${THRASH_DETECTOR_WORKER_KIND}] disabled`, { module: THRASH_DETECTOR_WORKER_KIND });
    return;
  }

  const detections = collectThrashDetections(options);
  for (const detection of detections) {
    const auditTaskId = detection.matchingTaskIds[0];
    if (!auditTaskId) continue;
    options.store.logEvent?.(auditTaskId, THRASH_DETECTED_EVENT_TYPE, {
      workerId: THRASH_DETECTOR_WORKER_KIND,
      kind: THRASH_DETECTOR_WORKER_KIND,
      signatureId: detection.signatureId,
      signatureBasis: detection.signatureBasis,
      matchingTaskIds: detection.matchingTaskIds,
      count: detection.count,
      thresholdCount: detection.thresholdCount,
      window: detection.window,
      eventIds: detection.eventIds,
    });
    options.logger.warn(`[${THRASH_DETECTOR_WORKER_KIND}] detected recurring auto-fix thrash`, {
      module: THRASH_DETECTOR_WORKER_KIND,
      signatureId: detection.signatureId,
      count: detection.count,
      matchingTaskIds: detection.matchingTaskIds,
    });
  }
}

export function createThrashDetectorWorker(config: ThrashDetectorWorkerConfig & { logger: Logger }): WorkerRuntime {
  const store = config.store;
  if (!store) {
    throw new Error('thrash-detector worker requires a store');
  }
  const options: ThrashDetectorWorkerOptions = {
    logger: config.logger,
    enabled: config.enabled,
    thresholdCount: config.thresholdCount ?? DEFAULT_THRASH_DETECTOR_THRESHOLD_COUNT,
    windowHours: config.windowHours ?? DEFAULT_THRASH_DETECTOR_WINDOW_HOURS,
    store,
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
    note: 'Aggregates recurring debug.auto-fix failure signatures and records thrash.detected audit events.',
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
