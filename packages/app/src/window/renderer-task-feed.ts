import type { BrowserWindow } from 'electron';
import type { Logger, WorkResponse } from '@invoker/contracts';
import type { Workflow } from '@invoker/data-store';
import { Channels, type MessageBus } from '@invoker/transport';
import type { TaskDelta, TaskState } from '@invoker/workflow-core';
import {
  applyDelta,
  recoverQuarantinedTask,
  recoveryFound,
  recoveryMissing,
  recoveryUnavailable,
  TaskSnapshotCache,
  type RecoveryLookupResult,
} from '../delta-merge.js';
import { evaluateExecutingStall, taskNeedsExecutingStallCheck } from '../executing-stall.js';
import { persistShutdownDiagnostic, type ShutdownDiagnosticDb } from '../shutdown-diagnostic.js';
import type { TaskGraphEventPublisher } from '../task-graph-event-publisher.js';
import type { TaskOutputData } from '../types.js';
import { seedTaskCachesFromSnapshot } from '../viewer-cache-hydration.js';
import { WorkflowRollupProjection } from '../workflow-rollup-projection.js';

export type RendererTaskFeedTimer = NodeJS.Timeout;

export interface RendererTaskFeedStopHandle {
  stop(): void;
}

export interface RendererTaskFeedAttempt {
  leaseExpiresAt?: unknown;
  lastHeartbeatAt?: unknown;
  status?: string;
}

export interface RendererTaskFeedPersistence extends ShutdownDiagnosticDb {
  listWorkflows(): Workflow[];
  loadTasks(workflowId: string): TaskState[];
  loadTask(taskId: string): TaskState | undefined;
  loadAttempt?(attemptId: string): RendererTaskFeedAttempt | undefined;
  writeActivityLog(source: string, level: string, message: string): void;
  appendOutputChunk(taskId: string, data: string): void;
}

export interface RendererTaskFeedOrchestrator {
  getAllTasks(): TaskState[];
  getMergeNode(workflowId: string): TaskState | undefined;
  syncAllFromDb(): void;
  handleWorkerResponse(response: WorkResponse): void;
  reclaimStalledFixSession(
    taskId: string,
    options: {
      reason: string;
      expectedLineage: {
        taskId: string;
        selectedAttemptId: string | undefined;
        generation: number;
      };
    },
  ): unknown;
}

export interface RendererTaskFeedUiPerfStats {
  mainDeltaToUi: number;
  dbPollCreated: number;
  dbPollUpdatedAsCreated: number;
  workflowMetadataPublishes: number;
  workflowMetadataCoalescedRequests: number;
  [key: string]: number;
}

export interface RendererTaskFeedDeps {
  logger: Logger;
  persistence: RendererTaskFeedPersistence;
  messageBus: Pick<MessageBus, 'publish' | 'request'>;
  getOrchestrator: () => RendererTaskFeedOrchestrator;
  taskHandles: { has(taskId: string): boolean };
  taskGraphEventPublisher: Pick<TaskGraphEventPublisher, 'publishDelta'>;
  getMainWindow: () => BrowserWindow | null;
  setStartupWorkflowId: (workflowId: string | null) => void;
  requestWorkflowMetadataPublish: (reason: string) => void;
  scheduleAutoFix: (taskId: string) => void;
  logAutoFixDebug: (taskId: string, phase: string, details?: Record<string, unknown>) => void;
  uiPerfStats: RendererTaskFeedUiPerfStats;
  traceUiDeltaFlow: boolean;
  traceDbPollPerTask: boolean;
  traceTaskOutput: boolean;
  executingStallTimeoutMs: number;
  pollLaunchDispatcher: () => void;
}

export interface RendererTaskFeed {
  enqueueTaskOutput(taskId: string, data: string): void;
  flushTaskOutput(taskId: string): void;
  seedUiSnapshotCache(): void;
  getDetachedViewerTasks(): TaskState[];
  publishTaskDeltaToRenderer(delta: TaskDelta): void;
  getLastKnownWorkflowCount(): number;
  setLastKnownWorkflowCount(count: number): void;
  getTaskSnapshot(taskId: string): string | undefined;
  listKnownTaskIds(): string[];
  clearTaskSnapshots(): void;
  replaceWorkflowRollups(tasks: TaskState[]): void;
  rememberTaskState(task: TaskState): void;
  resetSnapshotState(): void;
  receiveTaskDelta(delta: TaskDelta): void;
  startDbPolling(): RendererTaskFeedStopHandle;
  startActivityPolling(): RendererTaskFeedStopHandle;
}

