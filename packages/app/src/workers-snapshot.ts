import type {
  WorkerSnapshot,
  WorkerSnapshotLogEntry,
  WorkersSnapshotResponse,
} from '@invoker/contracts';
import type { SQLiteAdapter, TaskEvent, WorkerActionRecord } from '@invoker/data-store';
import {
  AUTO_FIX_WORKER_KIND,
  BUILTIN_WORKER_KINDS,
  createWorkerRegistry,
  registerBuiltinWorkers,
  type WorkerRuntime,
  type WorkerRuntimeDependencies,
} from '@invoker/execution-engine';

import type { InvokerConfig } from './config.js';
import { registerExternalWorkersFromConfig } from './external-worker-loader.js';

type WorkerRuntimeState = {
  kind: string;
  runtime: Pick<WorkerRuntime, 'isRunning'>;
};

type WorkerSnapshotStore = Pick<SQLiteAdapter, 'listWorkerActions' | 'listTaskEvents'>;

const RECENT_LOG_LIMIT = 20;
const AUTO_FIX_EVENT_TYPES = [
  'debug.auto-fix',
  'recovery.worker.wakeup',
  'recovery.worker.scan',
  'recovery.worker.submit',
  'recovery.worker.skip',
];

function parseEventPayload(payload: unknown): Record<string, unknown> {
  if (!payload) return {};
  if (typeof payload === 'object') return payload as Record<string, unknown>;
  if (typeof payload !== 'string') return {};
  try {
    const parsed = JSON.parse(payload) as unknown;
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function workerActionLog(action: WorkerActionRecord): WorkerSnapshotLogEntry {
  return {
    source: 'worker_action',
    at: action.updatedAt,
    workerKind: action.workerKind,
    ...(action.workflowId ? { workflowId: action.workflowId } : {}),
    ...(action.taskId ? { taskId: action.taskId } : {}),
    actionType: action.actionType,
    status: action.status,
    ...(action.summary ? { summary: action.summary } : {}),
    ...(action.payload !== undefined ? { payload: action.payload } : {}),
  };
}

function taskEventLog(workerKind: string, event: TaskEvent): WorkerSnapshotLogEntry {
  const payload = parseEventPayload(event.payload);
  const workflowId = typeof payload.workflowId === 'string' ? payload.workflowId : undefined;
  const phase = typeof payload.phase === 'string' ? payload.phase : undefined;
  const action = typeof payload.action === 'string' ? payload.action : undefined;
  const reason = typeof payload.reason === 'string' ? payload.reason : undefined;
  return {
    source: 'task_event',
    at: event.createdAt,
    workerKind,
    taskId: event.taskId,
    ...(workflowId ? { workflowId } : {}),
    eventType: event.eventType,
    ...(phase ? { phase } : {}),
    ...(action ? { action } : {}),
    ...(reason ? { reason } : {}),
    payload,
  };
}

function recentLogsForWorker(store: WorkerSnapshotStore, workerKind: string): WorkerSnapshotLogEntry[] {
  const logs = store
    .listWorkerActions({ workerKind, limit: RECENT_LOG_LIMIT })
    .map(workerActionLog);

  if (workerKind === AUTO_FIX_WORKER_KIND) {
    logs.push(
      ...store
        .listTaskEvents({ eventTypes: AUTO_FIX_EVENT_TYPES, limit: RECENT_LOG_LIMIT })
        .map((event) => taskEventLog(workerKind, event)),
    );
  }

  return logs
    .sort((a, b) => b.at.localeCompare(a.at) || a.source.localeCompare(b.source))
    .slice(0, RECENT_LOG_LIMIT);
}

export function buildWorkersSnapshot(args: {
  persistence: WorkerSnapshotStore;
  invokerConfig: Pick<InvokerConfig, 'externalWorkers'>;
  ownerWorkers?: readonly WorkerRuntimeState[];
  now?: () => Date;
}): WorkersSnapshotResponse {
  const runningByKind = new Map<string, boolean>();
  for (const worker of args.ownerWorkers ?? []) {
    runningByKind.set(worker.kind, worker.runtime.isRunning());
  }

  const builtins = registerBuiltinWorkers(createWorkerRegistry<WorkerRuntimeDependencies>());
  const workers: WorkerSnapshot[] = BUILTIN_WORKER_KINDS.map((kind) => {
    const definition = builtins.get(kind);
    return {
      kind,
      note: definition?.note ?? 'Built-in worker is not registered.',
      source: 'built-in',
      availability: definition ? 'available' : 'unavailable',
      ...(runningByKind.has(kind) ? { running: runningByKind.get(kind) } : {}),
      recentLogs: definition ? recentLogsForWorker(args.persistence, kind) : [],
    };
  });

  const external = registerExternalWorkersFromConfig(
    args.invokerConfig.externalWorkers,
    createWorkerRegistry<WorkerRuntimeDependencies>(),
  );
  for (const definition of external.list()) {
    workers.push({
      kind: definition.kind,
      note: definition.note,
      source: 'external',
      availability: 'available',
      ...(runningByKind.has(definition.kind) ? { running: runningByKind.get(definition.kind) } : {}),
      recentLogs: recentLogsForWorker(args.persistence, definition.kind),
    });
  }

  return {
    generatedAt: (args.now?.() ?? new Date()).toISOString(),
    workers,
  };
}
