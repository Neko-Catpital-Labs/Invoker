import type { BrowserWindow } from 'electron';
import type { Logger, TaskGraphEvent, WorkflowMeta, WorkResponse } from '@invoker/contracts';
import type { SQLiteAdapter, Workflow } from '@invoker/data-store';
import type { MessageBus } from '@invoker/transport';
import { Channels } from '@invoker/transport';
import type { Orchestrator, TaskDelta, TaskState } from '@invoker/workflow-core';
import type { TaskOutputData } from '../types.js';
import { createStartupWorkflowCache } from '../bootstrap/startup-workflow-cache.js';
import { applyDelta, recoverQuarantinedTask, TaskSnapshotCache } from '../delta-merge.js';
import { CoalescedWorkflowMetadataPublisher } from '../workflow-metadata-invalidation.js';
import { WorkflowRollupProjection } from '../workflow-rollup-projection.js';
import { seedTaskCachesFromSnapshot } from '../viewer-cache-hydration.js';
import { shouldSkipAutoFixForError } from '../auto-fix-gating.js';
import { createTaskGraphEventPublisher } from '../task-graph-event-publisher.js';
import type { TaskDeltaStreamSequence } from '../task-delta-stream-sequence.js';
import { evaluateExecutingStall } from '../executing-stall.js';
import { persistShutdownDiagnostic } from '../shutdown-diagnostic.js';

interface RendererTaskFeedUiPerfStats {
  mainDeltaToUi: number;
  dbPollCreated: number;
  dbPollUpdatedAsCreated: number;
  dbPollUpdatedAsUpdated: number;
  workflowMetadataPublishRequests: number;
  workflowMetadataPublishes: number;
  workflowMetadataCoalescedRequests: number;
  largeTaskDeltaBatches: number;
  maxTaskDeltaBatchSize: number;
}

interface PollableLaunchDispatcher {
  poll(): void;
}

export interface RendererTaskFeedStopHandle {
  stop(): void;
}

export interface RendererTaskFeedDeps {
  getMainWindow: () => BrowserWindow | null;
  isUiInteractive: () => boolean;
  getOrchestrator: () => Orchestrator;
  getPersistence: () => SQLiteAdapter;
  getMessageBus: () => MessageBus;
  getOwnerMode: () => boolean;
  getLaunchDispatcher: () => PollableLaunchDispatcher | null;
  hasTaskHandle: (taskId: string) => boolean;
  taskDeltaStream: TaskDeltaStreamSequence;
  uiPerfStats: RendererTaskFeedUiPerfStats;
  recordStartupMark: (phase: string, extra?: Record<string, unknown>) => void;
  recordStartupDuration: (phase: string, startedAtMs: number, extra?: Record<string, unknown>) => void;
  recordStartupDetail: (phase: string, details: Record<string, unknown>) => void;
  logAutoFixDebug: (taskId: string, phase: string, details?: Record<string, unknown>) => void;
  scheduleAutoFix: (taskId: string) => void;
  onTaskGraphEvent?: (event: TaskGraphEvent) => void;
  getLogger: () => Logger;
}

export interface RendererTaskFeed {
  flushTaskOutput(taskId: string): void;
  enqueueTaskOutput(taskId: string, data: string): void;
  publishTaskDeltaToRenderer(delta: TaskDelta): void;
  publishTaskGraphSnapshot(reason: string, tasks: TaskState[], workflows: WorkflowMeta[]): void;
  publishOrchestratorSnapshotToRenderer(): void;
  requestWorkflowMetadataPublish(reason: string): void;
  seedUiSnapshotCache(): void;
  hydrateDetachedViewerFromOwner(): Promise<void>;
  detachedViewerTasks(): TaskState[];
  loadTaskByIdFromPersistence(taskId: string): TaskState | undefined;
  listWorkflowsByStartupRecency(): Workflow[];
  bootstrapInitialWorkflowState(): void;
  startFeedSubscriptions(): RendererTaskFeedStopHandle;
  startDbPolling(startupPollDelayMs: number): RendererTaskFeedStopHandle;
  getTaskDeltaStreamSequence(): number;
  getCachedTaskSnapshot(taskId: string): string | undefined;
  getDetachedViewerWorkflows(): unknown[] | null;
  getInitialWorkflowId(): string | null;
  takeOrLoadStartupWorkflows(): Workflow[];
  replaceTaskSnapshotAndPublishCreated(tasks: TaskState[]): void;
  clearRendererState(reason: string): void;
  syncLastKnownWorkflowCount(count: number): void;
}

