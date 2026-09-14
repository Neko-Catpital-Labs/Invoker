import { createHash } from 'node:crypto';

import type { Logger } from '@invoker/contracts';
import type { TaskEvent } from '@invoker/data-store';
import type { TaskState } from '@invoker/workflow-core';

import { classifyAutoFixRecoveryPhase } from '../auto-fix-recovery.js';
import type { WorkerRuntimeDependencies } from '../worker-runtime-dependencies.js';
import type { WorkerRegistry } from '../worker-registry.js';
import { createWorkerRuntime, type WorkerRuntime, type WorkerTick } from '../worker-runtime.js';

export const THRASH_DETECTOR_WORKER_KIND = 'thrash-detector';
export const DEFAULT_THRASH_DETECTOR_INTERVAL_MINUTES = 15;
export const DEFAULT_THRASH_DETECTOR_INTERVAL_MS = DEFAULT_THRASH_DETECTOR_INTERVAL_MINUTES * 60_000;
export const DEFAULT_THRASH_DETECTOR_THRESHOLD_COUNT = 3;
export const DEFAULT_THRASH_DETECTOR_WINDOW_HOURS = 24;

const DEBUG_AUTO_FIX_EVENT_TYPE = 'debug.auto-fix';
const THRASH_DETECTED_EVENT_TYPE = 'thrash.detected';
const MAX_EVENT_SCAN = 10_000;

export interface ThrashDetectorWorkerStore {
  listTaskEvents?(filters?: {
    taskId?: string;
    eventTypes?: readonly string[];
    sortBy?: 'asc' | 'desc';
    limit?: number;
  }): TaskEvent[];
  listWorkflows(): ReadonlyArray<{ id: string }>;
  loadTasks(workflowId: string): TaskState[];
  loadTask?(taskId: string): TaskState | undefined;
  getEvents(taskId: string, sortBy?: 'asc' | 'desc', limit?: number): TaskEvent[];
  getTaskOutput(taskId: string): string;
  logEvent(taskId: string, eventType: string, payload?: unknown): void;
}

export interface ThrashDetectorWorkerConfig {
  enabled?: boolean;
  intervalMs?: number;
  thresholdCount?: number;
  windowHours?: number;
  tickOnStart?: boolean;
  now?: () => number;
  onTick?: WorkerTick;
}

export interface ThrashDetectorWorkerOptions extends ThrashDetectorWorkerConfig {
  logger: Logger;
  store: ThrashDetectorWorkerStore;
}

export interface ThrashSignatureMatch {
  readonly event: TaskEvent;
  readonly taskId: string;
  readonly signatureId: string;
  readonly signatureBasis: string;
}

export interface ThrashDetection {
  readonly signatureId: string;
  readonly signatureBasis: string;
  readonly matchingTaskIds: readonly string[];
  readonly count: number;
  readonly window: {
    readonly hours: number;
    readonly startedAt: string;
    readonly endedAt: string;
  };
}

