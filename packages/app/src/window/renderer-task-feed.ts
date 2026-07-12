import type {
  Logger,
  TaskGraphEvent,
  WorkflowMeta,
  WorkResponse,
} from '@invoker/contracts';
import type { SQLiteAdapter } from '@invoker/data-store';
import { Channels, type MessageBus } from '@invoker/transport';
import type { Orchestrator, TaskDelta, TaskState } from '@invoker/workflow-core';
import type { BrowserWindow } from 'electron';
import { shouldSkipAutoFixForError } from '../auto-fix-gating.js';
import { applyDelta, recoverQuarantinedTask, TaskSnapshotCache } from '../delta-merge.js';
import { evaluateExecutingStall, taskNeedsExecutingStallCheck } from '../executing-stall.js';
import type { TaskGraphEventPublisher } from '../task-graph-event-publisher.js';
import { createTaskGraphEventPublisher } from '../task-graph-event-publisher.js';
import { createTaskDeltaStreamSequence } from '../task-delta-stream-sequence.js';
import type { TaskOutputData } from '../types.js';
import { seedTaskCachesFromSnapshot } from '../viewer-cache-hydration.js';
import { WorkflowRollupProjection } from '../workflow-rollup-projection.js';
import type { TaskHandleMap } from '../execution/task-runner-wiring.js';

export interface RendererTaskFeedUiPerfStats {
  [key: string]: unknown;
  mainDeltaToUi: number;
  dbPollCreated: number;
  dbPollUpdatedAsCreated: number;
  workflowMetadataPublishes: number;
  workflowMetadataCoalescedRequests: number;
  largeTaskDeltaBatches: number;
  maxTaskDeltaBatchSize: number;
}

export interface RendererTaskFeedPollHandle {
  stop(): void;
}

export interface RendererTaskFeedDeps {
  logger: Logger;
  orchestrator: Orchestrator;
  persistence: SQLiteAdapter;
  messageBus: MessageBus;
  getMainWindow: () => BrowserWindow | null;
  isUiInteractive: () => boolean;
  broadcastTaskGraphEvent: (event: TaskGraphEvent) => void;
  scheduleAutoFix: (taskId: string) => void;
  logAutoFixDebug: (taskId: string, phase: string, details?: Record<string, unknown>) => void;
  requestWorkflowMetadataPublish: (reason: string) => void;
  persistShutdownDiagnostic: (task: TaskState, options: {
    flushPendingOutput?: (taskId: string) => void;
    forcedStopReason?: string;
    label?: string;
  }) => void;
  setStartupWorkflowId: (workflowId: string | null) => void;
  getLaunchDispatcher: () => { poll(): void } | null;
  taskHandles: TaskHandleMap;
  uiPerfStats: RendererTaskFeedUiPerfStats;
  traceUiDeltaFlow: boolean;
  traceDbPollPerTask: boolean;
  traceTaskOutput: boolean;
  executingStallTimeoutMs: number;
}

export interface RendererTaskFeed {
  enqueueTaskOutput(taskId: string, data: string): void;
  flushTaskOutput(taskId: string): void;
  publishSnapshot(reason: string, tasks: TaskState[], workflows: WorkflowMeta[], forced?: boolean): void;
  getTaskDeltaStreamSequence(): number;
  seedUiSnapshotCache(): void;
  hydrateDetachedViewerFromOwner(): Promise<void>;
  enableDetachedDeltaBuffering(): void;
  handleTaskDelta(delta: TaskDelta): void;
  getTasks(): TaskState[];
  getDetachedViewerWorkflows(): unknown[] | null;
  getPreviousTaskStateVersion(taskId: string, fallbackTask?: TaskState): number;
  clearState(): void;
  setWorkflowCount(count: number): void;
  setTaskSnapshotsFromOrchestrator(tasks: TaskState[], emitCreatedDeltas?: boolean): void;
  startDbPolling(startupPollDelayMs: number): RendererTaskFeedPollHandle;
  startActivityPolling(): RendererTaskFeedPollHandle;
}

