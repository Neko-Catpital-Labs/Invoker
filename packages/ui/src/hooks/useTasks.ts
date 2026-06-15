/**
 * Hook managing task state with delta updates.
 *
 * On mount: fetches the current task list from main process.
 * Then subscribes to TaskDelta events for real-time updates.
 * No polling -- all updates arrive via IPC subscription.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import type { TaskState, WorkflowMeta } from '../types.js';
import { applyDelta } from '../lib/delta.js';
import { normalizeWorkflowStatus } from '../lib/workflow-status.js';
import {
  createTaskDeltaPipeline,
  type TaskDeltaPipeline,
} from '../lib/task-delta-pipeline.js';

export interface UseTasksResult {
  tasks: Map<string, TaskState>;
  workflows: Map<string, WorkflowMeta>;
  clearTasks: () => void;
  refreshTasks: (forceRefresh?: boolean) => Promise<void>;
}

export function useTasks(): UseTasksResult {
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
      next.set(workflow.id, {
        ...workflow,
        status: normalizeWorkflowStatus((workflow as { status?: string }).status),
      });
    }
    if (typeof window !== 'undefined' && window.invoker) {
      void window.invoker.reportUiPerf?.('useTasks_bootstrap_workflow_map', {
        durationMs: performance.now() - startedAt,
        workflowCount: next.size,
      });
    }
    return next;
  });
  const workflowsRef = useRef(workflows);
  workflowsRef.current = workflows;
  const deltaPipelineRef = useRef<TaskDeltaPipeline | null>(null);
  const deltaPerfRef = useRef({
    received: 0,
    applyCount: 0,
    applyTotalMs: 0,
    applyMaxMs: 0,
  });
  /** Bumps on each refresh so stale getTasks IPC (e.g. mount snapshot before loadPlan) cannot wipe newer state. */
  const getTasksGenerationRef = useRef(0);
  const reportedStartupBootstrapRef = useRef(false);
  const reportedStartupSnapshotRef = useRef(false);
  const lastSeenSequenceRef = useRef<number>(bootstrapState?.streamSequence ?? 0);
  const isResyncInFlightRef = useRef<boolean>(false);

  const fetchAll = useCallback((forceRefresh = false): Promise<void> => {
    if (typeof window === 'undefined' || !window.invoker) return Promise.resolve();
    const gen = ++getTasksGenerationRef.current;
    const requestedAt = performance.now();
    const request = window.invoker.getTasks(forceRefresh).then((result) => {
      const requestDurationMs = performance.now() - requestedAt;
      if (gen !== getTasksGenerationRef.current) {
        return;
      }
      const taskList = result.tasks ?? [];
      const wfList = result.workflows ?? [];
      const replaceStartedAt = performance.now();
      // Always replace from server snapshot — empty lists mean "no tasks/workflows" (e.g. after delete).
      setTasks(() => {
        const next = new Map<string, TaskState>();
        for (const t of taskList) next.set(t.id, t);
        return next;
      });
      setWorkflows(() => {
        const wfMap = new Map<string, WorkflowMeta>();
        for (const wf of wfList) {
          wfMap.set(wf.id, {
            ...wf,
            status: normalizeWorkflowStatus((wf as { status?: string }).status),
          });
        }
        return wfMap;
      });
      if (typeof result.streamSequence === 'number') {
        lastSeenSequenceRef.current = result.streamSequence;
      }
      isResyncInFlightRef.current = false;
      const replaceDurationMs = performance.now() - replaceStartedAt;
      void window.invoker.reportUiPerf?.('useTasks_snapshot_replace', {
        taskCount: taskList.length,
        workflowCount: wfList.length,
        forceRefresh,
        requestDurationMs,
        replaceDurationMs,
        jsonSizeBytes: new Blob([JSON.stringify(result)]).size,
      });
      if (!reportedStartupSnapshotRef.current) {
        reportedStartupSnapshotRef.current = true;
        void window.invoker.reportUiPerf?.('startup_snapshot_applied', {
          taskCount: taskList.length,
          workflowCount: wfList.length,
          forceRefresh,
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
    // the immediate non-forced snapshot would be a redundant full payload.
    // Skip it when bootstrap is populated; deltas keep state live, and
    // explicit refreshTasks() / refreshTasks(true) callers still run fetchAll.
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
      fetchAll();
    }

    deltaPipelineRef.current = createTaskDeltaPipeline({
      flushMs: 100,
      maxBatchSize: 200,
      onLargeBatch: ({ batchSize, remaining }) => {
        void window.invoker?.reportUiPerf?.('ui_delta_large_batch_chunked', {
          batchSize,
          remaining,
        });
      },
      onBatch: (batch) => {
        let shouldRefreshWorkflows = false;

        setTasks((prev) => {
          const t0 = performance.now();
          let next = prev;

          for (const delta of batch) {
            if (delta.type === 'updated' && !next.has(delta.taskId)) {
              if (traceTaskDeltas) {
                console.warn(
                  `[useTasks:task-delta] updated for taskId=${delta.taskId} not in local map before merge (stale snapshot?)`,
                );
              }
            }
            next = applyDelta(next, delta);
            if (
              delta.type === 'created' &&
              delta.task?.config.workflowId &&
              !workflowsRef.current.has(delta.task.config.workflowId)
            ) {
              shouldRefreshWorkflows = true;
            }
          }

          const dt = performance.now() - t0;
          deltaPerfRef.current.applyCount += batch.length;
          deltaPerfRef.current.applyTotalMs += dt;
          deltaPerfRef.current.applyMaxMs = Math.max(deltaPerfRef.current.applyMaxMs, dt);
          return next;
        });

        if (shouldRefreshWorkflows) {
          fetchAll();
        }
      },
    });

    const unsub = window.invoker.onTaskDelta((delta) => {
      deltaPerfRef.current.received += 1;
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
        const lastSeen = lastSeenSequenceRef.current;
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
          deltaPipelineRef.current?.clear();
          fetchAll(true);
          return;
        }
        lastSeenSequenceRef.current = seq;
      }

      deltaPipelineRef.current?.push(delta);
    });

    const unsubWf = window.invoker.onWorkflowsChanged?.((wfList: any[]) => {
      if (Array.isArray(wfList)) {
        setWorkflows(() => {
          const wfMap = new Map<string, WorkflowMeta>();
          for (const wf of wfList) {
            wfMap.set(wf.id, {
              ...wf,
              status: normalizeWorkflowStatus((wf as { status?: string }).status),
            });
          }
          return wfMap;
        });
      }
    });

    return () => {
      deltaPipelineRef.current?.dispose();
      deltaPipelineRef.current = null;
      unsub();
      unsubWf?.();
    };
  }, [fetchAll]);

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

  return { tasks, workflows, clearTasks, refreshTasks: fetchAll };
}
