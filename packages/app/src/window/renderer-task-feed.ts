import type { BrowserWindow } from 'electron';
import type { Logger, WorkResponse } from '@invoker/contracts';
import type { SQLiteAdapter } from '@invoker/data-store';
import type { Orchestrator, TaskDelta, TaskState } from '@invoker/workflow-core';
import { Channels } from '@invoker/transport';
import type { MessageBus } from '@invoker/transport';
import { applyDelta, recoverQuarantinedTask, TaskSnapshotCache } from '../delta-merge.js';
import { WorkflowRollupProjection } from '../workflow-rollup-projection.js';
import { seedTaskCachesFromSnapshot } from '../viewer-cache-hydration.js';
import { shouldSkipAutoFixForError } from '../auto-fix-gating.js';
import { evaluateExecutingStall } from '../executing-stall.js';
import { persistShutdownDiagnostic } from '../shutdown-diagnostic.js';
import { parseExecutionDate } from '../execution/workflow-task-actions.js';
import type { TaskGraphEventPublisher } from '../task-graph-event-publisher.js';
import type { TaskHandleMap } from '../execution/task-runner-wiring.js';
import type { LaunchDispatcher } from '../launch-dispatcher.js';
import type { TaskOutputData } from '../types.js';

/** The subset of the main-process UI perf counters this feed increments. */
export interface RendererTaskFeedPerfStats {
  mainDeltaToUi: number;
  dbPollCreated: number;
  dbPollUpdatedAsCreated: number;
}

export interface RendererTaskFeedDeps {
  logger: Logger;
  persistence: SQLiteAdapter;
  orchestrator: Orchestrator;
  messageBus: MessageBus;
  /** Coalesced task-graph event fan-out to the renderer (owned by main.ts). */
  taskGraphEventPublisher: TaskGraphEventPublisher;
  uiPerfStats: RendererTaskFeedPerfStats;
  taskHandles: TaskHandleMap;
  getMainWindow: () => BrowserWindow | null;
  getLaunchDispatcher: () => LaunchDispatcher | null;
  requestWorkflowMetadataPublish: (reason: string) => void;
  scheduleAutoFix: (taskId: string) => void;
  logAutoFixDebug: (taskId: string, phase: string, details?: Record<string, unknown>) => void;
  setStartupWorkflowId: (workflowId: string | null) => void;
  traceUiDeltaFlow: boolean;
  traceDbPollPerTask: boolean;
  traceTaskOutput: boolean;
  executingStallTimeoutMs: number;
}

/**
 * The renderer task feed: the owner-side delta/output pipeline plus the db and
 * activity poll loops that keep the renderer's task graph and activity log in
 * sync. Owns the snapshot cache, workflow rollup projection, output buffers, and
 * the detached-viewer hydration state block. `main.ts` delegates the renderer
 * feed here and reads shared state through the exposed accessors.
 */
export interface RendererTaskFeed {
  /** Owner snapshot cache; main.ts reconciles it during full-graph publishes. */
  readonly lastKnownTaskStates: TaskSnapshotCache;
  /** Per-workflow rollup projection kept in step with the snapshot cache. */
  readonly workflowRollupProjection: WorkflowRollupProjection;
  setLastKnownWorkflowCount: (count: number) => void;
  getDetachedViewerWorkflows: () => unknown[] | null;
  getDetachedDeltaBuffer: () => TaskDelta[] | null;
  setDetachedDeltaBuffer: (buffer: TaskDelta[] | null) => void;
  enqueueTaskOutput: (taskId: string, data: string) => void;
  flushTaskOutput: (taskId: string) => void;
  publishTaskDeltaToRenderer: (delta: TaskDelta) => void;
  processIncomingTaskDelta: (delta: TaskDelta) => void;
  seedUiSnapshotCache: () => void;
  hydrateDetachedViewerFromOwner: () => Promise<void>;
  detachedViewerTasks: () => TaskState[];
  /** Start the 2s db poll; returns a stop handle the shutdown path clears. */
  startDbPolling: () => () => void;
  /** Start the 2s activity-log poll; returns a stop handle. */
  startActivityPolling: () => () => void;
}

