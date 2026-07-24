import type {
  WorkerActionHistoryRequest,
  WorkerActionHistoryResponse,
  WorkerActionSummary,
  WorkerDecisionsRequest,
  WorkerDecisionsResponse,
  WorkerLogEntry,
  WorkerPolicyStatus,
  WorkerRecoverySummary,
  WorkerSource,
  WorkerStatusEntry,
  WorkerStatusSnapshot,
} from '@invoker/contracts';
import type { SQLiteAdapter, TaskEvent, WorkerActionRecord } from '@invoker/data-store';
import {
  AUTO_FIX_WORKER_KIND,
  AUTO_APPROVE_WORKER_KIND,
  CI_FAILURE_WORKER_KIND,
  CODERABBIT_ADDRESS_WORKER_KIND,
  DISK_HEADROOM_WORKER_KIND,
  E2E_AUTOFIX_WORKER_KIND,
  PR_ADMIN_BYPASS_LAND_WORKER_KIND,
  PR_SUMMARY_REFRESH_WORKER_KIND,
  PR_CI_FAILURE_SCAN_WORKER_KIND,
  PR_CONFLICT_REBASE_WORKER_KIND,
  PR_STATUS_WORKER_KIND,
  REQUEUE_WORKER_KIND,
  REVIEW_GATE_MERGE_CONFLICT_WORKER_KIND,
  WORKFLOW_RESUME_WORKER_KIND,
  type WorkerRegistry,
  type WorkerRuntime,
  type WorkerRuntimeDependencies,
} from '@invoker/execution-engine';
import { collectRecoveryWorkerStatus } from './recovery-worker-observability.js';

/** Worker kinds auto-started on every owner boot, regardless of config. */
export const ALWAYS_AUTO_STARTED_OWNER_WORKER_KINDS = [
  PR_STATUS_WORKER_KIND,
  PR_SUMMARY_REFRESH_WORKER_KIND,
  CI_FAILURE_WORKER_KIND,
  REVIEW_GATE_MERGE_CONFLICT_WORKER_KIND,
  DISK_HEADROOM_WORKER_KIND,
  REQUEUE_WORKER_KIND,
  AUTO_APPROVE_WORKER_KIND,
] as const;

/** Cron-scan PR-maintenance worker kinds, auto-started only when `prMaintenance.enabled` is true. */
export const PR_MAINTENANCE_AUTO_STARTED_WORKER_KINDS = [
  CODERABBIT_ADDRESS_WORKER_KIND,
  PR_CONFLICT_REBASE_WORKER_KIND,
  PR_CI_FAILURE_SCAN_WORKER_KIND,
  PR_ADMIN_BYPASS_LAND_WORKER_KIND,
] as const;

/**
 * @deprecated Transitional flat list for callers not yet migrated to
 * `autoStartedOwnerWorkerKindsForConfig`; dropped in the follow-up slice.
 */
export const AUTO_STARTED_OWNER_WORKER_KINDS = [
  ...ALWAYS_AUTO_STARTED_OWNER_WORKER_KINDS,
  ...PR_MAINTENANCE_AUTO_STARTED_WORKER_KINDS,
] as const;

/**
 * Compute the owner worker kinds that auto-start on boot. The PR-maintenance
 * cron kinds are gated on `prMaintenance.enabled` (matching the config
 * docstring); everything else always auto-starts. Saved per-worker desired
 * state still overrides in both directions.
 */
export function autoStartedOwnerWorkerKinds(options: { prMaintenanceEnabled: boolean }): readonly string[] {
  return options.prMaintenanceEnabled
    ? [...ALWAYS_AUTO_STARTED_OWNER_WORKER_KINDS, ...PR_MAINTENANCE_AUTO_STARTED_WORKER_KINDS]
    : ALWAYS_AUTO_STARTED_OWNER_WORKER_KINDS;
}

/** Convenience wrapper: derive the auto-start list straight from Invoker config. */
export function autoStartedOwnerWorkerKindsForConfig(
  config?: { prMaintenance?: { enabled?: boolean } },
): readonly string[] {
  return autoStartedOwnerWorkerKinds({ prMaintenanceEnabled: Boolean(config?.prMaintenance?.enabled) });
}

export interface WorkerRuntimeController {
  startAutoStartedWorkers(): void;
  start(kind: string, options?: { persistDesiredState?: boolean }): WorkerStatusEntry;
  stop(kind: string): Promise<WorkerStatusEntry>;
  stopAll(): Promise<void>;
  snapshot(): WorkerStatusSnapshot;
}

