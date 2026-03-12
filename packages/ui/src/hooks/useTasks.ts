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

  const fetchAll = useCallback(() => {
    if (typeof window === 'undefined' || !window.invoker) return;
    window.invoker.getTasks().then((result) => {
      const taskList = Array.isArray(result) ? result : result.tasks;
      const wfList = Array.isArray(result) ? [] : (result.workflows ?? []);
      if (taskList.length > 0) {
        setTasks((prev) => {
          const next = new Map(prev);
          for (const t of taskList) next.set(t.id, t);
          return next;
        });
      }
      if (wfList.length > 0) {
        setWorkflows(() => {
          const wfMap = new Map<string, WorkflowMeta>();
          for (const wf of wfList) wfMap.set(wf.id, wf);
          return wfMap;
        });
      }
    });
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.invoker) return;

    fetchAll();

    const unsub = window.invoker.onTaskDelta((delta) => {
      setTasks((prev) => {
        const next = applyDelta(prev, delta);
        if (next.size === 0 && prev.size > 0) {
          console.warn('[useTasks] Tasks map went from', prev.size, 'to 0 after delta:', delta);
        }
        return next;
      });

      if (delta.type === 'created' && delta.task?.config.workflowId) {
        if (!workflowsRef.current.has(delta.task.config.workflowId)) {
          fetchAll();
        }
      }
    });

    return unsub;
  }, [fetchAll]);

  const clearTasks = useCallback(() => {
    setTasks(new Map());
    setWorkflows(new Map());
  }, []);

  return { tasks, workflows, clearTasks, refreshTasks: fetchAll };
}
