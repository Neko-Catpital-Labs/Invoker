import { createHash } from 'node:crypto';

import type { Logger } from '@invoker/contracts';
import type { TaskEvent } from '@invoker/data-store';

import { classifyAutoFixRecoveryPhase } from '../auto-fix-recovery-observability.js';
import type { WorkerRuntimeDependencies } from '../worker-runtime-dependencies.js';
import type { WorkerRegistry } from '../worker-registry.js';
import { createWorkerRuntime, type WorkerRuntime, type WorkerTick } from '../worker-runtime.js';

export const THRASH_DETECTOR_WORKER_KIND = 'thrash-detector';
export const THRASH_DETECTED_EVENT_TYPE = 'thrash.detected';
export const DEFAULT_THRASH_DETECTOR_INTERVAL_MINUTES = 30;
export const DEFAULT_THRASH_DETECTOR_INTERVAL_MS = DEFAULT_THRASH_DETECTOR_INTERVAL_MINUTES * 60 * 1000;
export const DEFAULT_THRASH_DETECTOR_THRESHOLD_COUNT = 3;
export const DEFAULT_THRASH_DETECTOR_WINDOW_HOURS = 24;

export interface ThrashDetectorWorkerConfig {
  enabled?: boolean;
  intervalMs?: number;
  thresholdCount?: number;
  windowHours?: number;
  tickOnStart?: boolean;
  onTick?: WorkerTick;
}

export interface ThrashDetectorWorkerOptions {
  logger: Logger;
  store: ThrashDetectorStore;
  intervalMs?: number;
  thresholdCount?: number;
  windowHours?: number;
  tickOnStart?: boolean;
  now?: () => Date;
  onTick?: WorkerTick;
}

export interface ThrashDetectorStore {
  listTaskEvents?(filters?: { eventTypes?: readonly string[]; sortBy?: 'asc' | 'desc'; limit?: number }): TaskEvent[];
  getEventsByTypes?(eventTypes: readonly string[], sortBy: 'asc' | 'desc', limit: number): TaskEvent[];
  listWorkflows?(): Array<{ id: string }>;
  loadTasks?(workflowId: string): Array<{ id: string }>;
  getEvents?(taskId: string): TaskEvent[];
  getTaskOutput?(taskId: string): string;
  logEvent?(taskId: string, eventType: string, payload?: unknown): void;
}

interface ThrashSignatureGroup {
  signatureId: string;
  signature: string;
  taskIds: Set<string>;
  eventIds: number[];
  count: number;
}

function parseEventPayload(event: TaskEvent): Record<string, unknown> {
  if (typeof event.payload !== 'string' || event.payload.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(event.payload);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function normalizeTerminalOutput(output: string): string {
  return output
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/[A-Fa-f0-9]{40}/g, '<sha>')
    .replace(/[A-Fa-f0-9]{7,12}/g, '<sha>')
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g, '<timestamp>')
    .replace(/\b\d+\b/g, '<num>')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-12)
    .join('\n')
    .toLowerCase();
}

export function buildThrashFailureSignature(event: TaskEvent, terminalOutput: string): {
  signatureId: string;
  signature: string;
} {
  const payload = parseEventPayload(event);
  const phase = typeof payload.phase === 'string' ? payload.phase : 'unknown';
  const recoveryAction = classifyAutoFixRecoveryPhase(phase, payload) ?? 'unclassified';
  const reason = typeof payload.reason === 'string' ? payload.reason : '';
  const route = typeof payload.route === 'string' ? payload.route : '';
  const error = typeof payload.error === 'string' ? payload.error : '';
  const normalizedOutput = normalizeTerminalOutput(terminalOutput);
  const signature = [
    `action=${recoveryAction}`,
    `phase=${phase}`,
    `reason=${reason}`,
    `route=${route}`,
    `error=${normalizeTerminalOutput(error)}`,
    `output=${normalizedOutput}`,
  ].join('\n');
  const signatureId = createHash('sha256').update(signature).digest('hex').slice(0, 16);
  return { signatureId, signature };
}

function listEvents(store: ThrashDetectorStore, eventTypes: readonly string[], limit: number): TaskEvent[] {
  if (store.listTaskEvents) {
    return store.listTaskEvents({ eventTypes, sortBy: 'desc', limit });
  }
  if (store.getEventsByTypes) {
    return store.getEventsByTypes(eventTypes, 'desc', limit);
  }
  const events: TaskEvent[] = [];
  for (const workflow of store.listWorkflows?.() ?? []) {
    for (const task of store.loadTasks?.(workflow.id) ?? []) {
      for (const event of store.getEvents?.(task.id) ?? []) {
        if (eventTypes.includes(event.eventType)) events.push(event);
      }
    }
  }
  return events
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id)
    .slice(0, limit);
}

function existingThrashSignatureIds(store: ThrashDetectorStore): Set<string> {
  const ids = new Set<string>();
  for (const event of listEvents(store, [THRASH_DETECTED_EVENT_TYPE], 10_000)) {
    const payload = parseEventPayload(event);
    if (typeof payload.signatureId === 'string') ids.add(payload.signatureId);
  }
  return ids;
}

export async function runThrashDetectorTick(options: ThrashDetectorWorkerOptions): Promise<void> {
  const thresholdCount = options.thresholdCount ?? DEFAULT_THRASH_DETECTOR_THRESHOLD_COUNT;
  const windowHours = options.windowHours ?? DEFAULT_THRASH_DETECTOR_WINDOW_HOURS;
  const now = options.now?.() ?? new Date();
  const windowStartedAtMs = now.getTime() - windowHours * 60 * 60 * 1000;
  const events = listEvents(options.store, ['debug.auto-fix'], 10_000)
    .filter((event) => new Date(event.createdAt).getTime() >= windowStartedAtMs);
  const seenSignatureIds = existingThrashSignatureIds(options.store);
  const groups = new Map<string, ThrashSignatureGroup>();

  for (const event of events) {
    const output = options.store.getTaskOutput?.(event.taskId) ?? '';
    const signature = buildThrashFailureSignature(event, output);
    const group = groups.get(signature.signatureId) ?? {
      ...signature,
      taskIds: new Set<string>(),
      eventIds: [],
      count: 0,
    };
    group.taskIds.add(event.taskId);
    group.eventIds.push(event.id);
    group.count += 1;
    groups.set(signature.signatureId, group);
  }

  let detected = 0;
  for (const group of groups.values()) {
    if (group.count < thresholdCount || seenSignatureIds.has(group.signatureId)) continue;
    const taskIds = [...group.taskIds].sort();
    options.store.logEvent?.(taskIds[0], THRASH_DETECTED_EVENT_TYPE, {
      workerId: THRASH_DETECTOR_WORKER_KIND,
      kind: THRASH_DETECTOR_WORKER_KIND,
      signatureId: group.signatureId,
      signature: group.signature,
      taskIds,
      count: group.count,
      thresholdCount,
      window: {
        hours: windowHours,
        startedAt: new Date(windowStartedAtMs).toISOString(),
        endedAt: now.toISOString(),
      },
      eventIds: group.eventIds.sort((a, b) => a - b),
    });
    detected += 1;
  }

  options.logger.info(`[${THRASH_DETECTOR_WORKER_KIND}] scanned ${events.length} debug.auto-fix events`, {
    module: THRASH_DETECTOR_WORKER_KIND,
    detected,
  });
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
    listWorkKeys: () => ['thrash-detector:debug-auto-fix'],
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