type WorkerStatusPersistence = Pick<
  SQLiteAdapter,
  | 'listWorkerActions'
  | 'listTaskEvents'
  | 'listWorkflows'
  | 'loadTasks'
  | 'getEvents'
  | 'getEventsByTypes'
  | 'countEventsByTypes'
> & Partial<Pick<SQLiteAdapter, 'getWorkerDesiredState' | 'setWorkerDesiredState' | 'listWorkerDesiredStates'>>;

const DEFAULT_WORKER_ACTION_HISTORY_LIMIT = 20;
const MAX_WORKER_ACTION_HISTORY_LIMIT = 100;
/** Bounded wait for quit / stopAll so in-flight ticks cannot hang process exit. */
export const STOP_ALL_SETTLE_TIMEOUT_MS = 5_000;

function positiveIntegerOrDefault(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const normalized = Math.floor(value);
  if (!Number.isFinite(normalized) || normalized <= 0) {
    return fallback;
  }
  return normalized;
}

function nonNegativeIntegerOrZero(value: number | undefined): number {
  if (value === undefined) return 0;
  const normalized = Math.floor(value);
  if (!Number.isFinite(normalized) || normalized < 0) {
    return 0;
  }
  return normalized;
}

export function listWorkerActionHistory(
  persistence: Pick<SQLiteAdapter, 'listWorkerActions'>,
  request: WorkerActionHistoryRequest,
): WorkerActionHistoryResponse {
  const workerKind = typeof request?.workerKind === 'string' ? request.workerKind.trim() : '';
  if (workerKind.length === 0) {
    throw new Error('workerKind is required');
  }
  const limit = Math.min(
    positiveIntegerOrDefault(request?.limit, DEFAULT_WORKER_ACTION_HISTORY_LIMIT),
    MAX_WORKER_ACTION_HISTORY_LIMIT,
  );
  const offset = nonNegativeIntegerOrZero(request?.offset);
  const rows = persistence.listWorkerActions({ workerKind, limit: limit + 1, offset });
  const actions = rows.slice(0, limit).map(toWorkerActionSummary);
  const hasMore = rows.length > limit;
  return {
    workerKind,
    actions,
    limit,
    offset,
    hasMore,
    ...(hasMore ? { nextOffset: offset + actions.length } : {}),
  };
}

export function listWorkerDecisions(
  persistence: Pick<SQLiteAdapter, 'listWorkerActions'>,
  request: WorkerDecisionsRequest,
): WorkerDecisionsResponse {
  const workflowId = typeof request?.workflowId === 'string' && request.workflowId.trim().length > 0
    ? request.workflowId.trim()
    : undefined;
  const workerKind = typeof request?.workerKind === 'string' && request.workerKind.trim().length > 0
    ? request.workerKind.trim()
    : undefined;
  const decision = request?.decision === 'act' || request?.decision === 'skip' ? request.decision : undefined;
  const reasonNeedle = typeof request?.reason === 'string' && request.reason.trim().length > 0
    ? request.reason.trim().toLowerCase()
    : undefined;
  const limit = Math.min(
    positiveIntegerOrDefault(request?.limit, DEFAULT_WORKER_ACTION_HISTORY_LIMIT),
    MAX_WORKER_ACTION_HISTORY_LIMIT,
  );
  const offset = nonNegativeIntegerOrZero(request?.offset);
  const baseFilters = {
    ...(workflowId ? { workflowId } : {}),
    ...(workerKind ? { workerKind } : {}),
    ...(decision ? { decision } : {}),
  };

  let actions: WorkerActionSummary[];
  let hasMore: boolean;
  if (reasonNeedle) {
    const matched = persistence.listWorkerActions(baseFilters)
      .map(toWorkerActionSummary)
      .filter((action) => (action.reason ?? '').toLowerCase().includes(reasonNeedle));
    actions = matched.slice(offset, offset + limit);
    hasMore = matched.length > offset + limit;
  } else {
    const rows = persistence.listWorkerActions({ ...baseFilters, limit: limit + 1, offset });
    actions = rows.slice(0, limit).map(toWorkerActionSummary);
    hasMore = rows.length > limit;
  }

  return {
    ...(workflowId ? { workflowId } : {}),
    actions,
    limit,
    offset,
    hasMore,
    ...(hasMore ? { nextOffset: offset + actions.length } : {}),
  };
}

interface RuntimeHandle {
  runtime: WorkerRuntime;
  startedAt: string;
  stoppedAt?: string;
}