function parsePayload(payload: unknown): Record<string, unknown> {
  if (typeof payload !== 'string' || payload.trim().length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(payload);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function normalizeTerminalOutput(text: string): string {
  const normalized = text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
    .toLowerCase();
  return normalized.slice(-4_000);
}

function signatureIdForBasis(basis: string): string {
  return createHash('sha256').update(basis).digest('hex').slice(0, 16);
}

export function buildThrashSignature(
  event: TaskEvent,
  terminalOutput: string,
): { signatureId: string; signatureBasis: string } | undefined {
  const payload = parsePayload(event.payload);
  const phase = typeof payload.phase === 'string' ? payload.phase : undefined;
  if (!phase) return undefined;

  const recoveryAction = classifyAutoFixRecoveryPhase(phase, payload) ?? 'unclassified';
  const normalizedOutput = normalizeTerminalOutput(terminalOutput);
  if (!normalizedOutput) return undefined;

  const signatureBasis = `${recoveryAction}\n${normalizedOutput}`;
  return {
    signatureId: signatureIdForBasis(signatureBasis),
    signatureBasis,
  };
}

export function detectThrashSignatures(
  matches: readonly ThrashSignatureMatch[],
  options: {
    thresholdCount: number;
    windowHours: number;
    nowMs: number;
    alreadyDetectedSignatureIds?: ReadonlySet<string>;
  },
): ThrashDetection[] {
  const windowMs = options.windowHours * 60 * 60 * 1000;
  const startedAtMs = options.nowMs - windowMs;
  const bySignature = new Map<string, ThrashSignatureMatch[]>();

  for (const match of matches) {
    const createdAtMs = Date.parse(match.event.createdAt);
    if (!Number.isFinite(createdAtMs) || createdAtMs < startedAtMs || createdAtMs > options.nowMs) continue;
    const group = bySignature.get(match.signatureId) ?? [];
    group.push(match);
    bySignature.set(match.signatureId, group);
  }

  const alreadyDetected = options.alreadyDetectedSignatureIds ?? new Set<string>();
  const detections: ThrashDetection[] = [];
  for (const [signatureId, group] of bySignature) {
    if (alreadyDetected.has(signatureId)) continue;
    if (group.length < options.thresholdCount) continue;
    detections.push({
      signatureId,
      signatureBasis: group[0]?.signatureBasis ?? signatureId,
      matchingTaskIds: [...new Set(group.map((match) => match.taskId))].sort(),
      count: group.length,
      window: {
        hours: options.windowHours,
        startedAt: new Date(startedAtMs).toISOString(),
        endedAt: new Date(options.nowMs).toISOString(),
      },
    });
  }
  return detections.sort((a, b) => b.count - a.count || a.signatureId.localeCompare(b.signatureId));
}

function listEventsByType(store: ThrashDetectorWorkerStore, eventType: string): TaskEvent[] {
  if (store.listTaskEvents) {
    return store.listTaskEvents({ eventTypes: [eventType], sortBy: 'desc', limit: MAX_EVENT_SCAN });
  }

  const events: TaskEvent[] = [];
  for (const workflow of store.listWorkflows()) {
    for (const task of store.loadTasks(workflow.id)) {
      for (const event of store.getEvents(task.id, 'desc', 200)) {
        if (event.eventType === eventType) events.push(event);
      }
    }
  }
  return events.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, MAX_EVENT_SCAN);
}

function collectSignatureMatches(store: ThrashDetectorWorkerStore): ThrashSignatureMatch[] {
  const matches: ThrashSignatureMatch[] = [];
  for (const event of listEventsByType(store, DEBUG_AUTO_FIX_EVENT_TYPE)) {
    const output = store.getTaskOutput(event.taskId)
      || store.loadTask?.(event.taskId)?.execution.error
      || '';
    const signature = buildThrashSignature(event, output);
    if (!signature) continue;
    matches.push({
      event,
      taskId: event.taskId,
      signatureId: signature.signatureId,
      signatureBasis: signature.signatureBasis,
    });
  }
  return matches;
}

function collectDetectedSignatureIds(store: ThrashDetectorWorkerStore): Set<string> {
  const detected = new Set<string>();
  for (const event of listEventsByType(store, THRASH_DETECTED_EVENT_TYPE)) {
    const payload = parsePayload(event.payload);
    if (typeof payload.signatureId === 'string' && payload.signatureId.trim().length > 0) {
      detected.add(payload.signatureId);
    }
  }
  return detected;
}

export async function runThrashDetectorTick(options: ThrashDetectorWorkerOptions): Promise<ThrashDetection[]> {
  if (options.enabled === false) return [];

  const nowMs = options.now?.() ?? Date.now();
  const thresholdCount = options.thresholdCount ?? DEFAULT_THRASH_DETECTOR_THRESHOLD_COUNT;
  const windowHours = options.windowHours ?? DEFAULT_THRASH_DETECTOR_WINDOW_HOURS;
  const detections = detectThrashSignatures(collectSignatureMatches(options.store), {
    thresholdCount,
    windowHours,
    nowMs,
    alreadyDetectedSignatureIds: collectDetectedSignatureIds(options.store),
  });

  for (const detection of detections) {
    const taskId = detection.matchingTaskIds[0];
    if (!taskId) continue;
    options.store.logEvent(taskId, THRASH_DETECTED_EVENT_TYPE, {
      workerId: THRASH_DETECTOR_WORKER_KIND,
      kind: THRASH_DETECTOR_WORKER_KIND,
      signatureId: detection.signatureId,
      matchingTaskIds: detection.matchingTaskIds,
      count: detection.count,
      window: detection.window,
    });
  }

  if (detections.length > 0) {
    options.logger.warn?.(`[${THRASH_DETECTOR_WORKER_KIND}] detected ${detections.length} recurring auto-fix failure signature(s)`, {
      module: THRASH_DETECTOR_WORKER_KIND,
      signatures: detections.map((detection) => detection.signatureId),
    });
  }
  return detections;
}

export function createThrashDetectorWorker(config: ThrashDetectorWorkerOptions): WorkerRuntime {
  return createWorkerRuntime({
    kind: THRASH_DETECTOR_WORKER_KIND,
    logger: config.logger,
    intervalMs: config.intervalMs ?? DEFAULT_THRASH_DETECTOR_INTERVAL_MS,
    tickOnStart: config.tickOnStart ?? true,
    onTick: async (ctx) => {
      ctx.signal.throwIfAborted();
      await config.onTick?.(ctx);
      ctx.signal.throwIfAborted();
      await runThrashDetectorTick(config);
    },
  });
}

export function registerThrashDetectorWorker(
  registry: WorkerRegistry<WorkerRuntimeDependencies>,
): WorkerRegistry<WorkerRuntimeDependencies> {
  registry.register({
    kind: THRASH_DETECTOR_WORKER_KIND,
    note: 'Aggregates recurring debug.auto-fix audit events by normalized failure signature and emits thrash.detected audit events.',
    source: 'built-in',
    factory: (deps: WorkerRuntimeDependencies): WorkerRuntime =>
      createThrashDetectorWorker({
        logger: deps.logger,
        store: deps.store,
        enabled: deps.thrashDetector?.enabled,
        intervalMs: deps.thrashDetector?.intervalMs,
        thresholdCount: deps.thrashDetector?.thresholdCount,
        windowHours: deps.thrashDetector?.windowHours,
        tickOnStart: deps.thrashDetector?.tickOnStart,
      }),
  });
  return registry;
}
