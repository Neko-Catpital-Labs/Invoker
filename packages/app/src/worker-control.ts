import type {
  WorkerActionSummary,
  WorkerPolicyStatus,
  WorkerRecoverySummary,
  WorkerStatusEntry,
  WorkerStatusSnapshot,
} from '@invoker/contracts';
import type { SQLiteAdapter, WorkerActionRecord } from '@invoker/data-store';
import {
  AUTO_FIX_WORKER_KIND,
  CI_FAILURE_WORKER_KIND,
  PR_STATUS_WORKER_KIND,
  type WorkerRegistry,
  type WorkerRuntime,
  type WorkerRuntimeDependencies,
} from '@invoker/execution-engine';

import { collectRecoveryWorkerStatus } from './recovery-worker-observability.js';

export const AUTO_STARTED_OWNER_WORKER_KINDS = [PR_STATUS_WORKER_KIND, CI_FAILURE_WORKER_KIND] as const;

export interface WorkerRuntimeController {
  startAutoStartedWorkers(): void;
  start(kind: string): WorkerStatusEntry;
  stop(kind: string): Promise<WorkerStatusEntry>;
  stopAll(): Promise<void>;
  snapshot(): WorkerStatusSnapshot;
}

type WorkerStatusPersistence = Pick<SQLiteAdapter, 'listWorkerActions' | 'listWorkflows' | 'loadTasks' | 'getEvents'>;

interface RuntimeHandle {
  runtime: WorkerRuntime;
  startedAt: string;
  stoppedAt?: string;
}

const BUILT_IN_WORKER_KINDS = new Set<string>([
  AUTO_FIX_WORKER_KIND,
  PR_STATUS_WORKER_KIND,
  CI_FAILURE_WORKER_KIND,
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


  const rowForKind = (kind: string): WorkerStatusEntry => {
    const definition = options.registry.get(kind);
    if (!definition) {
      throw new Error(`Unknown worker kind: "${kind}"`);
    }
    return buildWorkerStatusEntry({
      definitionKind: definition.kind,
      note: definition.note,
      handle: handles.get(kind),
      stoppedAt: stoppedAtByKind.get(kind),
      autoStarts: options.autoStartKinds.includes(kind),
      policy: policyForKind(kind),
      persistence: options.persistence,
      canControl: options.canControl(),
    });
  };

  const stopHandle = async (kind: string, handle: RuntimeHandle): Promise<void> => {
    await handle.runtime.stop();
    const stoppedAt = new Date().toISOString();
    stoppedAtByKind.set(kind, stoppedAt);
    handles.delete(kind);
  };

  return {
    startAutoStartedWorkers(): void {
      for (const kind of options.autoStartKinds) {
        if (!options.registry.get(kind)) continue;
        this.start(kind);
      }
    },

    start(kind: string): WorkerStatusEntry {
      const definition = requireDefinition(kind);

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
      const handle = handles.get(kind);
      if (!handle) {
        return rowForKind(kind);
      }
      await stopHandle(kind, handle);
      return rowForKind(kind);
    },

    async stopAll(): Promise<void> {
      const stopping = [...handles.entries()].map(([kind, handle]) => stopHandle(kind, handle).catch(() => undefined));
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
  return {
    generatedAt: new Date().toISOString(),
    workers: options.registry.list().map((definition) => buildWorkerStatusEntry({
      definitionKind: definition.kind,
      note: definition.note,
      autoStarts: options.autoStartKinds.includes(definition.kind),
      policy: 'unknown',
      persistence: options.persistence,
      canControl: false,
    })),
  };
}


function buildWorkerStatusEntry(args: {
  definitionKind: string;
  note: string;
  handle?: RuntimeHandle;
  stoppedAt?: string;
  autoStarts: boolean;
  policy: WorkerPolicyStatus;
  persistence: WorkerStatusPersistence;
  canControl: boolean;
}): WorkerStatusEntry {
  const lifecycle = args.handle
    ? args.handle.runtime.isRunning() ? 'running' : 'exited'
    : 'stopped';
  const controlDisabledReason = getControlDisabledReason(args.canControl);
  const runtime = args.handle?.runtime;
  return {
    kind: args.definitionKind,
    note: args.note,
    ...(runtime ? { runtimeKind: runtime.identity.kind, instanceId: runtime.identity.instanceId } : {}),
    lifecycle,
    policy: args.policy,
    autoStarts: args.autoStarts,
    startable: lifecycle !== 'running' && args.policy !== 'disabled' && args.canControl,
    stoppable: lifecycle === 'running' && args.canControl,
    ...(controlDisabledReason ? { controlDisabledReason } : {}),
    ...(args.handle?.startedAt ? { startedAt: args.handle.startedAt } : {}),
    ...(args.stoppedAt ? { stoppedAt: args.stoppedAt } : {}),
    recentActions: args.persistence.listWorkerActions({ workerKind: args.definitionKind, limit: 5 }).map(toWorkerActionSummary),
    ...(args.definitionKind === AUTO_FIX_WORKER_KIND ? { recovery: toWorkerRecoverySummary(args.persistence) } : {}),
  };
}

function policyForKind(kind: string): WorkerPolicyStatus {
  if (BUILT_IN_WORKER_KINDS.has(kind)) return 'enabled';
  return 'unknown';
}

function getControlDisabledReason(canControl: boolean): string | undefined {
  if (!canControl) return 'Controls unavailable';
  return undefined;
}

function toWorkerActionSummary(action: WorkerActionRecord): WorkerActionSummary {
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
    createdAt: action.createdAt,
    updatedAt: action.updatedAt,
    ...(action.completedAt ? { completedAt: action.completedAt } : {}),
  };
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
