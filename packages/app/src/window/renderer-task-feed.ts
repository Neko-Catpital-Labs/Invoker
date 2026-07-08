import type { BrowserWindow } from 'electron';
import type { Logger, TaskOutputData, WorkResponse } from '@invoker/contracts';
import type { Orchestrator, TaskDelta, TaskState } from '@invoker/workflow-core';
import type { SQLiteAdapter } from '@invoker/data-store';
import type { MessageBus } from '@invoker/transport';
import { Channels } from '@invoker/transport';
import { applyDelta, recoverQuarantinedTask, TaskSnapshotCache } from '../delta-merge.js';
import { WorkflowRollupProjection } from '../workflow-rollup-projection.js';
import { seedTaskCachesFromSnapshot } from '../viewer-cache-hydration.js';
import { shouldSkipAutoFixForError } from '../auto-fix-gating.js';
import { evaluateExecutingStall } from '../executing-stall.js';
import { persistShutdownDiagnostic } from '../shutdown-diagnostic.js';
import type { TaskGraphEventPublisher } from '../task-graph-event-publisher.js';
import type { TaskHandleMap } from '../execution/task-runner-wiring.js';
import type { LaunchDispatcher } from '../launch-dispatcher.js';

/** Stops a poll loop started by the feed; idempotent-safe to call once on shutdown. */
export type PollStopHandle = () => void;

/**
 * The mutable UI-perf counters the feed increments. The owning object in
 * main.ts carries more fields; the feed only touches these three.
 */
export interface RendererTaskFeedPerfStats {
  mainDeltaToUi: number;
  dbPollCreated: number;
  dbPollUpdatedAsCreated: number;
}

export interface RendererTaskFeedDeps {
  logger: Logger;
  /** Read lazily: reassigned by the daemon-owner route refresh. */
  getMessageBus: () => MessageBus;
  /** Read lazily: reassigned when the `invoker:clear` handler rebuilds services. */
  getOrchestrator: () => Orchestrator;
  getPersistence: () => SQLiteAdapter;
  /** Read lazily: assigned once the GUI window is created. */
  getMainWindow: () => BrowserWindow | null;
  /** Read lazily: constructed later during GUI bootstrap. */
  getLaunchDispatcher: () => LaunchDispatcher | null;
  taskGraphEventPublisher: TaskGraphEventPublisher;
  taskHandles: TaskHandleMap;
  uiPerfStats: RendererTaskFeedPerfStats;
  executingStallTimeoutMs: number;
  traceTaskOutput: boolean;
  traceUiDeltaFlow: boolean;
  traceDbPollPerTask: boolean;
  requestWorkflowMetadataPublish: (reason: string) => void;
  scheduleAutoFix: (taskId: string) => void;
  logAutoFixDebug: (taskId: string, phase: string, details?: Record<string, unknown>) => void;
  setStartupWorkflowId: (workflowId: string | null) => void;
}

/**
 * The renderer task feed: the delta/output pipeline plus the two poll loops
 * that keep the renderer's task graph current, owning the shared state block
 * (`lastKnownTaskStates`, `workflowRollupProjection`, output buffers,
 * detached-viewer buffers, workflow/activity cursors). main.ts delegates the
 * feed to this module and reaches the owned state through the accessors below.
 */
export interface RendererTaskFeed {
  // Output buffering.
  enqueueTaskOutput(taskId: string, data: string): void;
  flushTaskOutput(taskId: string): void;
  // Delta pipeline.
  publishTaskDeltaToRenderer(delta: TaskDelta): void;
  processIncomingTaskDelta(delta: TaskDelta): void;
  /** Buffer during detached-viewer hydration, otherwise process immediately. */
  ingestTaskDelta(delta: TaskDelta): void;
  /** Start buffering owner deltas until hydration seeds the cache. */
  beginDetachedBuffering(): void;
  loadTaskByIdFromPersistence(taskId: string): TaskState | undefined;
  // Viewer hydration / seeding.
  seedUiSnapshotCache(): void;
  hydrateDetachedViewerFromOwner(): Promise<void>;
  detachedViewerTasks(): TaskState[];
  // Poll loops.
  startDbPolling(): PollStopHandle;
  startActivityPolling(): PollStopHandle;
  // Owned-state accessors for the code that stays in main.ts.
  getTaskSnapshotCache(): TaskSnapshotCache;
  getWorkflowRollupProjection(): WorkflowRollupProjection;
  setLastKnownWorkflowCount(count: number): void;
  getDetachedViewerWorkflows(): unknown[] | null;
}

const parseExecutionDate = (value: unknown): Date | undefined => {
  if (!value) return undefined;
  if (value instanceof Date) return value;
  if (typeof value !== 'string') return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
};

