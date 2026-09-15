import { createHash } from 'node:crypto';

import type { Logger } from '@invoker/contracts';
import type { TaskEvent } from '@invoker/data-store';

import { classifyAutoFixRecoveryPhase } from '../auto-fix-recovery-observability.js';
import type { WorkerRuntimeDependencies } from '../worker-runtime-dependencies.js';
import type { WorkerRegistry } from '../worker-registry.js';
import { createWorkerRuntime, type WorkerRuntime, type WorkerTick } from '../worker-runtime.js';

export const THRASH_DETECTOR_WORKER_KIND = 'thrash-detector';
export const THRASH_DETECTED_EVENT_TYPE = 'thrash.detected';
export const DEFAULT_THRASH_DETECTOR_INTERVAL_MINUTES = 15;
export const DEFAULT_THRASH_DETECTOR_THRESHOLD_COUNT = 3;
export const DEFAULT_THRASH_DETECTOR_WINDOW_HOURS = 24;
export const DEFAULT_THRASH_DETECTOR_INTERVAL_MS = DEFAULT_THRASH_DETECTOR_INTERVAL_MINUTES * 60_000;

export interface ThrashDetectorWorkerConfig {
  enabled?: boolean;
  intervalMs?: number;
  thresholdCount?: number;
  windowHours?: number;
  tickOnStart?: boolean;
  onTick?: WorkerTick;
}

export interface ThrashDetectorStore {
  listTaskEvents?(filters?: {
    taskId?: string;
    eventTypes?: readonly string[];
    sortBy?: 'asc' | 'desc';
    limit?: number;
  }): TaskEvent[];
  getEventsByTypes?(eventTypes: readonly string[], sortBy: 'asc' | 'desc', limit: number): TaskEvent[];
  listWorkflows?(): Array<{ id: string }>;
  loadTasks?(workflowId: string): Array<{ id: string; execution?: { error?: string } }>;
  loadTask?(taskId: string): { id: string; execution?: { error?: string } } | undefined;
  getEvents?(taskId: string): TaskEvent[];
  logEvent(taskId: string, eventType: string, payload?: unknown): void;
}

export interface ThrashDetectorWorkerOptions {
  logger: Logger;
  store: ThrashDetectorStore;
  enabled?: boolean;
  thresholdCount?: number;
  windowHours?: number;
  now?: Date;
}

interface FailureSignatureGroup {
  signatureId: string;
  basis: string;
  events: TaskEvent[];
  taskIds: Set<string>;
}

export function buildThrashFailureSignature(
  event: TaskEvent,
  taskText: string | undefined,
): { signatureId: string; basis: string } | undefined {
  const payload = parsePayload(event.payload);
  const phase = typeof payload.phase === 'string' ? payload.phase : '';
  if (!phase) return undefined;
  const action = classifyAutoFixRecoveryPhase(phase, payload);
  if (!action) return undefined;

  const text = normalizeFailureText(
    taskText
      ?? stringFromPayload(payload, 'terminalOutput')
      ?? stringFromPayload(payload, 'output')
      ?? stringFromPayload(payload, 'error')
      ?? stringFromPayload(payload, 'message')
      ?? stringFromPayload(payload, 'reason')
      ?? phase,
  );
  const basis = `${action}:${phase}:${text}`;
  const signatureId = createHash('sha256').update(basis).digest('hex').slice(0, 16);
  return { signatureId, basis };
}

export async function runThrashDetectorTick(options: ThrashDetectorWorkerOptions): Promise<void> {
  if (options.enabled === false) return;
  const thresholdCount = options.thresholdCount ?? DEFAULT_THRASH_DETECTOR_THRESHOLD_COUNT;
  const windowHours = options.windowHours ?? DEFAULT_THRASH_DETECTOR_WINDOW_HOURS;
  const now = options.now ?? new Date();
  const windowStart = new Date(now.getTime() - windowHours * 60 * 60_000);
  const autoFixEvents = listEvents(options.store, ['debug.auto-fix'], 5_000)
    .filter((event) => Date.parse(event.createdAt) >= windowStart.getTime());
  const existing = listEvents(options.store, [THRASH_DETECTED_EVENT_TYPE], 5_000);
  const existingSignatureIds = new Set(existing.map((event) => parsePayload(event.payload).signatureId)
    .filter((value): value is string => typeof value === 'string'));
  const groups = new Map<string, FailureSignatureGroup>();

  for (const event of autoFixEvents) {
    const taskText = options.store.loadTask?.(event.taskId)?.execution?.error;
    const signature = buildThrashFailureSignature(event, taskText);
    if (!signature) continue;
    const group = groups.get(signature.signatureId) ?? {
      ...signature,
      events: [],
      taskIds: new Set<string>(),
    };
    group.events.push(event);
    group.taskIds.add(event.taskId);
    groups.set(signature.signatureId, group);
  }

  for (const group of groups.values()) {
    if (group.events.length < thresholdCount) continue;
    if (existingSignatureIds.has(group.signatureId)) continue;
    const taskIds = [...group.taskIds].sort();
    const anchorTaskId = taskIds[0] ?? group.events[0]?.taskId;
    if (!anchorTaskId) continue;
    options.store.logEvent(anchorTaskId, THRASH_DETECTED_EVENT_TYPE, {
      worker: THRASH_DETECTOR_WORKER_KIND,
      signatureId: group.signatureId,
      signatureBasis: group.basis,
      taskIds,
      count: group.events.length,
      window: {
        hours: windowHours,
        start: windowStart.toISOString(),
        end: now.toISOString(),
      },
    });
    options.logger.warn(`[worker:${THRASH_DETECTOR_WORKER_KIND}] detected recurring auto-fix failure`, {
      module: THRASH_DETECTOR_WORKER_KIND,
      signatureId: group.signatureId,
      count: group.events.length,
      taskIds,
    });
  }
}

export function createThrashDetectorWorker(
  config: ThrashDetectorWorkerConfig & { logger: Logger; store: ThrashDetectorStore },
): WorkerRuntime {
  const onTick: WorkerTick = config.onTick ?? (async () => {
    await runThrashDetectorTick({
      logger: config.logger,
      store: config.store,
      enabled: config.enabled,
      thresholdCount: config.thresholdCount,
      windowHours: config.windowHours,
    });
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

function listEvents(store: ThrashDetectorStore, eventTypes: readonly string[], limit: number): TaskEvent[] {
  if (store.listTaskEvents) return store.listTaskEvents({ eventTypes, sortBy: 'desc', limit });
  if (store.getEventsByTypes) return store.getEventsByTypes(eventTypes, 'desc', limit);
  const matches: TaskEvent[] = [];
  for (const workflow of store.listWorkflows?.() ?? []) {
    for (const task of store.loadTasks?.(workflow.id) ?? []) {
      for (const event of store.getEvents?.(task.id) ?? []) {
        if (eventTypes.includes(event.eventType)) matches.push(event);
      }
    }
  }
  return matches.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
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

function stringFromPayload(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function normalizeFailureText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[a-f0-9]{7,40}/g, '<sha>')
    .replace(/\b(?:task|workflow|pr|pull request)[-_:# ]+[a-z0-9_.-]+\b/g, '<id>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1_000);
}