const BUILT_IN_WORKER_KINDS = new Set<string>([
  AUTO_FIX_WORKER_KIND,
  PR_STATUS_WORKER_KIND,
  PR_SUMMARY_REFRESH_WORKER_KIND,
  CI_FAILURE_WORKER_KIND,
  DISK_HEADROOM_WORKER_KIND,
  E2E_AUTOFIX_WORKER_KIND,
  REQUEUE_WORKER_KIND,
  AUTO_APPROVE_WORKER_KIND,
  CODERABBIT_ADDRESS_WORKER_KIND,
  PR_CONFLICT_REBASE_WORKER_KIND,
  WORKFLOW_RESUME_WORKER_KIND,
  PR_CI_FAILURE_SCAN_WORKER_KIND,
]);

export function createWorkerRuntimeController(options: {
  registry: WorkerRegistry<WorkerRuntimeDependencies>;
  deps: WorkerRuntimeDependencies;
  autoStartKinds: readonly string[];
  persistence: WorkerStatusPersistence;
  /** Compatibility input; retry budget is enforced inside worker policy, not by controller start gating. */
  autoFixRetries?: number;
  canControl: () => boolean;
}): WorkerRuntimeController {
  const handles = new Map<string, RuntimeHandle>();
  const stoppedAtByKind = new Map<string, string>();

  const requireDefinition = (kind: string) => {
    const definition = options.registry.get(kind);
    if (!definition) {
      throw new Error(`Unknown worker kind: "${kind}"`);
    }
    return definition;
  };

  const desiredEnabledForKind = (kind: string): boolean => {
    const saved = options.persistence.getWorkerDesiredState?.(kind);
    return saved?.desiredEnabled ?? options.autoStartKinds.includes(kind);
  };

  const rowForKind = (kind: string): WorkerStatusEntry => {
    const definition = options.registry.get(kind);
    if (!definition) {
      throw new Error(`Unknown worker kind: "${kind}"`);
    }
    const desiredEnabled = desiredEnabledForKind(kind);
    return buildWorkerStatusEntry({
      definitionKind: definition.kind,
      note: definition.note,
      source: sourceForDefinition(definition),
      handle: handles.get(kind),
      stoppedAt: stoppedAtByKind.get(kind),
      autoStarts: desiredEnabled,
      desiredEnabled,
      policy: policyForKind(kind),
      persistence: options.persistence,
      canControl: options.canControl(),
      recovery: definition.kind === AUTO_FIX_WORKER_KIND
        ? toWorkerRecoverySummary(options.persistence)
        : undefined,
      runningKnown: true,
    });
  };

  const stopHandle = async (
    kind: string,
    handle: RuntimeHandle,
    settleTimeoutMs = 0,
  ): Promise<void> => {
    await handle.runtime.stop({ settleTimeoutMs });
    const stoppedAt = new Date().toISOString();
    stoppedAtByKind.set(kind, stoppedAt);
    handles.delete(kind);
  };

  return {
    startAutoStartedWorkers(): void {
      for (const definition of options.registry.list()) {
        if (!desiredEnabledForKind(definition.kind)) continue;
        this.start(definition.kind, { persistDesiredState: false });
      }
    },

    start(kind: string, optionsArg?: { persistDesiredState?: boolean }): WorkerStatusEntry {
      const definition = requireDefinition(kind);
      if (optionsArg?.persistDesiredState !== false) {
        options.persistence.setWorkerDesiredState?.(kind, true);
      }

      const existing = handles.get(kind);
      if (existing) {
        if (existing.runtime.isRunning()) {
          return rowForKind(kind);
        }
        void existing.runtime.stop().catch(() => undefined);
        handles.delete(kind);
      }

      const runtime = definition.factory(options.deps);
      runtime.start();
      handles.set(kind, {
        runtime,
        startedAt: new Date().toISOString(),
      });
      stoppedAtByKind.delete(kind);
      return rowForKind(kind);
    },
    async stop(kind: string): Promise<WorkerStatusEntry> {
      requireDefinition(kind);
      options.persistence.setWorkerDesiredState?.(kind, false);
      const handle = handles.get(kind);
      if (!handle) {
        return rowForKind(kind);
      }
      await stopHandle(kind, handle);
      return rowForKind(kind);
    },

    async stopAll(): Promise<void> {
      const stopping = [...handles.entries()].map(([kind, handle]) =>
        stopHandle(kind, handle, STOP_ALL_SETTLE_TIMEOUT_MS).catch(() => undefined),
      );
      await Promise.all(stopping);
    },

    snapshot(): WorkerStatusSnapshot {
      return {
        generatedAt: new Date().toISOString(),
        workers: options.registry.list().map((definition) => rowForKind(definition.kind)),
      };
    },
  };
}
export function createLocalWorkerStatusSnapshot(options: {
  registry: WorkerRegistry<WorkerRuntimeDependencies>;
  persistence: WorkerStatusPersistence;
  autoStartKinds: readonly string[];
}): WorkerStatusSnapshot {
  const recovery = options.registry.list().some((definition) => definition.kind === AUTO_FIX_WORKER_KIND)
    ? toWorkerRecoverySummary(options.persistence)
    : undefined;
  return {
    generatedAt: new Date().toISOString(),
    workers: options.registry.list().map((definition) => {
      const desiredEnabled = options.persistence.getWorkerDesiredState?.(definition.kind)?.desiredEnabled
        ?? options.autoStartKinds.includes(definition.kind);
      return buildWorkerStatusEntry({
        definitionKind: definition.kind,
        note: definition.note,
        source: sourceForDefinition(definition),
        autoStarts: desiredEnabled,
        desiredEnabled,
        policy: 'unknown',
        persistence: options.persistence,
        canControl: false,
        recovery: definition.kind === AUTO_FIX_WORKER_KIND ? recovery : undefined,
        runningKnown: false,
      });
    }),
  };
}


