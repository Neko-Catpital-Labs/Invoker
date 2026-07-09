import type { BrowserWindow } from 'electron';
import type { SQLiteAdapter } from '@invoker/data-store';
import type { Logger, TaskGraphEvent, WorkflowMeta, WorkResponse } from '@invoker/contracts';
import type { MessageBus } from '@invoker/transport';
import { Channels } from '@invoker/transport';
import { type Orchestrator, type TaskDelta, type TaskState } from '@invoker/workflow-core';
import type { TaskOutputData } from '../types.js';
import { createStartupWorkflowCache } from '../bootstrap/startup-workflow-cache.js';
import { applyDelta, recoverQuarantinedTask, TaskSnapshotCache } from '../delta-merge.js';
import { CoalescedWorkflowMetadataPublisher } from '../workflow-metadata-invalidation.js';
import { WorkflowRollupProjection } from '../workflow-rollup-projection.js';
import { seedTaskCachesFromSnapshot } from '../viewer-cache-hydration.js';
import { shouldSkipAutoFixForError } from '../auto-fix-gating.js';
import { createTaskDeltaStreamSequence } from '../task-delta-stream-sequence.js';
import { createTaskGraphEventPublisher } from '../task-graph-event-publisher.js';
import { evaluateExecutingStall } from '../executing-stall.js';
import { persistShutdownDiagnostic } from '../shutdown-diagnostic.js';

export interface RendererTaskFeedUiPerfStats {
  mainDeltaToUi: number;
  dbPollCreated: number;
  dbPollUpdatedAsCreated: number;
  dbPollUpdatedAsUpdated: number;
  rendererReports: number;
  maxRendererEventLoopLagMs: number;
  maxRendererHiddenEventLoopLagMs: number;
  maxRendererCumulativeLagMs: number;
  maxRendererTickDeltaMs: number;
  maxRendererLongTaskMs: number;
  workflowMetadataPublishRequests: number;
  workflowMetadataPublishes: number;
  workflowMetadataCoalescedRequests: number;
  largeTaskDeltaBatches: number;
  maxTaskDeltaBatchSize: number;
}

export interface RendererTaskFeedStopHandle {
  stop(): void;
}

interface TaskHandleLookup {
  has(taskId: string): boolean;
}

interface LaunchDispatcherLike {
  poll(): void;
}

export interface RendererTaskFeedDeps {
  logger: Logger;
  persistence: SQLiteAdapter;
  messageBus: MessageBus;
  getOrchestrator: () => Orchestrator;
  getMainWindow: () => BrowserWindow | null;
  isUiInteractive: () => boolean;
  uiPerfStats: RendererTaskFeedUiPerfStats;
  recordStartupMark: (phase: string, extra?: Record<string, unknown>) => void;
  recordStartupDuration: (phase: string, startedAtMs: number, extra?: Record<string, unknown>) => void;
  recordStartupDetail: (phase: string, details: Record<string, unknown>) => void;
  scheduleAutoFix: (taskId: string) => void;
  logAutoFixDebug: (taskId: string, phase: string, details?: Record<string, unknown>) => void;
  getTaskHandles: () => TaskHandleLookup;
  getLaunchDispatcher: () => LaunchDispatcherLike | null;
  broadcastTaskGraphEvent?: (event: TaskGraphEvent) => void;
}