const parseExecutionDate = (value: unknown): Date | undefined => {
  if (!value) return undefined;
  if (value instanceof Date) return value;
  if (typeof value !== 'string') return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
};

export function createRendererTaskFeed(deps: RendererTaskFeedDeps): RendererTaskFeed {
  const lastKnownTaskStates = new TaskSnapshotCache();
  const workflowRollupProjection = new WorkflowRollupProjection();
  const pendingOutputBuffers = new Map<string, string[]>();
  const outputFlushTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let lastKnownWorkflowCount = 0;
  let startupWorkflowId: string | null = null;
  const startupWorkflowCache = createStartupWorkflowCache();
  // In detached viewer mode the local DB is an empty in-memory copy. Workflow
  // metadata for the bootstrap getter comes from the owner snapshot; task state
  // is derived live from `lastKnownTaskStates` (kept current by deltas).
  let detachedViewerWorkflows: unknown[] | null = null;
  // While the detached viewer hydrates, owner deltas are buffered here and
  // replayed after the cache is seeded, so an update arriving mid-hydration is
  // not applied against an empty cache (quarantined and dropped).
  let detachedDeltaBuffer: TaskDelta[] | null = null;
  const traceUiDeltaFlow = process.env.INVOKER_TRACE_UI_DELTA === '1';
  const traceDbPollPerTask = process.env.INVOKER_TRACE_DB_POLL === '1';
  const traceTaskOutput = process.env.INVOKER_TRACE_TASK_OUTPUT === '1';
  const executingStallTimeoutMs = Number.parseInt(
    process.env.INVOKER_EXECUTING_STALL_TIMEOUT_MS ?? '180000',
    10,
  ) || 180000;

  const logger = (): Logger => deps.getLogger();

  const timeStartupPhase = <T>(phase: string, work: () => T, extra?: (result: T) => Record<string, unknown>): T => {
    const startedAtMs = Date.now();
    const result = work();
    deps.recordStartupDuration(phase, startedAtMs, extra?.(result));
    return result;
  };

  const taskGraphEventPublisher = createTaskGraphEventPublisher({
    getMainWindow: deps.getMainWindow,
    isUiInteractive: deps.isUiInteractive,
    stampDelta: (delta) => deps.taskDeltaStream.stamp(delta),
    getStreamSequence: () => deps.taskDeltaStream.current(),
    onLargeBatch: ({ batchSize, remaining }) => {
      deps.uiPerfStats.largeTaskDeltaBatches += 1;
      deps.uiPerfStats.maxTaskDeltaBatchSize = Math.max(deps.uiPerfStats.maxTaskDeltaBatchSize, batchSize);
      logger().info(`large task-graph-event batch chunked size=${batchSize} remaining=${remaining}`, {
        module: 'ui-backpressure',
      });
    },
    onEvent: deps.onTaskGraphEvent,
  });

  const workflowMetadataPublisher = new CoalescedWorkflowMetadataPublisher({
    listWorkflows: () => deps.getPersistence().listWorkflows(),
    publish: (workflows, stats) => {
      lastKnownWorkflowCount = workflows.length;
      deps.uiPerfStats.workflowMetadataPublishes += 1;
      deps.uiPerfStats.workflowMetadataCoalescedRequests += Math.max(0, stats.coalescedRequests - 1);
      if (stats.coalescedRequests > 1) {
        logger().info(
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
      logger().info(`${taskId}: ${data.trimEnd()}`, { module: 'output' });
    }
    const outputData: TaskOutputData = { taskId, data };
    deps.getMessageBus().publish(Channels.TASK_OUTPUT, outputData);
    try {
      // Runner stream chunks land in the output spool only — task_output is
      // reserved for explicit diagnostic writes (workflow actions, shutdown).
      deps.getPersistence().appendOutputChunk(taskId, data);
    } catch (err) {
      logger().error(`Failed to persist output for ${taskId}: ${err}`, { module: 'output' });
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

  const loadTaskByIdFromPersistence = (taskId: string): TaskState | undefined => {
    return deps.getPersistence().loadTask(taskId);
  };

  const applyTaskDeltaToOwnerCacheOrRecover = (delta: TaskDelta): TaskDelta[] => {
    const { quarantined, accepted } = applyDelta(delta, lastKnownTaskStates);
    if (quarantined.length === 0) {
      return accepted ? [delta] : [];
    }

    const rendererDeltas: TaskDelta[] = [];
    for (const taskId of quarantined) {
      logger().info(`[gap-detect] quarantined task="${taskId}" — triggering authoritative reload`, { module: 'delta-merge' });
      const { rendererDelta } = recoverQuarantinedTask(lastKnownTaskStates, taskId, {
        loadTask: loadTaskByIdFromPersistence,
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

  function seedUiSnapshotCache(): void {
    lastKnownWorkflowCount = deps.getPersistence().listWorkflows().length;
    seedTaskCachesFromSnapshot(deps.getOrchestrator().getAllTasks(), { lastKnownTaskStates, workflowRollupProjection });
  }

  // Detached viewer: the local DB is empty, so seed the delta caches and
  // bootstrap snapshot from the owner. Without this, the empty cache quarantines
  // every `updated` delta for a task the viewer has not seen (dropping live
  // updates), and bootstrap getters return nothing. Failures are non-fatal — the
  // renderer's delegated reads still populate the view.
  async function hydrateDetachedViewerFromOwner(): Promise<void> {
    try {
      const snapshot = await deps.getMessageBus().request<{ kind: string }, { tasks?: TaskState[]; workflows?: unknown[] }>(
        'headless.query',
        { kind: 'tasks' },
      );
      const tasks = Array.isArray(snapshot?.tasks) ? snapshot.tasks : [];
      const workflows = Array.isArray(snapshot?.workflows) ? snapshot.workflows : [];
      detachedViewerWorkflows = workflows;
      seedTaskCachesFromSnapshot(tasks, { lastKnownTaskStates, workflowRollupProjection });
      lastKnownWorkflowCount = workflows.length;
      startupWorkflowId = [...workflows]
        .map((wf) => wf as { id?: string; updatedAt?: string; createdAt?: string })
        .sort((left, right) => (Date.parse(right.updatedAt ?? '') || 0) - (Date.parse(left.updatedAt ?? '') || 0))[0]?.id ?? null;
      logger().info(
        `[init] Hydrated detached viewer from owner: ${tasks.length} tasks across ${workflows.length} workflows`,
        { module: 'init' },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger().warn(`detached viewer hydration from owner failed; relying on delegated reads: ${message}`, { module: 'init' });
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
    deps.uiPerfStats.mainDeltaToUi += 1;
    if (traceUiDeltaFlow) {
      logger().debug(`delta→ui: ${JSON.stringify(d)}`, { module: 'ui' });
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
  }

  function listWorkflowsByStartupRecency(): Workflow[] {
    const workflows = timeStartupPhase('listWorkflowsByStartupRecency', () => deps.getPersistence().listWorkflows(), (result) => ({
      workflowCount: result.length,
    }));
    return [...workflows].sort((left, right) => {
      const rightTs = Date.parse(right.updatedAt ?? '') || 0;
      const leftTs = Date.parse(left.updatedAt ?? '') || 0;
      if (rightTs !== leftTs) {
        return rightTs - leftTs;
      }
      return right.createdAt.localeCompare(left.createdAt);
    });
  }

  function bootstrapInitialWorkflowState(): void {
    const workflows = listWorkflowsByStartupRecency();
    startupWorkflowCache.set(workflows);
    lastKnownWorkflowCount = workflows.length;
    startupWorkflowId = workflows[0]?.id ?? null;
    if (!startupWorkflowId) {
      logger().info('[init] No workflows available for initial startup bootstrap', { module: 'init' });
      return;
    }
    try {
      timeStartupPhase('orchestrator.restore.full-snapshot', () => deps.getOrchestrator().syncAllFromDb(), () => ({
        workflowCount: workflows.length,
        taskCount: deps.getOrchestrator().getAllTasks().length,
      }));
      const snapshotStats = (deps.getPersistence() as unknown as {
        getLastWorkflowTaskSnapshotStats?: () => Record<string, unknown> | null;
      }).getLastWorkflowTaskSnapshotStats?.();
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
      logger().error(`workflow invariant violation during full startup bootstrap: ${message}`, {
        module: 'init',
        error: message,
      });
      throw err;
    }
    logger().info(
      `[init] Bootstrapped full workflow graph with ${deps.getOrchestrator().getAllTasks().length} tasks across ${workflows.length} workflows`,
      { module: 'init' },
    );
    deps.recordStartupMark('startup.full-graph.ready', {
      workflowId: startupWorkflowId,
      taskCount: deps.getOrchestrator().getAllTasks().length,
      workflowCount: workflows.length,
    });
  }

  function publishOrchestratorSnapshotToRenderer(): void {
    const workflows = deps.getPersistence().listWorkflows();
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
  }

  function startFeedSubscriptions(): RendererTaskFeedStopHandle {
    // Forward deltas to renderer and keep snapshot cache in sync so
    // the db-poll doesn't re-emit deltas the messageBus already delivered.
    // Detached viewer: buffer owner deltas until hydration seeds the cache.
    if (!deps.getOwnerMode()) {
      detachedDeltaBuffer = [];
    }
    const messageBus = deps.getMessageBus();
    const unsubscribeTaskDelta = messageBus.subscribe(Channels.TASK_DELTA, (delta: unknown) => {
      const d = delta as TaskDelta;
      if (detachedDeltaBuffer) {
        detachedDeltaBuffer.push(d);
        return;
      }
      processIncomingTaskDelta(d);
    });

    const unsubscribeTaskOutput = messageBus.subscribe(Channels.TASK_OUTPUT, (data: unknown) => {
      const mainWindow = deps.getMainWindow();
      if (mainWindow && !mainWindow.isDestroyed() && deps.isUiInteractive()) {
        mainWindow.webContents.send('invoker:task-output', data);
      }
    });

    return {
      stop(): void {
        unsubscribeTaskDelta();
        unsubscribeTaskOutput();
      },
    };
  }

  function startDbPolling(startupPollDelayMs: number): RendererTaskFeedStopHandle {
    let dbPollInterval: ReturnType<typeof setInterval> | null = null;
    let stopped = false;
    const startupPollTimer = setTimeout(() => {
      if (stopped || !deps.getOwnerMode()) return;
      dbPollInterval = setInterval(() => {
        const mainWindow = deps.getMainWindow();
        if (!mainWindow || mainWindow.isDestroyed()) return;
        try {
          const persistence = deps.getPersistence();
          const orchestrator = deps.getOrchestrator();
          const workflows = persistence.listWorkflows();

          if (workflows.length !== lastKnownWorkflowCount) {
            const msg = `Workflow count changed: ${lastKnownWorkflowCount} → ${workflows.length}`;
            logger().info(msg, { module: 'db-poll' });
            try { persistence.writeActivityLog('db-poll', 'info', msg); } catch { /* db locked */ }
            lastKnownWorkflowCount = workflows.length;
            requestWorkflowMetadataPublish('db-poll-count');

            orchestrator.syncAllFromDb();
            logger().info(`Synced orchestrator for all ${workflows.length} workflows`, { module: 'db-poll' });
          }

          for (const wf of workflows) {
            if (wf.status === 'completed' || wf.status === 'failed') continue;
            const tasks = persistence.loadTasks(wf.id);
            for (const loadedTask of tasks) {
              let task = loadedTask;
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
                  logger().info(
                    `[executing-stall] detected task="${task.id}" phase=${task.execution.phase} executingAgeMs=${executingAgeMs} ` +
                      `handlePresent=${deps.hasTaskHandle(task.id)} leaseExpired=${leaseExpired} heartbeatStale=${heartbeatStale} ` +
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
                  logger().error(`[executing-stall] forcing failure for "${task.id}": ${executingError}`, { module: 'db-poll' });
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
                  logger().error(`[fix-session-stall] reclaiming "${task.id}": ${reason}`, { module: 'db-poll' });
                  const outcome = orchestrator.reclaimStalledFixSession(task.id, {
                    reason,
                    expectedLineage: {
                      taskId: task.id,
                      selectedAttemptId: task.execution.selectedAttemptId,
                      generation: task.execution.generation ?? 0,
                    },
                  });
                  logger().info(
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
                  logger().info(msg, { module: 'db-poll' });
                  try { persistence.writeActivityLog('db-poll', 'info', msg); } catch { /* db locked */ }
                }
                lastKnownTaskStates.set(task.id, snapshot);
                deps.uiPerfStats.dbPollCreated += 1;
                publishTaskDeltaToRenderer({ type: 'created', task });
              } else if (prev !== snapshot) {
                if (traceDbPollPerTask) {
                  const msg = `Task updated: ${task.id} (${task.status})`;
                  logger().info(msg, { module: 'db-poll' });
                  try { persistence.writeActivityLog('db-poll', 'info', msg); } catch { /* db locked */ }
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
              logger().warn(
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
    startupPollTimer.unref?.();

    return {
      stop(): void {
        stopped = true;
        clearTimeout(startupPollTimer);
        if (dbPollInterval) {
          clearInterval(dbPollInterval);
          dbPollInterval = null;
        }
      },
    };
  }

  return {
    flushTaskOutput,
    enqueueTaskOutput,
    publishTaskDeltaToRenderer,
    publishTaskGraphSnapshot(reason, tasks, workflows): void {
      taskGraphEventPublisher.publishSnapshot(reason, tasks, workflows);
    },
    publishOrchestratorSnapshotToRenderer,
    requestWorkflowMetadataPublish,
    seedUiSnapshotCache,
    hydrateDetachedViewerFromOwner,
    detachedViewerTasks,
    loadTaskByIdFromPersistence,
    listWorkflowsByStartupRecency,
    bootstrapInitialWorkflowState,
    startFeedSubscriptions,
    startDbPolling,
    getTaskDeltaStreamSequence(): number {
      return deps.taskDeltaStream.current();
    },
    getCachedTaskSnapshot(taskId): string | undefined {
      return lastKnownTaskStates.get(taskId);
    },
    getDetachedViewerWorkflows(): unknown[] | null {
      return detachedViewerWorkflows;
    },
    getInitialWorkflowId(): string | null {
      return startupWorkflowId;
    },
    takeOrLoadStartupWorkflows(): Workflow[] {
      return startupWorkflowCache.takeOrLoad(listWorkflowsByStartupRecency);
    },
    replaceTaskSnapshotAndPublishCreated(tasks): void {
      workflowRollupProjection.replaceAll(tasks);
      for (const task of tasks) {
        lastKnownTaskStates.set(task.id, JSON.stringify(task));
        const mainWindow = deps.getMainWindow();
        if (mainWindow && !mainWindow.isDestroyed()) {
          publishTaskDeltaToRenderer({ type: 'created', task });
        }
      }
    },
    clearRendererState(reason): void {
      lastKnownTaskStates.clear();
      workflowRollupProjection.clear();
      lastKnownWorkflowCount = 0;
      requestWorkflowMetadataPublish(reason);
    },
    syncLastKnownWorkflowCount(count): void {
      lastKnownWorkflowCount = count;
    },
  };
}