function parseExecutionDate(value: unknown): Date | undefined {
  if (!value) return undefined;
  if (value instanceof Date) return value;
  if (typeof value !== 'string') return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function workflowIdentity(workflow: unknown): {
  id?: string;
  updatedAt?: string;
  createdAt?: string;
} {
  if (!workflow || typeof workflow !== 'object') return {};
  return {
    id: 'id' in workflow && typeof workflow.id === 'string' ? workflow.id : undefined,
    updatedAt: 'updatedAt' in workflow && typeof workflow.updatedAt === 'string' ? workflow.updatedAt : undefined,
    createdAt: 'createdAt' in workflow && typeof workflow.createdAt === 'string' ? workflow.createdAt : undefined,
  };
}

function taskStateVersionFromSnapshot(snapshot: string | undefined): number | undefined {
  if (!snapshot) return undefined;
  const parsed: unknown = JSON.parse(snapshot);
  if (!parsed || typeof parsed !== 'object' || !('taskStateVersion' in parsed)) {
    return undefined;
  }
  return typeof parsed.taskStateVersion === 'number' ? parsed.taskStateVersion : undefined;
}

export function createRendererTaskFeed(deps: RendererTaskFeedDeps): RendererTaskFeed {
  const lastKnownTaskStates = new TaskSnapshotCache();
  const workflowRollupProjection = new WorkflowRollupProjection();
  const pendingOutputBuffers = new Map<string, string[]>();
  const outputFlushTimers = new Map<string, NodeJS.Timeout>();
  let lastKnownWorkflowCount = 0;
  let detachedViewerWorkflows: unknown[] | null = null;
  let detachedDeltaBuffer: TaskDelta[] | null = null;
  const taskDeltaStream = createTaskDeltaStreamSequence();
  const taskGraphEventPublisher: TaskGraphEventPublisher = createTaskGraphEventPublisher({
    getMainWindow: deps.getMainWindow,
    isUiInteractive: deps.isUiInteractive,
    stampDelta: (delta) => taskDeltaStream.stamp(delta),
    getStreamSequence: () => taskDeltaStream.current(),
    onLargeBatch: ({ batchSize, remaining }) => {
      deps.uiPerfStats.largeTaskDeltaBatches += 1;
      deps.uiPerfStats.maxTaskDeltaBatchSize = Math.max(deps.uiPerfStats.maxTaskDeltaBatchSize, batchSize);
      deps.logger.info(`large task-graph-event batch chunked size=${batchSize} remaining=${remaining}`, {
        module: 'ui-backpressure',
      });
    },
    onEvent: (event) => deps.broadcastTaskGraphEvent(event),
  });

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
        loadTask: (recoveredTaskId) => deps.persistence.loadTask(recoveredTaskId),
        getMergeNode: (workflowId) => deps.orchestrator.getMergeNode(workflowId),
      });
      if (rendererDelta) {
        rendererDeltas.push(rendererDelta);
      }
    }
    return rendererDeltas;
  };

  const processIncomingTaskDelta = (delta: TaskDelta): void => {
    deps.uiPerfStats.mainDeltaToUi += 1;
    if (deps.traceUiDeltaFlow) {
      deps.logger.debug(`delta→ui: ${JSON.stringify(delta)}`, { module: 'ui' });
    }
    const deltaTaskId = delta.type === 'updated' || delta.type === 'removed' ? delta.taskId : undefined;
    if (delta.type === 'updated' && delta.changes.status === 'failed') {
      const cancellationError = shouldSkipAutoFixForError(delta.changes.execution?.error);
      const shouldAutoFixFromOrchestrator = deps.orchestrator.shouldAutoFix(delta.taskId);
      deps.logAutoFixDebug(delta.taskId, 'delta-failed', {
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
    for (const rendererDelta of applyTaskDeltaToOwnerCacheOrRecover(delta)) {
      publishTaskDeltaToRenderer(rendererDelta);
    }
  };

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

  return {
    enqueueTaskOutput,
    flushTaskOutput,

    publishSnapshot(reason: string, tasks: TaskState[], workflows: WorkflowMeta[], forced?: boolean): void {
      taskGraphEventPublisher.publishSnapshot(reason, tasks, workflows, forced);
    },

    getTaskDeltaStreamSequence(): number {
      return taskDeltaStream.current();
    },

    seedUiSnapshotCache(): void {
      lastKnownWorkflowCount = deps.persistence.listWorkflows().length;
      seedTaskCachesFromSnapshot(deps.orchestrator.getAllTasks(), { lastKnownTaskStates, workflowRollupProjection });
    },

    async hydrateDetachedViewerFromOwner(): Promise<void> {
      try {
        const snapshot = await deps.messageBus.request<{ kind: string }, { tasks?: TaskState[]; workflows?: unknown[] }>(
          'headless.query',
          { kind: 'tasks' },
        );
        const tasks = Array.isArray(snapshot?.tasks) ? snapshot.tasks : [];
        const workflows = Array.isArray(snapshot?.workflows) ? snapshot.workflows : [];
        detachedViewerWorkflows = workflows;
        seedTaskCachesFromSnapshot(tasks, { lastKnownTaskStates, workflowRollupProjection });
        lastKnownWorkflowCount = workflows.length;
        const latestWorkflow = [...workflows]
          .map((workflow) => workflowIdentity(workflow))
          .sort((left, right) => (Date.parse(right.updatedAt ?? '') || 0) - (Date.parse(left.updatedAt ?? '') || 0))[0];
        deps.setStartupWorkflowId(latestWorkflow?.id ?? null);
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
    },

    enableDetachedDeltaBuffering(): void {
      detachedDeltaBuffer = [];
    },

    handleTaskDelta(delta: TaskDelta): void {
      if (detachedDeltaBuffer) {
        detachedDeltaBuffer.push(delta);
        return;
      }
      processIncomingTaskDelta(delta);
    },

    getTasks(): TaskState[] {
      return [...lastKnownTaskStates.keys()].map((taskId) => JSON.parse(lastKnownTaskStates.get(taskId) ?? '{}') as TaskState);
    },

    getDetachedViewerWorkflows(): unknown[] | null {
      return detachedViewerWorkflows;
    },

    getPreviousTaskStateVersion(taskId: string, fallbackTask?: TaskState): number {
      const previousSnapshot = lastKnownTaskStates.get(taskId);
      const previousTaskStateVersion = taskStateVersionFromSnapshot(previousSnapshot);
      if (previousTaskStateVersion !== undefined) {
        return previousTaskStateVersion;
      }
      return fallbackTask?.taskStateVersion ?? 0;
    },

    clearState(): void {
      lastKnownTaskStates.clear();
      workflowRollupProjection.clear();
      lastKnownWorkflowCount = 0;
    },

    setWorkflowCount(count: number): void {
      lastKnownWorkflowCount = count;
    },

    setTaskSnapshotsFromOrchestrator(tasks: TaskState[], emitCreatedDeltas = false): void {
      workflowRollupProjection.replaceAll(tasks);
      for (const task of tasks) {
        lastKnownTaskStates.set(task.id, JSON.stringify(task));
        if (emitCreatedDeltas) {
          publishTaskDeltaToRenderer({ type: 'created', task });
        }
      }
    },

    startDbPolling(startupPollDelayMs: number): RendererTaskFeedPollHandle {
      let startupTimer: NodeJS.Timeout | null = setTimeout(() => {
        startupTimer = null;
        dbPollInterval = setInterval(() => {
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

              deps.orchestrator.syncAllFromDb();
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
                    deps.persistShutdownDiagnostic(task, {
                      flushPendingOutput: flushTaskOutput,
                      forcedStopReason: executingError,
                      label: task.execution.phase === 'launching'
                        ? 'Startup Failure Diagnostic'
                        : 'Shutdown Diagnostic',
                    });
                    deps.orchestrator.handleWorkerResponse(failedResponse);
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
                    const outcome = deps.orchestrator.reclaimStalledFixSession(task.id, {
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
                  if (deps.traceDbPollPerTask) {
                    const msg = `New task: ${task.id} (${task.status})`;
                    deps.logger.info(msg, { module: 'db-poll' });
                    try { deps.persistence.writeActivityLog('db-poll', 'info', msg); } catch { /* db locked */ }
                  }
                  lastKnownTaskStates.set(task.id, snapshot);
                  deps.uiPerfStats.dbPollCreated += 1;
                  publishTaskDeltaToRenderer({ type: 'created', task });
                } else if (prev !== snapshot) {
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
      startupTimer.unref?.();
      let dbPollInterval: NodeJS.Timeout | null = null;

      return {
        stop(): void {
          if (startupTimer) {
            clearTimeout(startupTimer);
            startupTimer = null;
          }
          if (dbPollInterval) {
            clearInterval(dbPollInterval);
            dbPollInterval = null;
          }
        },
      };
    },

    startActivityPolling(): RendererTaskFeedPollHandle {
      const activityPollInterval = setInterval(() => {
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
        stop(): void {
          clearInterval(activityPollInterval);
        },
      };
    },
  };
}
