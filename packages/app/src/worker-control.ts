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
  CLAUDE_OAUTH_REFRESH_WORKER_KIND,
  DISK_HEADROOM_WORKER_KIND,
  E2E_AUTOFIX_WORKER_KIND,
  IDLE_TASK_CLEANUP_WORKER_KIND,
  CROSS_REPO_RESEARCH_WORKER_KIND,
  INFRA_REPAIR_WORKER_KIND,
  PR_ADMIN_BYPASS_LAND_WORKER_KIND,
  PR_AUTO_LABEL_WORKER_KIND,
  PR_DUPLICATE_CLOSE_WORKER_KIND,
  PR_ORPHAN_REPAIR_WORKER_KIND,
  PR_STATUS_WORKER_KIND,
  REAPER_WORKER_KIND,
  REQUEUE_WORKER_KIND,
  WORKFLOW_RESUME_WORKER_KIND,
  type WorkerRegistry,
  type WorkerRuntime,
  type WorkerRuntimeDependencies,
} from '@invoker/execution-engine';
import { SLACK_BUG_SCAN_WORKER_KIND } from '@invoker/slack-bug-scan';
import { collectRecoveryWorkerStatus } from './recovery-worker-observability.js';

/**
 * Worker kinds auto-started on every owner boot.
 * Per-worker SQLite `worker_desired_states` still overrides in both directions.
 * InvokerConfig must not contain a boolean that auto-starts or stops a worker.
 */
export const ALWAYS_AUTO_STARTED_OWNER_WORKER_KINDS = [
  PR_STATUS_WORKER_KIND,
  CLAUDE_OAUTH_REFRESH_WORKER_KIND,
  DISK_HEADROOM_WORKER_KIND,
  AUTO_APPROVE_WORKER_KIND,
] as const;

/**
 * PR-maintenance worker kinds written by the onboarding / `worker toggles`
 * `pr-maintenance` preset. Not part of the code always-on boot list.
 */
export const PR_MAINTENANCE_AUTO_STARTED_WORKER_KINDS = [
  PR_ADMIN_BYPASS_LAND_WORKER_KIND,
  PR_ORPHAN_REPAIR_WORKER_KIND,
  PR_DUPLICATE_CLOSE_WORKER_KIND,
  PR_AUTO_LABEL_WORKER_KIND,
] as const;

export const SLACK_BUG_SCAN_AUTO_STARTED_WORKER_KINDS = [
  SLACK_BUG_SCAN_WORKER_KIND,
] as const;

/**
 * Legacy config booleans that used to gate worker auto-start. Read only by
 * one-shot migration into `worker_desired_states`; ignored for boot thereafter.
 */
export type LegacyWorkerStartConfigFlags = {
  prMaintenance?: { enabled?: boolean };
  slackBugScan?: { enabled?: boolean };
  infraRepair?: { enabled?: boolean };
  autofix?: { enabled?: boolean };
  e2eAutoFixEnabled?: boolean;
  reaper?: { enabled?: boolean };
  workflowResume?: { enabled?: boolean };
  requeueEnabled?: boolean;
  staleTaskCleanup?: { enabled?: boolean };
  claudeOauthRefresh?: { enabled?: boolean };
};

type WorkerDesiredStatePersistence = Pick<
  SQLiteAdapter,
  'getWorkerDesiredState' | 'setWorkerDesiredState'
>;

/**
 * Map leftover config start flags onto worker kinds for one-shot migration.
 * Policy flags (`autoApproveAIFixes`, `diskHeadroom.cleanupEnabled`) are not
 * start flags and are not included.
 */
export function legacyWorkerStartFlagSeeds(
  config: LegacyWorkerStartConfigFlags,
): ReadonlyArray<{ workerKind: string; desiredEnabled: boolean }> {
  const seeds: Array<{ workerKind: string; desiredEnabled: boolean }> = [];
  const push = (workerKind: string, desiredEnabled: boolean): void => {
    seeds.push({ workerKind, desiredEnabled });
  };

  if (config.prMaintenance?.enabled === true) {
    for (const workerKind of PR_MAINTENANCE_AUTO_STARTED_WORKER_KINDS) {
      push(workerKind, true);
    }
  }
  if (config.slackBugScan?.enabled === true) {
    push(SLACK_BUG_SCAN_WORKER_KIND, true);
  }
  if (config.infraRepair?.enabled === true) {
    push(INFRA_REPAIR_WORKER_KIND, true);
  }
  if (config.autofix?.enabled === true) {
    push(AUTO_FIX_WORKER_KIND, true);
  }
  if (config.e2eAutoFixEnabled === true) {
    push(E2E_AUTOFIX_WORKER_KIND, true);
  }
  if (config.reaper?.enabled === true) {
    push(REAPER_WORKER_KIND, true);
  }
  if (config.workflowResume?.enabled === true) {
    push(WORKFLOW_RESUME_WORKER_KIND, true);
  }
  if (config.requeueEnabled === true) {
    push(REQUEUE_WORKER_KIND, true);
  }
  if (config.staleTaskCleanup?.enabled === true) {
    push(IDLE_TASK_CLEANUP_WORKER_KIND, true);
  }
  // Default was on (`!== false`); only an explicit false needs a desired-state row.
  if (config.claudeOauthRefresh?.enabled === false) {
    push(CLAUDE_OAUTH_REFRESH_WORKER_KIND, false);
  }

  return seeds;
}

