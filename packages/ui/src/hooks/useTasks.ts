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

export interface UseTasksResult {
  tasks: Map<string, TaskState>;
  workflows: Map<string, WorkflowMeta>;
  clearTasks: () => void;
  refreshTasks: () => void;
}

export function useTasks(): UseTasksResult {
  const [tasks, setTasks] = useState<Map<string, TaskState>>(new Map());
  const [workflows, setWorkflows] = useState<Map<string, WorkflowMeta>>(new Map());
  const workflowsRef = useRef(workflows);
  workflowsRef.current = workflows;
  /** Bumps on each refresh so stale getTasks IPC (e.g. mount snapshot before loadPlan) cannot wipe newer state. */
  const getTasksGenerationRef = useRef(0);

  const fetchAll = useCallback(() => {
    if (typeof window === 'undefined' || !window.invoker) return;
    const gen = ++getTasksGenerationRef.current;
    window.invoker.getTasks().then((result) => {
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
        for (const wf of wfList) wfMap.set(wf.id, wf);
        return wfMap;
      });
    });
    window.invoker.checkPrStatus?.();
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.invoker) return;

    fetchAll();

    const unsub = window.invoker.onTaskDelta((delta) => {
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

      setTasks((prev) => {
        if (delta.type === 'updated' && !prev.has(delta.taskId)) {
          console.warn(
            `[useTasks:task-delta] updated for taskId=${delta.taskId} not in local map before merge (stale snapshot?)`,
          );
        }
        const next = applyDelta(prev, delta);
        return next;
      });

      if (delta.type === 'created' && delta.task?.config.workflowId) {
        if (!workflowsRef.current.has(delta.task.config.workflowId)) {
          fetchAll();
        }
      }
    });

    const unsubWf = window.invoker.onWorkflowsChanged?.((wfList: any[]) => {
      if (Array.isArray(wfList)) {
        setWorkflows(() => {
          const wfMap = new Map<string, WorkflowMeta>();
          for (const wf of wfList) wfMap.set(wf.id, wf);
          return wfMap;
        });
      }
    });

    return () => {
      unsub();
      unsubWf?.();
    };
  }, [fetchAll]);

  const clearTasks = useCallback(() => {
    setTasks(new Map());
    setWorkflows(new Map());
  }, []);

  return { tasks, workflows, clearTasks, refreshTasks: fetchAll };
}