export function createRendererTaskFeed(deps: RendererTaskFeedDeps): RendererTaskFeed {
  const lastKnownTaskStates = new TaskSnapshotCache();
  const workflowRollupProjection = new WorkflowRollupProjection();
  const pendingOutputBuffers = new Map<string, string[]>();
  const outputFlushTimers = new Map<string, RendererTaskFeedTimer>();
  const pendingOwnerRecoveries = new Map<string, Promise<void>>();
  let lastKnownWorkflowCount = 0;
  const isReadOnlyViewer = (): boolean => (
    (deps.persistence as RendererTaskFeedPersistence & { readOnly?: boolean }).readOnly === true
  );

  const flushTaskOutput = (taskId: string): void => {
    const timer = outputFlushTimers.get(taskId);
    if (timer) {
      clearTimeout(timer);
      outputFlushTimers.delete(taskId);
    }
    const chunks = pendingOutputBuffers.get(taskId);
    if (!chunks || chunks.length === 0) {
      return;
    }
    pendingOutputBuffers.delete(taskId);
    const data = chunks.join('');
    if (deps.traceTaskOutput) {
      deps.logger.info(`${taskId}: ${data.trimEnd()}`, { module: 'output' });
    }
    const outputData: TaskOutputData = { taskId, data };
    deps.messageBus.publish(Channels.TASK_OUTPUT, outputData);
    try {
      // Runner stream chunks land in the output spool only — task_output is
      // reserved for explicit diagnostic writes (workflow actions, shutdown).
      deps.persistence.appendOutputChunk(taskId, data);
    } catch (err) {
      deps.logger.error(`Failed to persist output for ${taskId}: ${err}`, { module: 'output' });
    }
  };

  const enqueueTaskOutput = (taskId: string, data: string): void => {
    const chunks = pendingOutputBuffers.get(taskId) ?? [];
    chunks.push(data);
    pendingOutputBuffers.set(taskId, chunks);
    if (outputFlushTimers.has(taskId)) {
      return;
    }
    const timer = setTimeout(() => flushTaskOutput(taskId), 100);
    timer.unref?.();
    outputFlushTimers.set(taskId, timer);
  };

  const publishTaskDeltaToRenderer = (delta: TaskDelta): void => {
    const workflowRollups = workflowRollupProjection.applyDelta(delta);
    deps.taskGraphEventPublisher.publishDelta(delta, workflowRollups);
  };

  const isTaskStateForRecovery = (value: unknown, taskId: string): value is TaskState => (
    typeof value === 'object' &&
    value !== null &&
    (value as { id?: unknown }).id === taskId
  );

  const lookupLocalTaskForRecovery = (taskId: string): RecoveryLookupResult => {
    if (isReadOnlyViewer()) {
      return recoveryUnavailable('detached-viewer-local-read-is-not-authoritative');
    }
    try {
      const task = deps.persistence.loadTask(taskId);
      return task ? recoveryFound(task) : recoveryMissing();
    } catch (err) {
      return recoveryUnavailable(err instanceof Error ? err.message : String(err));
    }
  };

  const lookupLocalMergeNodeForRecovery = (workflowId: string): RecoveryLookupResult => {
    if (isReadOnlyViewer()) {
      return recoveryUnavailable('detached-viewer-orchestrator-is-not-authoritative');
    }
    try {
      const task = deps.getOrchestrator().getMergeNode(workflowId);
      return task ? recoveryFound(task) : recoveryMissing();
    } catch (err) {
      return recoveryUnavailable(err instanceof Error ? err.message : String(err));
    }
  };

  const lookupOwnerTaskForRecovery = async (taskId: string): Promise<RecoveryLookupResult> => {
    let taskByIdMissing = false;
    let taskByIdUnavailableReason: string | undefined;

    try {
      const response = await deps.messageBus.request<
        { kind: 'task-by-id'; taskId: string },
        { task?: unknown | null }
      >('headless.query', { kind: 'task-by-id', taskId });
      if (isTaskStateForRecovery(response?.task, taskId)) {
        return recoveryFound(response.task);
      }
      if (response && Object.prototype.hasOwnProperty.call(response, 'task') && response.task == null) {
        taskByIdMissing = true;
      } else {
        taskByIdUnavailableReason = 'owner task-by-id returned malformed response';
      }
    } catch (err) {
      taskByIdUnavailableReason = err instanceof Error ? err.message : String(err);
    }

    try {
      const snapshot = await deps.messageBus.request<
        { kind: 'task-graph-refresh' },
        { tasks?: unknown[] }
      >('headless.query', { kind: 'task-graph-refresh' });
      const task = Array.isArray(snapshot?.tasks)
        ? snapshot.tasks.find((candidate) => isTaskStateForRecovery(candidate, taskId))
        : undefined;
      if (isTaskStateForRecovery(task, taskId)) {
        return recoveryFound(task);
      }
      if (Array.isArray(snapshot?.tasks)) {
        return recoveryMissing();
      }
    } catch (err) {
      if (taskByIdMissing) return recoveryMissing();
      const reason = err instanceof Error ? err.message : String(err);
      return recoveryUnavailable(taskByIdUnavailableReason ?? reason);
    }

    return taskByIdMissing
      ? recoveryMissing()
      : recoveryUnavailable(taskByIdUnavailableReason ?? 'owner task snapshot unavailable');
  };

  const applySingleLookupRecovery = (taskId: string, lookup: RecoveryLookupResult) =>
    recoverQuarantinedTask(lastKnownTaskStates, taskId, {
      loadTask: () => lookup,
      getMergeNode: () => lookup,
    });

  const scheduleOwnerRecovery = (taskId: string, reason?: string): void => {
    if (pendingOwnerRecoveries.has(taskId)) return;
    const recovery = (async () => {
      deps.logger.info(
        `[gap-detect] task="${taskId}" local recovery unavailable${reason ? `: ${reason}` : ''}; querying owner`,
        { module: 'delta-merge' },
      );
      const lookup = await lookupOwnerTaskForRecovery(taskId);
      const entry = lastKnownTaskStates.getEntry(taskId);
      if (entry && !entry.quarantined) {
        return;
      }
      const { rendererDelta, outcome, reason: ownerReason } = applySingleLookupRecovery(taskId, lookup);
      if (rendererDelta) {
        publishTaskDeltaToRenderer(rendererDelta);
        return;
      }
      deps.logger.warn(
        `[gap-detect] task="${taskId}" owner recovery unavailable${ownerReason ? `: ${ownerReason}` : ''}; keeping task quarantined`,
        { module: 'delta-merge', outcome },
      );
    })().catch((err) => {
      deps.logger.warn(
        `[gap-detect] task="${taskId}" owner recovery failed: ${err instanceof Error ? err.message : String(err)}`,
        { module: 'delta-merge' },
      );
    }).finally(() => {
      pendingOwnerRecoveries.delete(taskId);
    });
    pendingOwnerRecoveries.set(taskId, recovery);
  };

  const applyTaskDeltaToOwnerCacheOrRecover = (delta: TaskDelta): TaskDelta[] => {
    const { quarantined, accepted } = applyDelta(delta, lastKnownTaskStates);
    if (quarantined.length === 0) {
      return accepted ? [delta] : [];
    }

    const rendererDeltas: TaskDelta[] = [];
    for (const taskId of quarantined) {
      deps.logger.info(`[gap-detect] quarantined task="${taskId}" — triggering authoritative reload`, { module: 'delta-merge' });
      const { rendererDelta, outcome, reason } = recoverQuarantinedTask(lastKnownTaskStates, taskId, {
        loadTask: lookupLocalTaskForRecovery,
        getMergeNode: lookupLocalMergeNodeForRecovery,
      });
      if (rendererDelta) {
        rendererDeltas.push(rendererDelta);
      } else if (outcome === 'unavailable') {
        scheduleOwnerRecovery(taskId, reason);
      }
    }
    return rendererDeltas;
  };

  const seedUiSnapshotCache = (): void => {
    lastKnownWorkflowCount = deps.persistence.listWorkflows().length;
    seedTaskCachesFromSnapshot(deps.getOrchestrator().getAllTasks(), { lastKnownTaskStates, workflowRollupProjection });
  };

  // Current task states for the detached viewer's bootstrap getter, derived from
  // the same cache owner mode uses for delta gap recovery.
  const getDetachedViewerTasks = (): TaskState[] => [...lastKnownTaskStates.keys()].map(
    (taskId) => JSON.parse(lastKnownTaskStates.get(taskId) ?? '{}') as TaskState,
  );

  const processIncomingTaskDelta = (delta: TaskDelta): void => {
    deps.uiPerfStats.mainDeltaToUi += 1;
    if (deps.traceUiDeltaFlow) {
      deps.logger.debug(`delta→ui: ${JSON.stringify(delta)}`, { module: 'ui' });
    }
    for (const rendererDelta of applyTaskDeltaToOwnerCacheOrRecover(delta)) {
      publishTaskDeltaToRenderer(rendererDelta);
    }
  };

  const parseExecutionDate = (value: unknown): Date | undefined => {
    if (!value) return undefined;
    if (value instanceof Date) return value;
    if (typeof value !== 'string') return undefined;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
  };

  const startDbPolling = (): RendererTaskFeedStopHandle => {
    const interval = setInterval(() => {
      const mainWindow = deps.getMainWindow();
      if (!mainWindow || mainWindow.isDestroyed()) return;
      try {
        const workflows = deps.persistence.listWorkflows();

        if (workflows.length !== lastKnownWorkflowCount) {
          const msg = `Workflow count changed: ${lastKnownWorkflowCount} → ${workflows.length}`;
          deps.logger.info(msg, { module: 'db-poll' });
          try { deps.persistence.writeActivityLog('db-poll', 'info', msg); } catch { /* db locked */ }
          lastKnownWorkflowCount = workflows.length;
          deps.requestWorkflowMetadataPublish('db-poll-count');

          deps.getOrchestrator().syncAllFromDb();
          deps.logger.info(`Synced orchestrator for all ${workflows.length} workflows`, { module: 'db-poll' });
        }

        for (const workflow of workflows) {
          if (workflow.status === 'completed' || workflow.status === 'failed') continue;
          const tasks = deps.persistence.loadTasks(workflow.id);
          for (const loadedTask of tasks) {
            const task = loadedTask;
            const now = new Date();
            const previousHeartbeat = parseExecutionDate(task.execution.lastHeartbeatAt);
            const selectedAttempt = taskNeedsExecutingStallCheck(task) && task.execution.selectedAttemptId
              ? deps.persistence.loadAttempt?.(task.execution.selectedAttemptId)
              : undefined;
            const leaseExpiresAt = parseExecutionDate(selectedAttempt?.leaseExpiresAt);
            const remoteHeartbeat = parseExecutionDate(task.execution.remoteHeartbeatAt);

            if (task.status === 'running' || ((task.status === 'pending' || task.status === 'queued') && task.execution.phase === 'launching')) {
              // CC.1: launch-stall watchdog removed. The
              // LaunchDispatcher's reapExpiredLeases /
              // abandonStuckLeases reapers (Phase B, CB.3) are the
              // sole recovery path for stalled launch claims.
              const executingStartedAt = parseExecutionDate(task.execution.startedAt);
              const executingAgeMs = executingStartedAt ? now.getTime() - executingStartedAt.getTime() : 0;
              const { heartbeatStale, leaseExpired, executingStalled, staleReason } = evaluateExecutingStall({
                now,
                phase: task.execution.phase,
                runnerKind: task.config.runnerKind,
                executingStartedAt,
                leaseExpiresAt,
                executorHeartbeatAt: previousHeartbeat,
                remoteHeartbeatAt: remoteHeartbeat,
                executingStallTimeoutMs: deps.executingStallTimeoutMs,
              });

              if (executingStalled) {
                const selectedAttemptHeartbeat = parseExecutionDate(selectedAttempt?.lastHeartbeatAt);
                const executingError =
                  `Execution stalled: task remained in running/executing for ${Math.floor(executingAgeMs / 1000)}s ` +
                  `without a live execution handle and no completion signal from executor (${staleReason}).`;
                deps.logger.info(
                  `[executing-stall] detected task="${task.id}" phase=${task.execution.phase} executingAgeMs=${executingAgeMs} ` +
                    `handlePresent=${deps.taskHandles.has(task.id)} leaseExpired=${leaseExpired} heartbeatStale=${heartbeatStale} ` +
                    `runnerKind=${task.config.runnerKind ?? 'none'} selectedAttemptId=${task.execution.selectedAttemptId ?? 'none'} ` +
                    `attemptStatus=${selectedAttempt?.status ?? 'none'} executorHeartbeatAt=${previousHeartbeat?.toISOString() ?? 'none'} ` +
                    `remoteHeartbeatAt=${remoteHeartbeat?.toISOString() ?? 'none'} attemptHeartbeatAt=${selectedAttemptHeartbeat?.toISOString() ?? 'none'} ` +
                    `leaseExpiresAt=${leaseExpiresAt?.toISOString() ?? 'none'} launchStartedAt=${task.execution.launchStartedAt instanceof Date ? task.execution.launchStartedAt.toISOString() : task.execution.launchStartedAt ?? 'none'} ` +
                    `launchCompletedAt=${task.execution.launchCompletedAt instanceof Date ? task.execution.launchCompletedAt.toISOString() : task.execution.launchCompletedAt ?? 'none'} ` +
                    `startedAt=${executingStartedAt?.toISOString() ?? 'none'} completedAt=${task.execution.completedAt instanceof Date ? task.execution.completedAt.toISOString() : task.execution.completedAt ?? 'none'}`,
                  { module: 'db-poll' },
                );
                const failedResponse: WorkResponse = {
                  requestId: `executing-stall-${task.id}-${now.getTime()}`,
                  actionId: task.id,
                  attemptId: task.execution.selectedAttemptId,
                  executionGeneration: task.execution.generation ?? 0,
                  status: 'failed',
                  outputs: {
                    exitCode: 1,
                    error: executingError,
                    failureClass: 'liveness_stall',
                  },
                };
                deps.logger.error(`[executing-stall] forcing failure for "${task.id}": ${executingError}`, { module: 'db-poll' });
                persistShutdownDiagnostic(task, deps.persistence, {
                  flushPendingOutput: flushTaskOutput,
                  forcedStopReason: executingError,
                  label: task.execution.phase === 'launching'
                    ? 'Startup Failure Diagnostic'
                    : 'Shutdown Diagnostic',
                });
                deps.getOrchestrator().handleWorkerResponse(failedResponse);
                continue;
              }
            }

            // Stalled-fix-session watchdog: a fix session whose owner died
            // mid-fix (heartbeat stopped, attempt lease expired) is invisible
            // to the running-task path above because its status is
            // `fixing_with_ai`, not `running`. Evaluate it as an executing
            // task; a live fix refreshes its lease every 30s via
            // withAttemptHeartbeat, so only an orphaned one is ever stalled.
            if (task.status === 'fixing_with_ai') {
              const fixStartedAt = parseExecutionDate(task.execution.startedAt);
              const { executingStalled, staleReason } = evaluateExecutingStall({
                now,
                phase: 'executing',
                runnerKind: task.config.runnerKind,
                executingStartedAt: fixStartedAt,
                leaseExpiresAt,
                executorHeartbeatAt: previousHeartbeat,
                remoteHeartbeatAt: remoteHeartbeat,
                executingStallTimeoutMs: deps.executingStallTimeoutMs,
              });
              if (executingStalled) {
                const fixAgeMs = fixStartedAt ? now.getTime() - fixStartedAt.getTime() : 0;
                const reason =
                  `Fix session stalled: task remained in fixing_with_ai for ${Math.floor(fixAgeMs / 1000)}s ` +
                  `without a live fix handle (${staleReason}).`;
                deps.logger.error(`[fix-session-stall] reclaiming "${task.id}": ${reason}`, { module: 'db-poll' });
                const outcome = deps.getOrchestrator().reclaimStalledFixSession(task.id, {
                  reason,
                  expectedLineage: {
                    taskId: task.id,
                    selectedAttemptId: task.execution.selectedAttemptId,
                    generation: task.execution.generation ?? 0,
                  },
                });
                deps.logger.info(
                  `[fix-session-stall] reclaim outcome=${outcome} task="${task.id}" ` +
                    `selectedAttemptId=${task.execution.selectedAttemptId ?? 'none'} ` +
                    `leaseExpiresAt=${leaseExpiresAt?.toISOString() ?? 'none'}`,
                  { module: 'db-poll' },
                );
                continue;
              }
            }

            const snapshot = JSON.stringify(task);
            const previous = lastKnownTaskStates.get(task.id);
            if (!previous) {
              if (deps.traceDbPollPerTask) {
                const msg = `New task: ${task.id} (${task.status})`;
                deps.logger.info(msg, { module: 'db-poll' });
                try { deps.persistence.writeActivityLog('db-poll', 'info', msg); } catch { /* db locked */ }
              }
              lastKnownTaskStates.set(task.id, snapshot);
              deps.uiPerfStats.dbPollCreated += 1;
              publishTaskDeltaToRenderer({ type: 'created', task });
            } else if (previous !== snapshot) {
              if (deps.traceDbPollPerTask) {
                const msg = `Task updated: ${task.id} (${task.status})`;
                deps.logger.info(msg, { module: 'db-poll' });
                try { deps.persistence.writeActivityLog('db-poll', 'info', msg); } catch { /* db locked */ }
              }
              lastKnownTaskStates.set(task.id, snapshot);
              deps.uiPerfStats.dbPollUpdatedAsCreated += 1;
              publishTaskDeltaToRenderer({ type: 'created', task });
            }
          }
        }
        try {
          deps.pollLaunchDispatcher();
        } catch (err) {
          deps.logger.warn(
            `[launch-dispatcher] poll() failed: ${err instanceof Error ? err.message : String(err)}`,
            { module: 'db-poll' },
          );
        }
      } catch {
        // DB might be locked — skip this tick
      }
    }, 2000);

    return {
      stop() {
        clearInterval(interval);
      },
    };
  };

  const startActivityPolling = (): RendererTaskFeedStopHandle => {
    const interval = setInterval(() => {
      const snapshot = {
        ts: new Date().toISOString(),
        metric: 'main_delta_flow',
        ...deps.uiPerfStats,
      };
      try {
        deps.persistence.writeActivityLog('ui-perf-main', 'info', JSON.stringify(snapshot));

      } catch {
        // DB might be locked
      }
    }, 10000);

    return {
      stop() {
        clearInterval(interval);
      },
    };
  };

  return {
    enqueueTaskOutput,
    flushTaskOutput,
    seedUiSnapshotCache,
    getDetachedViewerTasks,
    publishTaskDeltaToRenderer,
    getLastKnownWorkflowCount: () => lastKnownWorkflowCount,
    setLastKnownWorkflowCount: (count) => { lastKnownWorkflowCount = count; },
    getTaskSnapshot: (taskId) => lastKnownTaskStates.get(taskId),
    listKnownTaskIds: () => [...lastKnownTaskStates.keys()],
    clearTaskSnapshots: () => { lastKnownTaskStates.clear(); },
    replaceWorkflowRollups: (tasks) => { workflowRollupProjection.replaceAll(tasks); },
    rememberTaskState: (task) => { lastKnownTaskStates.set(task.id, JSON.stringify(task)); },
    resetSnapshotState: () => {
      lastKnownTaskStates.clear();
      workflowRollupProjection.clear();
      lastKnownWorkflowCount = 0;
    },
    receiveTaskDelta: processIncomingTaskDelta,
    startDbPolling,
    startActivityPolling,
  };
}
