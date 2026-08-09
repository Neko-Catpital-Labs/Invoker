import type { BrowserWindow } from 'electron';
import type { Logger, WorkResponse } from '@invoker/contracts';
import type { Workflow } from '@invoker/data-store';
import { Channels, type MessageBus } from '@invoker/transport';
import type { TaskDelta, TaskState } from '@invoker/workflow-core';
import { applyDelta, recoverQuarantinedTask, TaskSnapshotCache } from '../delta-merge.js';
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
  loadTasksForWorkflows?(workflowIds: string[]): TaskState[];
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
  messageBus: Pick<MessageBus, 'publish'>;
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
  let lastKnownWorkflowCount = 0;

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

  const applyTaskDeltaToOwnerCacheOrRecover = (delta: TaskDelta): TaskDelta[] => {
    const { quarantined, accepted } = applyDelta(delta, lastKnownTaskStates);
    if (quarantined.length === 0) {
      return accepted ? [delta] : [];
    }

    const rendererDeltas: TaskDelta[] = [];
    for (const taskId of quarantined) {
      deps.logger.info(`[gap-detect] quarantined task="${taskId}" — triggering authoritative reload`, { module: 'delta-merge' });
      const { rendererDelta } = recoverQuarantinedTask(lastKnownTaskStates, taskId, {
        loadTask: (recoveryTaskId) => deps.persistence.loadTask(recoveryTaskId),
        getMergeNode: (workflowId) => deps.getOrchestrator().getMergeNode(workflowId),
      });
      if (rendererDelta) {
        rendererDeltas.push(rendererDelta);
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
    for (const rendererDelta of applyTaskDeltaToOwnerCacheOrRecover(delta)) {
      if (deps.traceUiDeltaFlow) {
        // Trace what is actually published to the renderer (post gap-detect
        // recovery), not the raw input -- recovery can expand one incoming
        // delta into zero or more re-synthesized renderer deltas.
        deps.logger.debug(`delta→ui: ${JSON.stringify(rendererDelta)}`, { module: 'ui' });
      }
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

        const activeWorkflows = workflows.filter(
          (workflow) => workflow.status !== 'completed' && workflow.status !== 'failed',
        );
        const tasksByWorkflow = new Map<string, TaskState[]>();
        let usedBatchedTaskLoad = false;
        if (activeWorkflows.length > 0 && typeof deps.persistence.loadTasksForWorkflows === 'function') {
          usedBatchedTaskLoad = true;
          for (const task of deps.persistence.loadTasksForWorkflows(activeWorkflows.map((workflow) => workflow.id))) {
            const workflowId = task.config.workflowId;
            if (!workflowId) continue;
            const tasks = tasksByWorkflow.get(workflowId);
            if (tasks) {
              tasks.push(task);
            } else {
              tasksByWorkflow.set(workflowId, [task]);
            }
          }
        }

        for (const workflow of activeWorkflows) {
          const tasks = usedBatchedTaskLoad
            ? tasksByWorkflow.get(workflow.id) ?? []
            : deps.persistence.loadTasks(workflow.id);
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