/**
 * One-shot: seed missing `worker_desired_states` rows from leftover config
 * start flags so existing owners keep the workers they already had enabled.
 * Never overwrites an existing desired-state row. Config flags are ignored
 * for auto-start after this runs.
 */
export function migrateWorkerDesiredStateFromLegacyConfig(
  persistence: WorkerDesiredStatePersistence,
  config: LegacyWorkerStartConfigFlags,
): ReadonlyArray<{ workerKind: string; desiredEnabled: boolean }> {
  const seeded: Array<{ workerKind: string; desiredEnabled: boolean }> = [];
  for (const seed of legacyWorkerStartFlagSeeds(config)) {
    if (persistence.getWorkerDesiredState(seed.workerKind) !== undefined) {
      continue;
    }
    persistence.setWorkerDesiredState(seed.workerKind, seed.desiredEnabled);
    seeded.push(seed);
  }
  return seeded;
}

/** Code always-on boot list. Desired state remains the overlay. */
export function autoStartedOwnerWorkerKinds(): readonly string[] {
  return [...ALWAYS_AUTO_STARTED_OWNER_WORKER_KINDS];
}

/**
 * Boot auto-start list. Config booleans are ignored — on/off lives in
 * `worker_desired_states` (plus the code always-on list). The unused
 * `_config` parameter is kept so existing call sites compile unchanged.
 */
export function autoStartedOwnerWorkerKindsForConfig(
  _config?: unknown,
): readonly string[] {
  return autoStartedOwnerWorkerKinds();
}

export interface WorkerRuntimeController {
  startAutoStartedWorkers(): void;
  start(kind: string, options?: { persistDesiredState?: boolean; source?: string }): WorkerStatusEntry;
  stop(kind: string, options?: { source?: string }): Promise<WorkerStatusEntry>;
  stopAll(): Promise<void>;
  snapshot(): WorkerStatusSnapshot;
}