export function createRendererTaskFeed(deps: RendererTaskFeedDeps): RendererTaskFeed {
  const {
    logger,
    getMessageBus,
    getOrchestrator,
    getPersistence,
    getMainWindow,
    getLaunchDispatcher,
    taskGraphEventPublisher,
    taskHandles,
    uiPerfStats,
    executingStallTimeoutMs,
    traceTaskOutput,
    traceUiDeltaFlow,
    traceDbPollPerTask,
    requestWorkflowMetadataPublish,
    scheduleAutoFix,
    logAutoFixDebug,
    setStartupWorkflowId,
  } = deps;

  // ── Owned state block ──────────────────────────────────────
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

  // ── Output buffering ───────────────────────────────────────
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
    getMessageBus().publish(Channels.TASK_OUTPUT, outputData);
    try {
      // Runner stream chunks land in the output spool only — task_output is
      // reserved for explicit diagnostic writes (workflow actions, shutdown).
      getPersistence().appendOutputChunk(taskId, data);
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

  // ── Delta pipeline ─────────────────────────────────────────
  const loadTaskByIdFromPersistence = (taskId: string): TaskState | undefined => {
    return getPersistence().loadTask(taskId);
  };

  const publishTaskDeltaToRenderer = (delta: TaskDelta): void => {
    const workflowRollups = workflowRollupProjection.applyDelta(delta);
    taskGraphEventPublisher.publishDelta(delta, workflowRollups);
  };

  const applyTaskDeltaToOwnerCacheOrRecover = (delta: TaskDelta): TaskDelta[] => {
    const orchestrator = getOrchestrator();
    const { quarantined, accepted } = applyDelta(delta, lastKnownTaskStates);
    if (quarantined.length === 0) {
      return accepted ? [delta] : [];
    }

    const rendererDeltas: TaskDelta[] = [];
    for (const taskId of quarantined) {
      logger.info(`[gap-detect] quarantined task="${taskId}" — triggering authoritative reload`, { module: 'delta-merge' });
      const { rendererDelta } = recoverQuarantinedTask(lastKnownTaskStates, taskId, {
        loadTask: loadTaskByIdFromPersistence,
        getMergeNode: (workflowId) => orchestrator.getMergeNode(workflowId),
      });
      if (rendererDelta) {
        rendererDeltas.push(rendererDelta);
      }
    }
    return rendererDeltas;
  };

  // Apply one owner task delta to the local cache and forward results to the
  // renderer (and drive owner-side auto-fix). Extracted so the detached viewer
  // can replay deltas that were buffered during hydration.
  const processIncomingTaskDelta = (d: TaskDelta): void => {
    const orchestrator = getOrchestrator();
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
  };

  const ingestTaskDelta = (d: TaskDelta): void => {
    if (detachedDeltaBuffer) {
      detachedDeltaBuffer.push(d);
      return;
    }
    processIncomingTaskDelta(d);
  };

  const beginDetachedBuffering = (): void => {
    detachedDeltaBuffer = [];
  };

  // ── Viewer hydration / seeding ─────────────────────────────
  const seedUiSnapshotCache = (): void => {
    const persistence = getPersistence();
    const orchestrator = getOrchestrator();
    lastKnownWorkflowCount = persistence.listWorkflows().length;
    seedTaskCachesFromSnapshot(orchestrator.getAllTasks(), { lastKnownTaskStates, workflowRollupProjection });
  };

  // Detached viewer: the local DB is empty, so seed the delta caches and
  // bootstrap snapshot from the owner. Without this, the empty cache quarantines
  // every `updated` delta for a task the viewer has not seen (dropping live
  // updates), and bootstrap getters return nothing. Failures are non-fatal — the
  // renderer's delegated reads still populate the view.
  const hydrateDetachedViewerFromOwner = async (): Promise<void> => {
    try {
      const snapshot = await getMessageBus().request<{ kind: string }, { tasks?: TaskState[]; workflows?: unknown[] }>(
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
  };

  // Current task states for the detached viewer's bootstrap getter, derived from
  // the live delta cache so a renderer reload never sees the stale hydration
  // snapshot.
  const detachedViewerTasks = (): TaskState[] => {
    return [...lastKnownTaskStates.keys()].map(
      (taskId) => JSON.parse(lastKnownTaskStates.get(taskId) ?? '{}') as TaskState,
    );
  };

  // ── Poll loops ─────────────────────────────────────────────
  const startDbPolling = (): PollStopHandle => {
    const interval = setInterval(() => {
      const mainWindow = getMainWindow();
      const persistence = getPersistence();
      const orchestrator = getOrchestrator();
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
                executingStallTimeoutMs,
              });
              if (executingStalled) {
                const fixAgeMs = fixStartedAt ? now.getTime() - fixStartedAt.getTime() : 0;
                const reason =
                  `Fix session stalled: task remained in fixing_with_ai for ${Math.floor(fixAgeMs / 1000)}s ` +
                  `without a live fix handle (${staleReason}).`;
                logger.error(`[fix-session-stall] reclaiming "${task.id}": ${reason}`, { module: 'db-poll' });
                const outcome = orchestrator.reclaimStalledFixSession(task.id, {
                  reason,
                  expectedLineage: {
                    taskId: task.id,
                    selectedAttemptId: task.execution.selectedAttemptId,
                    generation: task.execution.generation ?? 0,
                  },
                });
                logger.info(
                  `[fix-session-stall] reclaim outcome=${outcome} task="${task.id}" ` +
                    `selectedAttemptId=${task.execution.selectedAttemptId ?? 'none'} ` +
                    `leaseExpiresAt=${leaseExpiresAt?.toISOString() ?? 'none'}`,
                  { module: 'db-poll' },
                );
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
  };

  const startActivityPolling = (): PollStopHandle => {
    const interval = setInterval(() => {
      const mainWindow = getMainWindow();
      const persistence = getPersistence();
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
  };

  return {
    enqueueTaskOutput,
    flushTaskOutput,
    publishTaskDeltaToRenderer,
    processIncomingTaskDelta,
    ingestTaskDelta,
    beginDetachedBuffering,
    loadTaskByIdFromPersistence,
    seedUiSnapshotCache,
    hydrateDetachedViewerFromOwner,
    detachedViewerTasks,
    startDbPolling,
    startActivityPolling,
    getTaskSnapshotCache: () => lastKnownTaskStates,
    getWorkflowRollupProjection: () => workflowRollupProjection,
    setLastKnownWorkflowCount: (count: number) => { lastKnownWorkflowCount = count; },
    getDetachedViewerWorkflows: () => detachedViewerWorkflows,
  };
}
