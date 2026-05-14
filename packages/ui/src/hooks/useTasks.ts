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

function deriveWorkflowStatusFromTasks(tasks: TaskState[]): WorkflowMeta['status'] {
  if (tasks.length === 0) return 'pending';
  const counts = {
    pending: 0,
    running: 0,
    fixing_with_ai: 0,
    completed: 0,
    failed: 0,
    needs_input: 0,
    blocked: 0,
    review_ready: 0,
    awaiting_approval: 0,
    stale: 0,
  };

  for (const task of tasks) {
    counts[task.status] += 1;
  }

  if (counts.fixing_with_ai > 0) return 'fixing_with_ai';
  if (counts.running > 0) return 'running';
  if (counts.awaiting_approval > 0) return 'awaiting_approval';
  if (counts.review_ready > 0) return 'review_ready';
  if (counts.blocked > 0 || counts.needs_input > 0) return 'blocked';
  if (counts.pending === tasks.length) return 'pending';
  if (counts.pending > 0) return 'running';
  if (counts.failed > 0) return 'failed';
  if (counts.completed > 0 && counts.completed + counts.stale === tasks.length) return 'completed';
  if (counts.stale === tasks.length) return 'stale';
  return 'running';
}

function deriveWorkflowStatuses(
  workflowMap: Map<string, WorkflowMeta>,
  taskMap: Map<string, TaskState>,
): Map<string, WorkflowMeta> {
  const tasksByWorkflow = new Map<string, TaskState[]>();
  for (const task of taskMap.values()) {
    const workflowId = task.config.workflowId;
    if (!workflowId) continue;
    const workflowTasks = tasksByWorkflow.get(workflowId) ?? [];
    workflowTasks.push(task);
    tasksByWorkflow.set(workflowId, workflowTasks);
  }

  let changed = false;
  const next = new Map<string, WorkflowMeta>();
  for (const [workflowId, workflow] of workflowMap) {
    const status = deriveWorkflowStatusFromTasks(tasksByWorkflow.get(workflowId) ?? []);
    if (workflow.status !== status) {
      changed = true;
    }
    next.set(workflowId, { ...workflow, status });
  }
  return changed ? next : workflowMap;
}

export interface UseTasksResult {
  tasks: Map<string, TaskState>;
  workflows: Map<string, WorkflowMeta>;
  clearTasks: () => void;
  refreshTasks: (forceRefresh?: boolean) => void;
}

export function useTasks(): UseTasksResult {
  const traceTaskDeltas =
    typeof window !== 'undefined' &&
    window.location.search.includes('traceTaskDeltas=1');
  const bootstrapState =
    typeof window !== 'undefined' ? window.__INVOKER_BOOTSTRAP__ : undefined;
  const [tasks, setTasks] = useState<Map<string, TaskState>>(() => {
    const next = new Map<string, TaskState>();
    for (const task of bootstrapState?.tasks ?? []) {
      next.set(task.id, task);
    }
    return next;
  });
  const [workflows, setWorkflows] = useState<Map<string, WorkflowMeta>>(() => {
    const next = new Map<string, WorkflowMeta>();
    for (const workflow of bootstrapState?.workflows ?? []) {
      next.set(workflow.id, {
        ...workflow,
        status: normalizeWorkflowStatus((workflow as { status?: string }).status),
      });
    }
    return next;
  });
  useEffect(() => {
    setWorkflows((prev) => deriveWorkflowStatuses(prev, tasks));
  }, [tasks]);
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

  const fetchAll = useCallback((forceRefresh = false) => {
    if (typeof window === 'undefined' || !window.invoker) return;
    const gen = ++getTasksGenerationRef.current;
    window.invoker.getTasks(forceRefresh).then((result) => {
      if (gen !== getTasksGenerationRef.current) {
        return;
      }
      const taskList = result.tasks ?? [];
      const wfList = result.workflows ?? [];
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
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.invoker) return;

    if (
      !reportedStartupBootstrapRef.current &&
      bootstrapState &&
      ((bootstrapState.tasks?.length ?? 0) > 0 || (bootstrapState.workflows?.length ?? 0) > 0)
    ) {
      reportedStartupBootstrapRef.current = true;
      void window.invoker.reportUiPerf?.('startup_bootstrap_state', {
        taskCount: bootstrapState.tasks?.length ?? 0,
        workflowCount: bootstrapState.workflows?.length ?? 0,
        elapsedMs: Math.round(performance.now()),
        processElapsedMs: bootstrapState.appStartedAtEpochMs
          ? Date.now() - bootstrapState.appStartedAtEpochMs
          : undefined,
      });
    }

    fetchAll();

    deltaPipelineRef.current = createTaskDeltaPipeline({
      flushMs: 100,
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