export function createOwnerWorkerStatusReader(options: {
  queryOwner: () => Promise<WorkerStatusSnapshot>;
  createUnavailableSnapshot: () => WorkerStatusSnapshot;
  now?: () => string;
  onUnavailable?: (error: unknown) => void;
}): () => Promise<WorkerStatusSnapshot> {
  let latestSuccessfulSnapshot: WorkerStatusSnapshot | null = null;
  const now = options.now ?? (() => new Date().toISOString());

  return async () => {
    try {
      const ownerSnapshot = await options.queryOwner();
      const {
        authority: _authority,
        lastSuccessfulAt: _lastSuccessfulAt,
        unavailableReason: _unavailableReason,
        ...snapshot
      } = ownerSnapshot;
      const liveSnapshot: WorkerStatusSnapshot = {
        ...snapshot,
        authority: 'live',
        lastSuccessfulAt: now(),
      };
      latestSuccessfulSnapshot = liveSnapshot;
      return liveSnapshot;
    } catch (error) {
      options.onUnavailable?.(error);
      const unavailableReason = error instanceof Error ? error.message : String(error);
      if (latestSuccessfulSnapshot) {
        return {
          ...latestSuccessfulSnapshot,
          authority: 'cached',
          unavailableReason,
        };
      }
      const {
        authority: _authority,
        lastSuccessfulAt: _lastSuccessfulAt,
        unavailableReason: _unavailableReason,
        workers: _workers,
        ...snapshot
      } = options.createUnavailableSnapshot();
      return {
        ...snapshot,
        workers: [],
        authority: 'unavailable',
        unavailableReason,
      };
    }
  };
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
const WORKER_STATUS_SNAPSHOT_CACHE_MS = 1000;

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
  INFRA_REPAIR_WORKER_KIND,
  DISK_HEADROOM_WORKER_KIND,
  E2E_AUTOFIX_WORKER_KIND,
  REQUEUE_WORKER_KIND,
  AUTO_APPROVE_WORKER_KIND,
  PR_ADMIN_BYPASS_LAND_WORKER_KIND,
  PR_ORPHAN_REPAIR_WORKER_KIND,
  PR_DUPLICATE_CLOSE_WORKER_KIND,
  PR_AUTO_LABEL_WORKER_KIND,
  REAPER_WORKER_KIND,
  WORKFLOW_RESUME_WORKER_KIND,
  SLACK_BUG_SCAN_WORKER_KIND,
  CROSS_REPO_RESEARCH_WORKER_KIND,
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
  let cachedSnapshot: { at: number; value: WorkerStatusSnapshot } | null = null;

  const invalidateSnapshot = (): void => {
    cachedSnapshot = null;
  };

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

  const persistDesiredState = (kind: string, desiredEnabled: boolean, source: string): void => {
    if (!options.persistence.setWorkerDesiredState) return;
    const previous = options.persistence.getWorkerDesiredState?.(kind);
    const saved = options.persistence.setWorkerDesiredState(kind, desiredEnabled);
    options.deps.logger.info('[worker-control] persisted desired state change', {
      module: 'worker-control',
      workerKind: kind,
      source,
      previousDesiredEnabled: previous?.desiredEnabled,
      desiredEnabled,
      persistedUpdatedAt: saved?.updatedAt,
    });
  };

  const rowForKind = (kind: string): WorkerStatusEntry => {
    const definition = options.registry.get(kind);
    if (!definition) {
      throw new Error(`Unknown worker kind: "${kind}"`);
    }
    const desiredEnabled = desiredEnabledForKind(kind);
    const configuredAutoStart = options.autoStartKinds.includes(kind);
    const saved = options.persistence.getWorkerDesiredState?.(kind);
    return buildWorkerStatusEntry({
      definitionKind: definition.kind,
      note: definition.note,
      source: sourceForDefinition(definition),
      handle: handles.get(kind),
      stoppedAt: stoppedAtByKind.get(kind),
      autoStarts: desiredEnabled,
      desiredEnabled,
      configuredAutoStart,
      suppressedByPersistedStop: configuredAutoStart && saved?.desiredEnabled === false,
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
        const saved = options.persistence.getWorkerDesiredState?.(definition.kind);
        if (
          saved?.desiredEnabled === false
          && options.autoStartKinds.includes(definition.kind)
        ) {
          options.deps.logger.warn(
            '[worker-control] configured auto-start suppressed by persisted desired state',
            {
              module: 'worker-control',
              workerKind: definition.kind,
              configuredAutoStart: true,
              persistedDesiredEnabled: false,
              persistedUpdatedAt: saved.updatedAt,
            },
          );
        }
        if (!desiredEnabledForKind(definition.kind)) continue;
        this.start(definition.kind, { persistDesiredState: false });
      }
    },

    start(kind: string, optionsArg?: { persistDesiredState?: boolean; source?: string }): WorkerStatusEntry {
      const definition = requireDefinition(kind);
      if (optionsArg?.persistDesiredState !== false) {
        persistDesiredState(kind, true, optionsArg?.source ?? 'controller-api');
      }
      invalidateSnapshot();

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
      invalidateSnapshot();
      return rowForKind(kind);
    },
    async stop(kind: string, optionsArg?: { source?: string }): Promise<WorkerStatusEntry> {
      requireDefinition(kind);
      persistDesiredState(kind, false, optionsArg?.source ?? 'controller-api');
      invalidateSnapshot();
      const handle = handles.get(kind);
      if (!handle) {
        return rowForKind(kind);
      }
      await stopHandle(kind, handle);
      invalidateSnapshot();
      return rowForKind(kind);
    },

    async stopAll(): Promise<void> {
      const stopping = [...handles.entries()].map(([kind, handle]) =>
        stopHandle(kind, handle, STOP_ALL_SETTLE_TIMEOUT_MS).catch(() => undefined),
      );
      await Promise.all(stopping);
      invalidateSnapshot();
    },

    snapshot(): WorkerStatusSnapshot {
      const now = Date.now();
      if (cachedSnapshot && now - cachedSnapshot.at >= 0 && now - cachedSnapshot.at < WORKER_STATUS_SNAPSHOT_CACHE_MS) {
        return cachedSnapshot.value;
      }
      const value = {
        generatedAt: new Date().toISOString(),
        workers: options.registry.list().map((definition) => rowForKind(definition.kind)),
      };
      cachedSnapshot = { at: now, value };
      return value;
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
      const saved = options.persistence.getWorkerDesiredState?.(definition.kind);
      const configuredAutoStart = options.autoStartKinds.includes(definition.kind);
      const desiredEnabled = saved?.desiredEnabled ?? configuredAutoStart;
      return buildWorkerStatusEntry({
        definitionKind: definition.kind,
        note: definition.note,
        source: sourceForDefinition(definition),
        autoStarts: desiredEnabled,
        desiredEnabled,
        configuredAutoStart,
        suppressedByPersistedStop: configuredAutoStart && saved?.desiredEnabled === false,
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
  configuredAutoStart?: boolean;
  suppressedByPersistedStop?: boolean;
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
    ...(args.configuredAutoStart !== undefined ? { configuredAutoStart: args.configuredAutoStart } : {}),
    ...(args.suppressedByPersistedStop ? { suppressedByPersistedStop: true } : {}),
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
  const payloadRecord = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : undefined;
  const rawReason = payloadRecord?.reason;
  const reason = typeof rawReason === 'string' && rawReason.length > 0 ? rawReason : undefined;
  const outcomeClass = typeof payloadRecord?.outcomeClass === 'string' ? payloadRecord.outcomeClass : undefined;
  const decisionOutcome = typeof payloadRecord?.decisionOutcome === 'string'
    ? payloadRecord.decisionOutcome
    : undefined;
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
    ...(outcomeClass ? { outcomeClass } : {}),
    ...(decisionOutcome ? { decisionOutcome } : {}),
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
