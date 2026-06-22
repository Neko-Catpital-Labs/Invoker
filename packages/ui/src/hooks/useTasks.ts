/**
 * Hook managing task state with delta updates.
 *
 * On mount: fetches the current task list from main process.
 * Then subscribes to TaskDelta events for real-time updates.
 * No polling -- all updates arrive via IPC subscription.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import type { TaskGraphEvent, TaskState, WorkflowMeta, WorkflowRollupPatch } from '../types.js';
import { applyDelta } from '../lib/delta.js';
import { normalizeWorkflowStatus } from '../lib/workflow-status.js';
import {
  createTaskGraphEventPipeline,
  type TaskGraphEventPipeline,
} from '../lib/task-graph-event-pipeline.js';

export interface UseTasksResult {
  tasks: Map<string, TaskState>;
  workflows: Map<string, WorkflowMeta>;
  clearTasks: () => void;
  refreshTaskGraph: () => Promise<void>;
}
export interface UseTasksOptions {
  onTaskGraphSnapshotApplied?: () => void;
}
function normalizeWorkflowMeta(workflow: WorkflowMeta): WorkflowMeta {
  return {
    ...workflow,
    status: normalizeWorkflowStatus((workflow as { status?: string }).status),
  };
}

function replaceWorkflowMapPreservingTaskBackedEntries(
  previous: Map<string, WorkflowMeta>,
  incoming: readonly WorkflowMeta[],
  tasks: Map<string, TaskState>,
): Map<string, WorkflowMeta> {
  const next = new Map<string, WorkflowMeta>();
  for (const workflow of incoming) {
    next.set(workflow.id, normalizeWorkflowMeta(workflow));
  }
  const referencedWorkflowIds = new Set<string>();
  for (const task of tasks.values()) {
    const workflowId = task.config.workflowId;
    if (workflowId) {
      referencedWorkflowIds.add(workflowId);
    }
  }
  for (const [workflowId, workflow] of previous) {
    if (!next.has(workflowId) && referencedWorkflowIds.has(workflowId)) {
      next.set(workflowId, workflow);
    }
  }
  return next;
}

function applyWorkflowRollupPatches(
  previous: Map<string, WorkflowMeta>,
  patches: readonly WorkflowRollupPatch[],
): Map<string, WorkflowMeta> {
  if (patches.length === 0) {
    return previous;
  }
  const next = new Map(previous);
  for (const patch of patches) {
    const existing = next.get(patch.workflowId);
    next.set(patch.workflowId, {
      ...(existing ?? { id: patch.workflowId, name: patch.workflowId }),
      status: normalizeWorkflowStatus(patch.status),
      rollup: patch.rollup,
    });
  }
  return next;
}



export function useTasks({ onTaskGraphSnapshotApplied }: UseTasksOptions = {}): UseTasksResult {
  const traceTaskDeltas =
    typeof window !== 'undefined' &&
    window.location.search.includes('traceTaskDeltas=1');
  const bootstrapState =
    typeof window !== 'undefined' ? window.__INVOKER_BOOTSTRAP__ : undefined;
  const [tasks, setTasks] = useState<Map<string, TaskState>>(() => {
    const startedAt = performance.now();
    const next = new Map<string, TaskState>();
    for (const task of bootstrapState?.tasks ?? []) {
      next.set(task.id, task);
    }
    if (typeof window !== 'undefined' && window.invoker) {
      void window.invoker.reportUiPerf?.('useTasks_bootstrap_task_map', {
        durationMs: performance.now() - startedAt,
        taskCount: next.size,
      });
    }
    return next;
  });
  const [workflows, setWorkflows] = useState<Map<string, WorkflowMeta>>(() => {
    const startedAt = performance.now();
    const next = new Map<string, WorkflowMeta>();
    for (const workflow of bootstrapState?.workflows ?? []) {
      next.set(workflow.id, normalizeWorkflowMeta(workflow));
    }
    if (typeof window !== 'undefined' && window.invoker) {
      void window.invoker.reportUiPerf?.('useTasks_bootstrap_workflow_map', {
        durationMs: performance.now() - startedAt,
        workflowCount: next.size,
      });
    }
    return next;
  });
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;
  const workflowsRef = useRef(workflows);
  workflowsRef.current = workflows;
  const graphEventPipelineRef = useRef<TaskGraphEventPipeline | null>(null);
  const deltaPerfRef = useRef({
    received: 0,
    applyCount: 0,
    applyTotalMs: 0,
    applyMaxMs: 0,
  });
  /** Bumps when newer UI activity supersedes the startup getTasks snapshot. */
  const startupSnapshotGenerationRef = useRef(0);
  const reportedStartupBootstrapRef = useRef(false);
  const reportedStartupSnapshotRef = useRef(false);
  const uiTaskGraphStreamWatermarkRef = useRef<number>(bootstrapState?.streamSequence ?? 0);
  const isResyncInFlightRef = useRef<boolean>(false);

  const invalidateStartupSnapshot = useCallback(() => {
    startupSnapshotGenerationRef.current += 1;
  }, []);
  const loadStartupSnapshot = useCallback((): Promise<void> => {
    if (typeof window === 'undefined' || !window.invoker) return Promise.resolve();
    const gen = ++startupSnapshotGenerationRef.current;
    const requestedAt = performance.now();
    const request = window.invoker.getTasks().then((result) => {
      const requestDurationMs = performance.now() - requestedAt;
      if (gen !== startupSnapshotGenerationRef.current) {
        return;
      }
      const taskList = result.tasks ?? [];
      const wfList = result.workflows ?? [];
      const replaceStartedAt = performance.now();
      // Always replace from server snapshot — empty lists mean "no tasks/workflows" (e.g. after delete).
      const nextTasks = new Map<string, TaskState>();
      for (const t of taskList) nextTasks.set(t.id, t);
      tasksRef.current = nextTasks;
      setTasks(nextTasks);
      setWorkflows((previous) => {
        const nextWorkflows = replaceWorkflowMapPreservingTaskBackedEntries(previous, wfList, nextTasks);
        workflowsRef.current = nextWorkflows;
        return nextWorkflows;
      });
      if (typeof result.streamSequence === 'number') {
        uiTaskGraphStreamWatermarkRef.current = result.streamSequence;
      }
      isResyncInFlightRef.current = false;
      const replaceDurationMs = performance.now() - replaceStartedAt;
      void window.invoker.reportUiPerf?.('useTasks_snapshot_replace', {
        taskCount: taskList.length,
        workflowCount: wfList.length,
        requestDurationMs,
        replaceDurationMs,
        jsonSizeBytes: new Blob([JSON.stringify(result)]).size,
      });
      if (!reportedStartupSnapshotRef.current) {
        reportedStartupSnapshotRef.current = true;
        void window.invoker.reportUiPerf?.('startup_snapshot_applied', {
          taskCount: taskList.length,
          workflowCount: wfList.length,
          elapsedMs: Math.round(performance.now()),
          processElapsedMs: bootstrapState?.appStartedAtEpochMs
            ? Date.now() - bootstrapState.appStartedAtEpochMs
            : undefined,
        });
      }
    });
    window.invoker.checkPrStatuses?.();
    return request.then(() => undefined);
  }, []);
  const refreshWorkflowMetadata = useCallback((): Promise<void> => {
    if (typeof window === 'undefined' || !window.invoker) return Promise.resolve();
    const requestedAt = performance.now();
    const request = window.invoker.listWorkflows().then((wfList) => {
      setWorkflows((previous) => {
        const nextWorkflows = replaceWorkflowMapPreservingTaskBackedEntries(
          previous,
          wfList,
          tasksRef.current,
        );
        workflowsRef.current = nextWorkflows;
        return nextWorkflows;
      });
      void window.invoker.reportUiPerf?.('useTasks_workflow_metadata_refresh', {
        workflowCount: wfList.length,
        requestDurationMs: performance.now() - requestedAt,
        jsonSizeBytes: new Blob([JSON.stringify(wfList)]).size,
      });
    });
    return request.then(() => undefined);
  }, []);
  const refreshTaskGraph = useCallback((): Promise<void> => {
    if (typeof window === 'undefined' || !window.invoker) return Promise.resolve();
    invalidateStartupSnapshot();
    return window.invoker.refreshTaskGraph();
  }, [invalidateStartupSnapshot]);


  useEffect(() => {
    if (typeof window === 'undefined' || !window.invoker) return;

    const bootstrapTaskCount = bootstrapState?.tasks?.length ?? 0;
    const bootstrapWorkflowCount = bootstrapState?.workflows?.length ?? 0;
    const bootstrapHasState = bootstrapTaskCount > 0 || bootstrapWorkflowCount > 0;

    if (!reportedStartupBootstrapRef.current && bootstrapState && bootstrapHasState) {
      reportedStartupBootstrapRef.current = true;
      void window.invoker.reportUiPerf?.('startup_bootstrap_state', {
        taskCount: bootstrapTaskCount,
        workflowCount: bootstrapWorkflowCount,
        elapsedMs: Math.round(performance.now()),
        processElapsedMs: bootstrapState.appStartedAtEpochMs
          ? Date.now() - bootstrapState.appStartedAtEpochMs
          : undefined,
      });
    }

    // Preload bootstrap already hydrated tasks/workflows synchronously, so
    // the immediate startup snapshot would be a redundant full payload.
    // Skip it when bootstrap is populated; deltas keep state live.
    if (bootstrapHasState) {
      reportedStartupSnapshotRef.current = true;
      void window.invoker.reportUiPerf?.('startup_snapshot_skipped_bootstrap_complete', {
        bootstrapTaskCount,
        bootstrapWorkflowCount,
        elapsedMs: Math.round(performance.now()),
        processElapsedMs: bootstrapState?.appStartedAtEpochMs
          ? Date.now() - bootstrapState.appStartedAtEpochMs
          : undefined,
      });
    } else {
      void loadStartupSnapshot();
    }

    graphEventPipelineRef.current = createTaskGraphEventPipeline({
      flushMs: 100,
      maxBatchSize: 200,
      onLargeBatch: ({ batchSize, remaining }) => {
        void window.invoker?.reportUiPerf?.('ui_delta_large_batch_chunked', {
          batchSize,
          remaining,
        });
      },
      onBatch: (batch) => {
        let lastSnapshotIndex = -1;
        for (let index = batch.length - 1; index >= 0; index -= 1) {
          if (batch[index].type === 'snapshot') {
            lastSnapshotIndex = index;
            break;
          }
        }
        const effectiveBatch = lastSnapshotIndex >= 0 ? batch.slice(lastSnapshotIndex) : batch;
        const firstEvent = effectiveBatch[0];
        const deltaEvents = firstEvent?.type === 'snapshot' ? effectiveBatch.slice(1) : effectiveBatch;
        let shouldRefreshWorkflows = false;
        let nextTasks = tasksRef.current;
        let nextWorkflows = workflowsRef.current;
        const replaceStartedAt = performance.now();
        const t0 = performance.now();

        if (firstEvent?.type === 'snapshot') {
          nextTasks = new Map<string, TaskState>();
          for (const task of firstEvent.tasks) nextTasks.set(task.id, task);
          nextWorkflows = replaceWorkflowMapPreservingTaskBackedEntries(
            nextWorkflows,
            firstEvent.workflows,
            nextTasks,
          );
          uiTaskGraphStreamWatermarkRef.current = Math.max(uiTaskGraphStreamWatermarkRef.current, firstEvent.streamSequence);
          isResyncInFlightRef.current = false;
          onTaskGraphSnapshotApplied?.();
          void window.invoker.reportUiPerf?.('useTasks_snapshot_replace', {
            taskCount: firstEvent.tasks.length,
            workflowCount: firstEvent.workflows.length,
            source: 'task-graph-event',
            reason: firstEvent.reason,
            replaceDurationMs: performance.now() - replaceStartedAt,
            jsonSizeBytes: new Blob([JSON.stringify(firstEvent)]).size,
          });
        }

        for (const event of deltaEvents) {
          if (event.type !== 'delta') continue;
          const delta = event.delta;
          if (delta.type === 'updated' && !nextTasks.has(delta.taskId)) {
            if (traceTaskDeltas) {
              console.warn(
                `[useTasks:task-delta] updated for taskId=${delta.taskId} not in local map before merge (stale snapshot?)`,
              );
            }
          }
          if (
            delta.type === 'created' &&
            delta.task?.config.workflowId &&
            !nextWorkflows.has(delta.task.config.workflowId)
          ) {
            shouldRefreshWorkflows = true;
          }
          nextTasks = applyDelta(nextTasks, delta);
          nextWorkflows = applyWorkflowRollupPatches(nextWorkflows, event.workflowRollups);
        }

        const dt = performance.now() - t0;
        deltaPerfRef.current.applyCount += effectiveBatch.length;
        deltaPerfRef.current.applyTotalMs += dt;
        deltaPerfRef.current.applyMaxMs = Math.max(deltaPerfRef.current.applyMaxMs, dt);
        tasksRef.current = nextTasks;
        workflowsRef.current = nextWorkflows;
        setTasks(nextTasks);
        setWorkflows(nextWorkflows);
        if (shouldRefreshWorkflows) {
          void refreshWorkflowMetadata();
        }
      },
    });

    const handleTaskGraphEvent = (event: TaskGraphEvent) => {
      invalidateStartupSnapshot();
      deltaPerfRef.current.received += 1;
      if (event.type === 'snapshot') {
        const snapshotStreamSequence = event.streamSequence;
        const currentStreamSequence = uiTaskGraphStreamWatermarkRef.current;
        if (snapshotStreamSequence < currentStreamSequence) {
          window.invoker.reportUiPerf?.('ui_task_graph_stale_snapshot_ignored', {
            current: currentStreamSequence,
            snapshot: snapshotStreamSequence,
            reason: event.reason,
          });
          return;
        }
        graphEventPipelineRef.current?.push(event);
        return;
      }
      const delta = event.delta;
      if (traceTaskDeltas) {
        if (delta.type === 'created') {
          console.log(
            `[useTasks:task-delta] created id=${delta.task.id} status=${delta.task.status}`,
          );
        } else if (delta.type === 'removed') {
          console.log(`[useTasks:task-delta] removed taskId=${delta.taskId}`);
        } else {
          const ex = delta.changes.execution;
          console.log(
            `[useTasks:task-delta] updated taskId=${delta.taskId} ` +
              `changes.status=${delta.changes.status ?? '—'} ` +
              `execPatchKeys=${ex ? Object.keys(ex).join(',') : '—'}`,
          );
        }
      }

      const seq = delta.streamSequence;
      if (typeof seq === 'number') {
        const lastSeen = uiTaskGraphStreamWatermarkRef.current;
        if (seq <= lastSeen) return;
        if (isResyncInFlightRef.current) return;
        if (seq !== lastSeen + 1) {
          const gapSize = seq - (lastSeen + 1);
          window.invoker.reportUiPerf?.('ui_delta_stream_gap_detected', {
            expected: lastSeen + 1,
            actual: seq,
            gapSize,
          });
          isResyncInFlightRef.current = true;
          graphEventPipelineRef.current?.clear();
          refreshTaskGraph();
          return;
        }
        uiTaskGraphStreamWatermarkRef.current = seq;
      }

      graphEventPipelineRef.current?.push(event);
    };

    const unsub = window.invoker.onTaskGraphEvent(handleTaskGraphEvent);

    const unsubWf = window.invoker.onWorkflowsChanged?.((wfList: any[]) => {
      invalidateStartupSnapshot();
      if (Array.isArray(wfList)) {
        setWorkflows((previous) => {
          const nextWorkflows = replaceWorkflowMapPreservingTaskBackedEntries(
            previous,
            wfList,
            tasksRef.current,
          );
          workflowsRef.current = nextWorkflows;
          return nextWorkflows;
        });
      }
    });

    return () => {
      graphEventPipelineRef.current?.dispose();
      graphEventPipelineRef.current = null;
      unsub();
      unsubWf?.();
    };
  }, [invalidateStartupSnapshot, loadStartupSnapshot, onTaskGraphSnapshotApplied, refreshTaskGraph, refreshWorkflowMetadata]);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.invoker) return;
    const interval = setInterval(() => {
      const stats = deltaPerfRef.current;
      if (stats.received === 0) return;
      void window.invoker.reportUiPerf('ui_delta_apply', {
        received: stats.received,
        applyCount: stats.applyCount,
        applyAvgMs: stats.applyCount > 0 ? stats.applyTotalMs / stats.applyCount : 0,
        applyMaxMs: stats.applyMaxMs,
      });
      deltaPerfRef.current = { received: 0, applyCount: 0, applyTotalMs: 0, applyMaxMs: 0 };
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  const clearTasks = useCallback(() => {
    setTasks(new Map());
    setWorkflows(new Map());
  }, []);

  return { tasks, workflows, clearTasks, refreshTaskGraph };
}