function buildWorkerStatusEntry(args: {
  definitionKind: string;
  note: string;
  source: WorkerSource;
  handle?: RuntimeHandle;
  stoppedAt?: string;
  autoStarts: boolean;
  desiredEnabled: boolean;
  policy: WorkerPolicyStatus;
  persistence: WorkerStatusPersistence;
  canControl: boolean;
  recovery?: WorkerRecoverySummary;
  runningKnown: boolean;
}): WorkerStatusEntry {
  const lifecycle = args.handle
    ? args.handle.runtime.isRunning() ? 'running' : 'exited'
    : 'stopped';
  const controlDisabledReason = getControlDisabledReason(args.canControl);
  const runtime = args.handle?.runtime;
  const rawActions = args.persistence.listWorkerActions({ workerKind: args.definitionKind, limit: 5 }).slice(0, 5);
  const recentActions = rawActions.map(toWorkerActionSummary);
  return {
    kind: args.definitionKind,
    note: args.note,
    source: args.source,
    availability: 'available',
    ...(args.runningKnown ? { running: lifecycle === 'running' } : {}),
    ...(runtime ? { runtimeKind: runtime.identity.kind, instanceId: runtime.identity.instanceId } : {}),
    lifecycle,
    policy: args.policy,
    autoStarts: args.autoStarts,
    desiredEnabled: args.desiredEnabled,
    startable: lifecycle !== 'running' && args.policy !== 'disabled' && args.canControl,
    stoppable: lifecycle === 'running' && args.canControl,
    ...(controlDisabledReason ? { controlDisabledReason } : {}),
    ...(args.handle?.startedAt ? { startedAt: args.handle.startedAt } : {}),
    ...(args.stoppedAt ? { stoppedAt: args.stoppedAt } : {}),
    recentActions,
    recentLogs: buildRecentWorkerLogs(args.definitionKind, args.persistence, rawActions),
    ...(args.recovery ? { recovery: args.recovery } : {}),
  };
}

function sourceForDefinition(definition: { kind: string; source?: 'built-in' | 'external' }): WorkerSource {
  return definition.source ?? (BUILT_IN_WORKER_KINDS.has(definition.kind) ? 'built-in' : 'external');
}

function policyForKind(kind: string): WorkerPolicyStatus {
  if (BUILT_IN_WORKER_KINDS.has(kind)) return 'enabled';
  return 'unknown';
}

function getControlDisabledReason(canControl: boolean): string | undefined {
  if (!canControl) return 'Controls unavailable';
  return undefined;
}

export function toWorkerActionSummary(action: WorkerActionRecord): WorkerActionSummary {
  const payload = action.payload;
  const rawReason = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>).reason
    : undefined;
  const reason = typeof rawReason === 'string' && rawReason.length > 0 ? rawReason : undefined;
  return {
    id: action.id,
    workerKind: action.workerKind,
    actionType: action.actionType,
    ...(action.workflowId ? { workflowId: action.workflowId } : {}),
    ...(action.taskId ? { taskId: action.taskId } : {}),
    subjectType: action.subjectType,
    subjectId: action.subjectId,
    externalKey: action.externalKey,
    status: action.status,
    attemptCount: action.attemptCount,
    ...(action.intentId ? { intentId: action.intentId } : {}),
    ...(action.agentName ? { agentName: action.agentName } : {}),
    ...(action.executionModel ? { executionModel: action.executionModel } : {}),
    ...(action.sessionId ? { sessionId: action.sessionId } : {}),
    ...(action.summary ? { summary: action.summary } : {}),
    ...(reason ? { reason } : {}),
    decision: action.status === 'skipped' ? 'skip' : 'act',
    createdAt: action.createdAt,
    updatedAt: action.updatedAt,
    ...(action.completedAt ? { completedAt: action.completedAt } : {}),
  };
}