export interface RendererTaskFeed {
  enqueueTaskOutput(taskId: string, data: string): void;
  flushTaskOutput(taskId: string): void;
  getTaskDeltaStreamSequence(): number;
  requestWorkflowMetadataPublish(reason: string): void;
  publishSnapshot(reason: string, tasks: TaskState[], workflows: WorkflowMeta[]): void;
  publishTaskDeltaToRenderer(delta: TaskDelta): void;
  seedUiSnapshotCache(): void;
  hydrateDetachedViewerFromOwner(): Promise<void>;
  getDetachedViewerTasks(): TaskState[];
  getDetachedViewerWorkflows(): WorkflowMeta[] | null;
  getBootstrapWorkflows(listWorkflowsByStartupRecency?: () => WorkflowMeta[]): WorkflowMeta[];
  getInitialWorkflowId(): string | null;
  getPreviousTaskStateVersion(taskId: string, before: TaskState | undefined): number;
  replaceKnownTasksFromOrchestrator(tasks: TaskState[]): void;
  resetRendererState(): void;
  setLastKnownWorkflowCount(count: number): void;
  bootstrapInitialWorkflowState(): void;
  publishOrchestratorSnapshotToRenderer(): void;
  startTaskDeltaSubscription(ownerMode: boolean): RendererTaskFeedStopHandle;
  startTaskOutputSubscription(): RendererTaskFeedStopHandle;
  startActivityPolling(): RendererTaskFeedStopHandle;
  startDbPolling(startupPollDelayMs: number): RendererTaskFeedStopHandle;
}