export function createRendererTaskFeed(deps: RendererTaskFeedDeps): RendererTaskFeed {
  const {
    logger,
    persistence,
    orchestrator,
    messageBus,
    taskGraphEventPublisher,
    uiPerfStats,
    taskHandles,
    getMainWindow,
    getLaunchDispatcher,
    requestWorkflowMetadataPublish,
    scheduleAutoFix,
    logAutoFixDebug,
    setStartupWorkflowId,
    traceUiDeltaFlow,
    traceDbPollPerTask,
    traceTaskOutput,
    executingStallTimeoutMs,
  } = deps;

  const lastKnownTaskStates = new TaskSnapshotCache();
  const workflowRollupProjection = new WorkflowRollupProjection();
  const pendingOutputBuffers = new Map<string, string[]>();
  const outputFlushTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let lastKnownWorkflowCount = 0;
  let lastActivityLogId = 0;
  // In detached viewer mode the local DB is an empty in-memory copy. Workflow
  // metadata for the bootstrap getter comes from the owner snapshot; task state
  // is derived live from `lastKnownTaskStates` (kept current by deltas).
  let detachedViewerWorkflows: unknown[] | null = null;
  // While the detached viewer hydrates, owner deltas are buffered here and
  // replayed after the cache is seeded, so an update arriving mid-hydration is
  // not applied against an empty cache (quarantined and dropped).
  let detachedDeltaBuffer: TaskDelta[] | null = null;

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
    if (traceTaskOutput) {
      logger.info(`${taskId}: ${data.trimEnd()}`, { module: 'output' });
    }
    const outputData: TaskOutputData = { taskId, data };
    messageBus.publish(Channels.TASK_OUTPUT, outputData);
    try {
      // Runner stream chunks land in the output spool only — task_output is
      // reserved for explicit diagnostic writes (workflow actions, shutdown).
      persistence.appendOutputChunk(taskId, data);
    } catch (err) {
      logger.error(`Failed to persist output for ${taskId}: ${err}`, { module: 'output' });
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
    taskGraphEventPublisher.publishDelta(delta, workflowRollups);
  };

  const applyTaskDeltaToOwnerCacheOrRecover = (delta: TaskDelta): TaskDelta[] => {
    const { quarantined, accepted } = applyDelta(delta, lastKnownTaskStates);
    if (quarantined.length === 0) {
      return accepted ? [delta] : [];
    }

    const rendererDeltas: TaskDelta[] = [];
    for (const taskId of quarantined) {
      logger.info(`[gap-detect] quarantined task="${taskId}" — triggering authoritative reload`, { module: 'delta-merge' });
      const { rendererDelta } = recoverQuarantinedTask(lastKnownTaskStates, taskId, {
        loadTask: (id) => persistence.loadTask(id),
        getMergeNode: (workflowId) => orchestrator.getMergeNode(workflowId),
      });
      if (rendererDelta) {
        rendererDeltas.push(rendererDelta);
      }
    }
    return rendererDeltas;
  };

  function seedUiSnapshotCache(): void {
    lastKnownWorkflowCount = persistence.listWorkflows().length;
    seedTaskCachesFromSnapshot(orchestrator.getAllTasks(), { lastKnownTaskStates, workflowRollupProjection });
  }

  // Detached viewer: the local DB is empty, so seed the delta caches and
  // bootstrap snapshot from the owner. Without this, the empty cache quarantines
  // every `updated` delta for a task the viewer has not seen (dropping live
  // updates), and bootstrap getters return nothing. Failures are non-fatal — the
  // renderer's delegated reads still populate the view.
  async function hydrateDetachedViewerFromOwner(): Promise<void> {
    try {
      const snapshot = await messageBus.request<{ kind: string }, { tasks?: TaskState[]; workflows?: unknown[] }>(
        'headless.query',
        { kind: 'tasks' },
      );
      const tasks = Array.isArray(snapshot?.tasks) ? snapshot.tasks : [];
      const workflows = Array.isArray(snapshot?.workflows) ? snapshot.workflows : [];
      detachedViewerWorkflows = workflows;
      seedTaskCachesFromSnapshot(tasks, { lastKnownTaskStates, workflowRollupProjection });
      lastKnownWorkflowCount = workflows.length;
      setStartupWorkflowId([...workflows]
        .map((wf) => wf as { id?: string; updatedAt?: string; createdAt?: string })
        .sort((left, right) => (Date.parse(right.updatedAt ?? '') || 0) - (Date.parse(left.updatedAt ?? '') || 0))[0]?.id ?? null);
      logger.info(
        `[init] Hydrated detached viewer from owner: ${tasks.length} tasks across ${workflows.length} workflows`,
        { module: 'init' },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`detached viewer hydration from owner failed; relying on delegated reads: ${message}`, { module: 'init' });
    } finally {
      // Resume direct delta processing and replay anything buffered during
      // hydration (in arrival order). Always runs, so a hydration failure can
      // never leave deltas buffered forever.
      const buffered = detachedDeltaBuffer ?? [];
      detachedDeltaBuffer = null;
      for (const delta of buffered) processIncomingTaskDelta(delta);
    }
  }

  // Current task states for the detached viewer's bootstrap getter, derived from
  // the live delta cache so a renderer reload never sees the stale hydration
  // snapshot.
  function detachedViewerTasks(): TaskState[] {
    return [...lastKnownTaskStates.keys()].map(
      (taskId) => JSON.parse(lastKnownTaskStates.get(taskId) ?? '{}') as TaskState,
    );
  }

  // Apply one owner task delta to the local cache and forward results to the
  // renderer (and drive owner-side auto-fix). Extracted so the detached viewer
  // can replay deltas that were buffered during hydration.
  function processIncomingTaskDelta(d: TaskDelta): void {
    uiPerfStats.mainDeltaToUi += 1;
    if (traceUiDeltaFlow) {
      logger.debug(`delta→ui: ${JSON.stringify(d)}`, { module: 'ui' });
    }
    const deltaTaskId = d.type === 'updated' || d.type === 'removed' ? d.taskId : undefined;
    if (d.type === 'updated' && d.changes.status === 'failed') {
      const cancellationError = shouldSkipAutoFixForError(d.changes.execution?.error);
      const shouldAutoFixFromOrchestrator = orchestrator.shouldAutoFix(d.taskId);
      logAutoFixDebug(d.taskId, 'delta-failed', {
        shouldSkipForCancellation: cancellationError,
        shouldAutoFixFromOrchestrator,
      });
      if (!cancellationError && shouldAutoFixFromOrchestrator && deltaTaskId) {
        logAutoFixDebug(deltaTaskId, 'delta-trigger-schedule');
        scheduleAutoFix(deltaTaskId);
      } else if (deltaTaskId) {
        logAutoFixDebug(deltaTaskId, 'delta-skip', {
          reason: cancellationError ? 'cancellation-error' : 'shouldAutoFix-false',
          shouldSkipForCancellation: cancellationError,
          shouldAutoFixFromOrchestrator,
        });
      }
    }
    for (const rendererDelta of applyTaskDeltaToOwnerCacheOrRecover(d)) {
      publishTaskDeltaToRenderer(rendererDelta);
    }
  }

  function startDbPolling(): () => void {
    const interval = setInterval(() => {
      const mainWindow = getMainWindow();
      if (!mainWindow || mainWindow.isDestroyed()) return;
      try {
        const workflows = persistence.listWorkflows();

        if (workflows.length !== lastKnownWorkflowCount) {
          const msg = `Workflow count changed: ${lastKnownWorkflowCount} → ${workflows.length}`;
          logger.info(msg, { module: 'db-poll' });
          try { persistence.writeActivityLog('db-poll', 'info', msg); } catch { /* db locked */ }
          lastKnownWorkflowCount = workflows.length;
          requestWorkflowMetadataPublish('db-poll-count');

          orchestrator.syncAllFromDb();
          logger.info(`Synced orchestrator for all ${workflows.length} workflows`, { module: 'db-poll' });
        }

        for (const wf of workflows) {
          if (wf.status === 'completed' || wf.status === 'failed') continue;
          const tasks = persistence.loadTasks(wf.id);
          for (const loadedTask of tasks) {
            const task = loadedTask;
            const now = new Date();
            const previousHeartbeat = parseExecutionDate(task.execution.lastHeartbeatAt);
            const selectedAttempt = task.execution.selectedAttemptId
              ? persistence.loadAttempt?.(task.execution.selectedAttemptId)
              : undefined;
            const leaseExpiresAt = parseExecutionDate(selectedAttempt?.leaseExpiresAt);
            const remoteHeartbeat = parseExecutionDate(task.execution.remoteHeartbeatAt);

            if (task.status === 'running' || (task.status === 'pending' && task.execution.phase === 'launching')) {
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
                executingStallTimeoutMs,
              });

              if (executingStalled) {
                const selectedAttemptHeartbeat = parseExecutionDate(selectedAttempt?.lastHeartbeatAt);
                const executingError =
                  `Execution stalled: task remained in running/executing for ${Math.floor(executingAgeMs / 1000)}s ` +
                  `without a live execution handle and no completion signal from executor (${staleReason}).`;
                logger.info(
                  `[executing-stall] detected task="${task.id}" phase=${task.execution.phase} executingAgeMs=${executingAgeMs} ` +
                    `handlePresent=${taskHandles.has(task.id)} leaseExpired=${leaseExpired} heartbeatStale=${heartbeatStale} ` +
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
                  },
                };
                logger.error(`[executing-stall] forcing failure for "${task.id}": ${executingError}`, { module: 'db-poll' });
                if (persistence) {
                  persistShutdownDiagnostic(task, persistence, {
                    flushPendingOutput: flushTaskOutput,
                    forcedStopReason: executingError,
                    label: task.execution.phase === 'launching'
                      ? 'Startup Failure Diagnostic'
                      : 'Shutdown Diagnostic',
                  });
                }
                orchestrator.handleWorkerResponse(failedResponse);
                continue;
              }
            }

            const snapshot = JSON.stringify(task);
            const prev = lastKnownTaskStates.get(task.id);
            if (!prev) {
              if (traceDbPollPerTask) {
                const msg = `New task: ${task.id} (${task.status})`;
                logger.info(msg, { module: 'db-poll' });
                try { persistence.writeActivityLog('db-poll', 'info', msg); } catch { /* db locked */ }
              }
              lastKnownTaskStates.set(task.id, snapshot);
              uiPerfStats.dbPollCreated += 1;
              publishTaskDeltaToRenderer({ type: 'created', task });
            } else if (prev !== snapshot) {
              if (traceDbPollPerTask) {
                const msg = `Task updated: ${task.id} (${task.status})`;
                logger.info(msg, { module: 'db-poll' });
                try { persistence.writeActivityLog('db-poll', 'info', msg); } catch { /* db locked */ }
              }
              lastKnownTaskStates.set(task.id, snapshot);
              uiPerfStats.dbPollUpdatedAsCreated += 1;
              publishTaskDeltaToRenderer({ type: 'created', task });
            }
          }
        }
        const launchDispatcher = getLaunchDispatcher();
        if (launchDispatcher) {
          try {
            launchDispatcher.poll();
          } catch (err) {
            logger.warn(
              `[launch-dispatcher] poll() failed: ${err instanceof Error ? err.message : String(err)}`,
              { module: 'db-poll' },
            );
          }
        }
      } catch {
        // DB might be locked — skip this tick
      }
    }, 2000);
    return () => clearInterval(interval);
  }

  function startActivityPolling(): () => void {
    const interval = setInterval(() => {
      const mainWindow = getMainWindow();
      if (!mainWindow || mainWindow.isDestroyed()) return;
      try {
        const entries = persistence.getActivityLogs(lastActivityLogId);
        if (entries.length > 0) {
          lastActivityLogId = entries[entries.length - 1].id;
          mainWindow.webContents.send('invoker:activity-log', entries);
        }
      } catch {
        // DB might be locked — skip this tick
      }
    }, 2000);
    return () => clearInterval(interval);
  }

  return {
    lastKnownTaskStates,
    workflowRollupProjection,
    setLastKnownWorkflowCount: (count) => { lastKnownWorkflowCount = count; },
    getDetachedViewerWorkflows: () => detachedViewerWorkflows,
    getDetachedDeltaBuffer: () => detachedDeltaBuffer,
    setDetachedDeltaBuffer: (buffer) => { detachedDeltaBuffer = buffer; },
    enqueueTaskOutput,
    flushTaskOutput,
    publishTaskDeltaToRenderer,
    processIncomingTaskDelta,
    seedUiSnapshotCache,
    hydrateDetachedViewerFromOwner,
    detachedViewerTasks,
    startDbPolling,
    startActivityPolling,
  };
}