const AUTO_FIX_WORKER_EVENT_TYPES = [
  'debug.auto-fix',
  'recovery.worker.wakeup',
  'recovery.worker.scan',
  'recovery.worker.submit',
  'recovery.worker.skip',
] as const;

function buildRecentWorkerLogs(
  workerKind: string,
  persistence: WorkerStatusPersistence,
  actions: readonly WorkerActionRecord[],
): WorkerLogEntry[] {
  const actionLogs = actions.map(toWorkerActionLog);
  const eventLogs = workerKind === AUTO_FIX_WORKER_KIND
    ? listRecentAutoFixWorkerEvents(persistence).map((event) => toTaskEventLog(workerKind, event))
    : [];

  return [...actionLogs, ...eventLogs]
    .sort((a, b) => workerLogTimestamp(b).localeCompare(workerLogTimestamp(a)) || a.id.localeCompare(b.id))
    .slice(0, 10);
}

function listRecentAutoFixWorkerEvents(persistence: WorkerStatusPersistence): TaskEvent[] {
  if (persistence.listTaskEvents) {
    return persistence.listTaskEvents({
      eventTypes: AUTO_FIX_WORKER_EVENT_TYPES,
      sortBy: 'desc',
      limit: 10,
    });
  }

  const events: TaskEvent[] = [];
  for (const workflow of persistence.listWorkflows()) {
    for (const task of persistence.loadTasks(workflow.id)) {
      for (const event of persistence.getEvents(task.id, 'desc', 20)) {
        if (AUTO_FIX_WORKER_EVENT_TYPES.includes(event.eventType as typeof AUTO_FIX_WORKER_EVENT_TYPES[number])) {
          events.push(event);
        }
      }
    }
  }
  return events
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || String(b.id).localeCompare(String(a.id)))
    .slice(0, 10);
}

function toWorkerActionLog(action: WorkerActionRecord): WorkerLogEntry {
  return {
    id: action.id,
    workerKind: action.workerKind,
    source: 'worker_actions',
    actionType: action.actionType,
    ...(action.workflowId ? { workflowId: action.workflowId } : {}),
    ...(action.taskId ? { taskId: action.taskId } : {}),
    subjectType: action.subjectType,
    subjectId: action.subjectId,
    externalKey: action.externalKey,
    status: action.status,
    ...(action.summary ? { summary: action.summary } : {}),
    ...(action.payload !== undefined ? { payload: action.payload } : {}),
    createdAt: action.createdAt,
    updatedAt: action.updatedAt,
  };
}

function toTaskEventLog(workerKind: string, event: TaskEvent): WorkerLogEntry {
  return {
    id: String(event.id),
    workerKind,
    source: 'task_events',
    eventType: event.eventType,
    taskId: event.taskId,
    ...(event.payload !== undefined ? { payload: parseTaskEventPayload(event.payload) } : {}),
    createdAt: event.createdAt,
  };
}

function parseTaskEventPayload(payload: unknown): unknown {
  if (typeof payload !== 'string') return payload;
  try {
    return JSON.parse(payload);
  } catch {
    return payload;
  }
}

function workerLogTimestamp(log: WorkerLogEntry): string {
  return log.updatedAt ?? log.createdAt;
}

function toWorkerRecoverySummary(persistence: WorkerStatusPersistence): WorkerRecoverySummary {
  const status = collectRecoveryWorkerStatus(persistence);
  return {
    workerId: status.workerId,
    owner: status.owner,
    ...(status.lastWakeupAt ? { lastWakeupAt: status.lastWakeupAt } : {}),
    ...(status.lastScanAt ? { lastScanAt: status.lastScanAt } : {}),
    ...(status.lastSubmitAt ? { lastSubmitAt: status.lastSubmitAt } : {}),
    ...(status.lastSkipAt ? { lastSkipAt: status.lastSkipAt } : {}),
    ...(status.lastSkipReason ? { lastSkipReason: status.lastSkipReason } : {}),
    ...(status.lastSkipTaskId ? { lastSkipTaskId: status.lastSkipTaskId } : {}),
    wakeups: status.wakeups,
    scans: status.scans,
    submissions: status.submissions,
    skips: status.skips,
  };
}
