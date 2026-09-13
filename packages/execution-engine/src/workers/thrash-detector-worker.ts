import { createHash } from 'node:crypto';

import { classifyAutoFixRecoveryPhase, type Logger, type TaskState } from '@invoker/contracts';
import type { TaskEvent } from '@invoker/data-store';

import type { WorkerRuntimeDependencies } from '../worker-runtime-dependencies.js';
import type { WorkerRegistry } from '../worker-registry.js';
import { createWorkerRuntime, type WorkerRuntime, type WorkerTick } from '../worker-runtime.js';

export const THRASH_DETECTOR_WORKER_KIND = 'thrash-detector';
export const DEFAULT_THRASH_DETECTOR_INTERVAL_MINUTES = 15;
export const DEFAULT_THRASH_DETECTOR_THRESHOLD_COUNT = 3;
export const DEFAULT_THRASH_DETECTOR_WINDOW_HOURS = 24;

export interface ThrashDetectorWorkerConfig {
  enabled?: boolean;
  /** Poll cadence in milliseconds. Defaults to fifteen minutes. */
  intervalMs?: number;
  /** Minimum matching auto-fix debug events in the window before logging thrash.detected. */
  thresholdCount?: number;
  /** Lookback window in hours. Defaults to twenty-four hours. */
  windowHours?: number;
  tickOnStart?: boolean;
  now?: () => Date;
  onTick?: WorkerTick;
}

export interface ThrashDetectorStore {
  listWorkflows(): Array<{ id: string }>;
  loadTasks(workflowId: string): Array<Pick<TaskState, 'id' | 'terminalOutputSnapshot'>>;
  getEvents(taskId: string): TaskEvent[];
  logEvent(taskId: string, eventType: string, payload?: unknown): void;
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

interface ParsedDebugEvent {
  taskId: string;
  event: TaskEvent;
  payload: Record<string, unknown>;
  signatureId: string;
  signatureBasis: string;
}

function parsePayload(payload: string | undefined): Record<string, unknown> {
  if (!payload) return {};
  try {
    const parsed = JSON.parse(payload) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function normalizeText(value: string): string {
  return value
    .replace(/\r/g, '\n')
    .replace(/[0-9a-f]{7,40}/gi, '<sha>')
    .replace(/\b\d+\b/g, '<num>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(-2_000);
}

function signatureFor(payload: Record<string, unknown>, terminalOutput: string | undefined): {
  signatureId: string;
  signatureBasis: string;
} | undefined {
  const phase = typeof payload.phase === 'string' ? payload.phase : '';
  const action = classifyAutoFixRecoveryPhase(phase, payload);
  if (!action) return undefined;
  const reason = typeof payload.reason === 'string' ? payload.reason : '';
  const status = typeof payload.status === 'string' ? payload.status : '';
  const terminal = normalizeText(terminalOutput ?? '');
  const signatureBasis = JSON.stringify({ action, phase, reason, status, terminal });
  const signatureId = createHash('sha256').update(signatureBasis).digest('hex').slice(0, 16);
  return { signatureId, signatureBasis };
}

function collectDebugEvents(
  store: ThrashDetectorStore,
  cutoffMs: number,
): { events: ParsedDebugEvent[]; alreadyDetectedSignatureIds: Set<string> } {
  const events: ParsedDebugEvent[] = [];
  const alreadyDetectedSignatureIds = new Set<string>();
  for (const workflow of store.listWorkflows()) {
    for (const task of store.loadTasks(workflow.id)) {
      for (const event of store.getEvents(task.id)) {
        const eventMs = Date.parse(event.createdAt);
        if (!Number.isFinite(eventMs) || eventMs < cutoffMs) continue;
        const payload = parsePayload(event.payload);
        if (event.eventType === 'thrash.detected') {
          const signatureId = typeof payload.signatureId === 'string' ? payload.signatureId : undefined;
          if (signatureId) alreadyDetectedSignatureIds.add(signatureId);
          continue;
        }
        if (event.eventType !== 'debug.auto-fix') continue;
        const signature = signatureFor(payload, task.terminalOutputSnapshot);
        if (!signature) continue;
        events.push({
          taskId: task.id,
          event,
          payload,
          signatureId: signature.signatureId,
          signatureBasis: signature.signatureBasis,
        });
      }
    }
  }
  return { events, alreadyDetectedSignatureIds };
}

export async function runThrashDetectorTick(options: ThrashDetectorWorkerOptions): Promise<void> {
  const thresholdCount = options.thresholdCount ?? DEFAULT_THRASH_DETECTOR_THRESHOLD_COUNT;
  const windowHours = options.windowHours ?? DEFAULT_THRASH_DETECTOR_WINDOW_HOURS;
  const now = options.now?.() ?? new Date();
  const cutoffMs = now.getTime() - windowHours * 60 * 60 * 1000;
  const { events, alreadyDetectedSignatureIds } = collectDebugEvents(options.store, cutoffMs);
  const bySignature = new Map<string, ParsedDebugEvent[]>();

  for (const event of events) {
    const matches = bySignature.get(event.signatureId) ?? [];
    matches.push(event);
    bySignature.set(event.signatureId, matches);
  }

  for (const [signatureId, matches] of bySignature) {
    if (matches.length < thresholdCount) continue;
    if (alreadyDetectedSignatureIds.has(signatureId)) continue;
    const sorted = [...matches].sort((a, b) => Date.parse(a.event.createdAt) - Date.parse(b.event.createdAt));
    const taskIds = [...new Set(sorted.map((match) => match.taskId))];
    const auditTaskId = sorted[0]?.taskId;
    if (!auditTaskId) continue;
    options.store.logEvent(auditTaskId, 'thrash.detected', {
      signatureId,
      matchingTaskIds: taskIds,
      count: matches.length,
      window: {
        hours: windowHours,
        startedAt: new Date(cutoffMs).toISOString(),
        endedAt: now.toISOString(),
      },
    });
    alreadyDetectedSignatureIds.add(signatureId);
    options.logger.warn(`[${THRASH_DETECTOR_WORKER_KIND}] detected recurring auto-fix signature`, {
      module: THRASH_DETECTOR_WORKER_KIND,
      signatureId,
      count: matches.length,
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
    intervalMs: config.intervalMs ?? DEFAULT_THRASH_DETECTOR_INTERVAL_MINUTES * 60 * 1000,
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