function parseExecutionDate(value: unknown): Date | undefined {
  if (!value) return undefined;
  if (value instanceof Date) return value;
  if (typeof value !== 'string') return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

export function createRendererTaskFeed(deps: RendererTaskFeedDeps): RendererTaskFeed {
  const lastKnownTaskStates = new TaskSnapshotCache();
  const workflowRollupProjection = new WorkflowRollupProjection();
  const pendingOutputBuffers = new Map<string, string[]>();
  const outputFlushTimers = new Map<string, NodeJS.Timeout>();
  const startupWorkflowCache = createStartupWorkflowCache();
  let lastKnownWorkflowCount = 0;
  let startupWorkflowId: string | null = null;
  let detachedViewerWorkflows: WorkflowMeta[] | null = null;
  let detachedDeltaBuffer: TaskDelta[] | null = null;

  const traceUiDeltaFlow = process.env.INVOKER_TRACE_UI_DELTA === '1';
  const traceDbPollPerTask = process.env.INVOKER_TRACE_DB_POLL === '1';
  const traceTaskOutput = process.env.INVOKER_TRACE_TASK_OUTPUT === '1';
  const executingStallTimeoutMs = Number.parseInt(
    process.env.INVOKER_EXECUTING_STALL_TIMEOUT_MS ?? '180000',
    10,
  ) || 180000;

  const taskDeltaStream = createTaskDeltaStreamSequence();
  const getTaskDeltaStreamSequence = (): number => taskDeltaStream.current();

  const taskGraphEventPublisher = createTaskGraphEventPublisher({
    getMainWindow: deps.getMainWindow,
    isUiInteractive: deps.isUiInteractive,
    stampDelta: (delta) => taskDeltaStream.stamp(delta),
    getStreamSequence: getTaskDeltaStreamSequence,
    onLargeBatch: ({ batchSize, remaining }) => {
      deps.uiPerfStats.largeTaskDeltaBatches += 1;
      deps.uiPerfStats.maxTaskDeltaBatchSize = Math.max(deps.uiPerfStats.maxTaskDeltaBatchSize, batchSize);
      deps.logger.info(`large task-graph-event batch chunked size=${batchSize} remaining=${remaining}`, {
        module: 'ui-backpressure',
      });
    },
    onEvent: (event) => deps.broadcastTaskGraphEvent?.(event),
  });

  const workflowMetadataPublisher = new CoalescedWorkflowMetadataPublisher({
    listWorkflows: () => deps.persistence.listWorkflows(),
    publish: (workflows, stats) => {
      lastKnownWorkflowCount = workflows.length;
      deps.uiPerfStats.workflowMetadataPublishes += 1;
      deps.uiPerfStats.workflowMetadataCoalescedRequests += Math.max(0, stats.coalescedRequests - 1);
      if (stats.coalescedRequests > 1) {
        deps.logger.info(
          `coalesced workflow metadata publish requests=${stats.coalescedRequests} workflows=${workflows.length}`,
          { module: 'ui-backpressure', reasonCounts: stats.reasonCounts },
        );
      }
      const mainWindow = deps.getMainWindow();
      if (!mainWindow || mainWindow.isDestroyed() || !deps.isUiInteractive()) {
        return;
      }
      mainWindow.webContents.send('invoker:workflows-changed', workflows);
    },
  });

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
    taskGraphEventPublisher.publishDelta(delta, workflowRollups);
  };

  const applyTaskDeltaToOwnerCacheOrRecover = (delta: TaskDelta): TaskDelta[] => {
    const { quarantined, accepted } = applyDelta(delta, lastKnownTaskStates);
    if (quarantined.length === 0) {
      return accepted ? [delta] : [];
    }

    const rendererDeltas: TaskDelta[] = [];
    for (const taskId of quarantined) {
      deps.logger.info(`[gap-detect] quarantined task="${taskId}" — triggering authoritative reload`, { module: 'delta-merge' });
      const { rendererDelta } = recoverQuarantinedTask(lastKnownTaskStates, taskId, {
        loadTask: (id) => deps.persistence.loadTask(id),
        getMergeNode: (workflowId) => deps.getOrchestrator().getMergeNode(workflowId),
      });
      if (rendererDelta) {
        rendererDeltas.push(rendererDelta);
      }
    }
    return rendererDeltas;
  };

  const requestWorkflowMetadataPublish = (reason: string): void => {
    deps.uiPerfStats.workflowMetadataPublishRequests += 1;
    workflowMetadataPublisher.requestPublish(reason);
  };

  const seedUiSnapshotCache = (): void => {
    lastKnownWorkflowCount = deps.persistence.listWorkflows().length;
    seedTaskCachesFromSnapshot(deps.getOrchestrator().getAllTasks(), { lastKnownTaskStates, workflowRollupProjection });
  };

  const processIncomingTaskDelta = (d: TaskDelta): void => {
    deps.uiPerfStats.mainDeltaToUi += 1;
    if (traceUiDeltaFlow) {
      deps.logger.debug(`delta→ui: ${JSON.stringify(d)}`, { module: 'ui' });
    }
    const deltaTaskId = d.type === 'updated' || d.type === 'removed' ? d.taskId : undefined;
    if (d.type === 'updated' && d.changes.status === 'failed') {
      const cancellationError = shouldSkipAutoFixForError(d.changes.execution?.error);
      const shouldAutoFixFromOrchestrator = deps.getOrchestrator().shouldAutoFix(d.taskId);
      deps.logAutoFixDebug(d.taskId, 'delta-failed', {
        shouldSkipForCancellation: cancellationError,
        shouldAutoFixFromOrchestrator,
      });
      if (!cancellationError && shouldAutoFixFromOrchestrator && deltaTaskId) {
        deps.logAutoFixDebug(deltaTaskId, 'delta-trigger-schedule');
        deps.scheduleAutoFix(deltaTaskId);
      } else if (deltaTaskId) {
        deps.logAutoFixDebug(deltaTaskId, 'delta-skip', {
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

  const hydrateDetachedViewerFromOwner = async (): Promise<void> => {
    try {
      const snapshot = await deps.messageBus.request<{ kind: string }, { tasks?: TaskState[]; workflows?: WorkflowMeta[] }>(
        'headless.query',
        { kind: 'tasks' },
      );
      const tasks = Array.isArray(snapshot?.tasks) ? snapshot.tasks : [];
      const workflows = Array.isArray(snapshot?.workflows) ? snapshot.workflows : [];
      detachedViewerWorkflows = workflows;
      seedTaskCachesFromSnapshot(tasks, { lastKnownTaskStates, workflowRollupProjection });
      lastKnownWorkflowCount = workflows.length;
      startupWorkflowId = [...workflows]
        .sort((left, right) => (Date.parse(right.updatedAt ?? '') || 0) - (Date.parse(left.updatedAt ?? '') || 0))[0]?.id ?? null;
      deps.logger.info(
        `[init] Hydrated detached viewer from owner: ${tasks.length} tasks across ${workflows.length} workflows`,
        { module: 'init' },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deps.logger.warn(`detached viewer hydration from owner failed; relying on delegated reads: ${message}`, { module: 'init' });
    } finally {
      // Resume direct delta processing and replay anything buffered during
      // hydration (in arrival order). Always runs, so a hydration failure can
      // never leave deltas buffered forever.
      const buffered = detachedDeltaBuffer ?? [];
      detachedDeltaBuffer = null;
      for (const delta of buffered) processIncomingTaskDelta(delta);
    }
  };

  const getDetachedViewerTasks = (): TaskState[] => [...lastKnownTaskStates.keys()].map(
    (taskId) => JSON.parse(lastKnownTaskStates.get(taskId) ?? '{}') as TaskState,
  );

  const listWorkflowsByStartupRecency = (): WorkflowMeta[] => {
    const startedAtMs = Date.now();
    const workflows = deps.persistence.listWorkflows();
    deps.recordStartupDuration('listWorkflowsByStartupRecency', startedAtMs, {
      workflowCount: workflows.length,
    });
    return [...workflows].sort((left, right) => {
      const rightTs = Date.parse(right.updatedAt ?? '') || 0;
      const leftTs = Date.parse(left.updatedAt ?? '') || 0;
      if (rightTs !== leftTs) {
        return rightTs - leftTs;
      }
      return right.createdAt.localeCompare(left.createdAt);
    });
  };

  const bootstrapInitialWorkflowState = (): void => {
    const workflows = listWorkflowsByStartupRecency();
    startupWorkflowCache.set(workflows);
    lastKnownWorkflowCount = workflows.length;
    startupWorkflowId = workflows[0]?.id ?? null;
    if (!startupWorkflowId) {
      deps.logger.info('[init] No workflows available for initial startup bootstrap', { module: 'init' });
      return;
    }
    try {
      const startedAtMs = Date.now();
      deps.getOrchestrator().syncAllFromDb();
      deps.recordStartupDuration('orchestrator.restore.full-snapshot', startedAtMs, {
        workflowCount: workflows.length,
        taskCount: deps.getOrchestrator().getAllTasks().length,
      });
      const snapshotStats = deps.persistence.getLastWorkflowTaskSnapshotStats();
      if (snapshotStats) {
        deps.recordStartupDetail('sqlite.workflow-metadata.query', {
          durationMs: snapshotStats.workflowMetadataQueryMs,
          workflowCount: snapshotStats.workflowCount,
        });
        deps.recordStartupDetail('sqlite.tasks.query', {
          durationMs: snapshotStats.taskQueryMs,
          taskCount: snapshotStats.taskCount,
        });
        deps.recordStartupDetail('sqlite.workflow-rollups.compute', {
          durationMs: snapshotStats.rollupComputationMs,
          workflowCount: snapshotStats.workflowCount,
          taskCount: snapshotStats.taskCount,
        });
        deps.recordStartupDetail('sqlite.tasks.deserialize-reconcile', {
          durationMs: snapshotStats.taskDeserializeReconcileMs,
          taskCount: snapshotStats.taskCount,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deps.logger.error(`workflow invariant violation during full startup bootstrap: ${message}`, {
        module: 'init',
        error: message,
      });
      throw err;
    }
    deps.logger.info(
      `[init] Bootstrapped full workflow graph with ${deps.getOrchestrator().getAllTasks().length} tasks across ${workflows.length} workflows`,
      { module: 'init' },
    );
    deps.recordStartupMark('startup.full-graph.ready', {
      workflowId: startupWorkflowId,
      taskCount: deps.getOrchestrator().getAllTasks().length,
      workflowCount: workflows.length,
    });
  };

  const publishOrchestratorSnapshotToRenderer = (): void => {
    const workflows = deps.persistence.listWorkflows();
    const tasks = deps.getOrchestrator().getAllTasks();
    const previousTaskIds = new Set(lastKnownTaskStates.keys());
    lastKnownTaskStates.clear();
    workflowRollupProjection.replaceAll(tasks);
    for (const task of tasks) {
      const snapshot = JSON.stringify(task);
      previousTaskIds.delete(task.id);
      lastKnownTaskStates.set(task.id, snapshot);
      const mainWindow = deps.getMainWindow();
      if (mainWindow && !mainWindow.isDestroyed()) {
        publishTaskDeltaToRenderer({ type: 'created', task });
      }
    }
    lastKnownWorkflowCount = workflows.length;
    const mainWindow = deps.getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      for (const removedTaskId of previousTaskIds) {
        publishTaskDeltaToRenderer({ type: 'removed', taskId: removedTaskId, previousTaskStateVersion: 0 });
      }
      requestWorkflowMetadataPublish('orchestrator-snapshot');
    }
  };

  const startTaskDeltaSubscription = (ownerMode: boolean): RendererTaskFeedStopHandle => {
    // Forward deltas to renderer and keep snapshot cache in sync so
    // the db-poll doesn't re-emit deltas the messageBus already delivered.
    // Detached viewer: buffer owner deltas until hydration seeds the cache.
    if (!ownerMode) {
      detachedDeltaBuffer = [];
    }
    const unsubscribe = deps.messageBus.subscribe(Channels.TASK_DELTA, (delta: unknown) => {
      const d = delta as TaskDelta;
      if (detachedDeltaBuffer) {
        detachedDeltaBuffer.push(d);
        return;
      }
      processIncomingTaskDelta(d);
    });
    return { stop: unsubscribe };
  };

  const startTaskOutputSubscription = (): RendererTaskFeedStopHandle => {
    const unsubscribe = deps.messageBus.subscribe(Channels.TASK_OUTPUT, (data: unknown) => {
      const mainWindow = deps.getMainWindow();
      if (mainWindow && !mainWindow.isDestroyed() && deps.isUiInteractive()) {
        mainWindow.webContents.send('invoker:task-output', data);
      }
    });
    return { stop: unsubscribe };
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
      stop: () => clearInterval(interval),
    };
  };

  const startDbPolling = (startupPollDelayMs: number): RendererTaskFeedStopHandle => {
    let interval: NodeJS.Timeout | null = null;
    const timeout = setTimeout(() => {
      interval = setInterval(() => {
        const mainWindow = deps.getMainWindow();
        if (!mainWindow || mainWindow.isDestroyed()) return;
        try {
          const workflows = deps.persistence.listWorkflows();

          if (workflows.length !== lastKnownWorkflowCount) {
            const msg = `Workflow count changed: ${lastKnownWorkflowCount} → ${workflows.length}`;
            deps.logger.info(msg, { module: 'db-poll' });
            try { deps.persistence.writeActivityLog('db-poll', 'info', msg); } catch { /* db locked */ }
            lastKnownWorkflowCount = workflows.length;
            requestWorkflowMetadataPublish('db-poll-count');

            deps.getOrchestrator().syncAllFromDb();
            deps.logger.info(`Synced orchestrator for all ${workflows.length} workflows`, { module: 'db-poll' });
          }

          for (const wf of workflows) {
            if (wf.status === 'completed' || wf.status === 'failed') continue;
            const tasks = deps.persistence.loadTasks(wf.id);
            for (const loadedTask of tasks) {
              const task = loadedTask;
              const now = new Date();
              const previousHeartbeat = parseExecutionDate(task.execution.lastHeartbeatAt);
              const selectedAttempt = task.execution.selectedAttemptId
                ? deps.persistence.loadAttempt?.(task.execution.selectedAttemptId)
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
                  deps.logger.info(
                    `[executing-stall] detected task="${task.id}" phase=${task.execution.phase} executingAgeMs=${executingAgeMs} ` +
                      `handlePresent=${deps.getTaskHandles().has(task.id)} leaseExpired=${leaseExpired} heartbeatStale=${heartbeatStale} ` +
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
                  executingStallTimeoutMs,
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
              const prev = lastKnownTaskStates.get(task.id);
              if (!prev) {
                if (traceDbPollPerTask) {
                  const msg = `New task: ${task.id} (${task.status})`;
                  deps.logger.info(msg, { module: 'db-poll' });
                  try { deps.persistence.writeActivityLog('db-poll', 'info', msg); } catch { /* db locked */ }
                }
                lastKnownTaskStates.set(task.id, snapshot);
                deps.uiPerfStats.dbPollCreated += 1;
                publishTaskDeltaToRenderer({ type: 'created', task });
              } else if (prev !== snapshot) {
                if (traceDbPollPerTask) {
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
          const launchDispatcher = deps.getLaunchDispatcher();
          if (launchDispatcher) {
            try {
              launchDispatcher.poll();
            } catch (err) {
              deps.logger.warn(
                `[launch-dispatcher] poll() failed: ${err instanceof Error ? err.message : String(err)}`,
                { module: 'db-poll' },
              );
            }
          }
        } catch {
          // DB might be locked — skip this tick
        }
      }, 2000);
    }, startupPollDelayMs);
    timeout.unref?.();
    return {
      stop: () => {
        clearTimeout(timeout);
        if (interval) {
          clearInterval(interval);
          interval = null;
        }
      },
    };
  };

  return {
    enqueueTaskOutput,
    flushTaskOutput,
    getTaskDeltaStreamSequence,
    requestWorkflowMetadataPublish,
    publishSnapshot: (reason, tasks, workflows) => taskGraphEventPublisher.publishSnapshot(reason, tasks, workflows),
    publishTaskDeltaToRenderer,
    seedUiSnapshotCache,
    hydrateDetachedViewerFromOwner,
    getDetachedViewerTasks,
    getDetachedViewerWorkflows: () => detachedViewerWorkflows,
    getBootstrapWorkflows: (fallback = listWorkflowsByStartupRecency) => detachedViewerWorkflows ?? startupWorkflowCache.takeOrLoad(fallback),
    getInitialWorkflowId: () => startupWorkflowId,
    getPreviousTaskStateVersion: (taskId, before) => {
      const previousSnapshot = lastKnownTaskStates.get(taskId);
      if (!previousSnapshot) return before?.taskStateVersion ?? 0;
      const parsed: unknown = JSON.parse(previousSnapshot);
      if (parsed && typeof parsed === 'object' && 'taskStateVersion' in parsed && typeof parsed.taskStateVersion === 'number') {
        return parsed.taskStateVersion;
      }
      return before?.taskStateVersion ?? 1;
    },
    replaceKnownTasksFromOrchestrator: (tasks) => {
      workflowRollupProjection.replaceAll(tasks);
      for (const task of tasks) {
        lastKnownTaskStates.set(task.id, JSON.stringify(task));
        const mainWindow = deps.getMainWindow();
        if (mainWindow && !mainWindow.isDestroyed()) {
          publishTaskDeltaToRenderer({ type: 'created', task });
        }
      }
    },
    resetRendererState: () => {
      lastKnownTaskStates.clear();
      workflowRollupProjection.clear();
      lastKnownWorkflowCount = 0;
    },
    setLastKnownWorkflowCount: (count) => {
      lastKnownWorkflowCount = count;
    },
    bootstrapInitialWorkflowState,
    publishOrchestratorSnapshotToRenderer,
    startTaskDeltaSubscription,
    startTaskOutputSubscription,
    startActivityPolling,
    startDbPolling,
  };
}
