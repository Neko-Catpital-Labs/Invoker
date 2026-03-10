/**
 * Hook managing task state with delta updates.
 *
 * On mount: fetches the current task list from main process.
 * Then subscribes to TaskDelta events for real-time updates.
 * No polling -- all updates arrive via IPC subscription.
 */

import { useState, useEffect, useCallback } from 'react';
import type { TaskState } from '../types.js';
import { applyDelta } from '../lib/delta.js';

export function useTasks(): { tasks: Map<string, TaskState>; clearTasks: () => void; refreshTasks: () => void } {
  const [tasks, setTasks] = useState<Map<string, TaskState>>(new Map());

  const fetchTasks = useCallback(() => {
    if (typeof window === 'undefined' || !window.invoker) return;
    window.invoker.getTasks().then((taskList) => {
      if (taskList.length === 0) return;
      setTasks((prev) => {
        const next = new Map(prev);
        for (const t of taskList) {
          next.set(t.id, t);
        }
        return next;
      });
    });
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.invoker) return;

    // Initial load — merge with existing state to avoid overwriting deltas
    // that arrived between subscription and this Promise resolving.
    window.invoker.getTasks().then((taskList) => {
      if (taskList.length === 0) return;
      setTasks((prev) => {
        const next = new Map(prev);
        for (const t of taskList) {
          if (!next.has(t.id)) {
            next.set(t.id, t);
          }
        }
        return next;
      });
    });

    // Subscribe to deltas
    const unsub = window.invoker.onTaskDelta((delta) => {
      setTasks((prev) => {
        const next = applyDelta(prev, delta);
        if (next.size === 0 && prev.size > 0) {
          console.warn('[useTasks] Tasks map went from', prev.size, 'to 0 after delta:', delta);
        }
        return next;
      });
    });

    return unsub;
  }, []);

  const clearTasks = useCallback(() => setTasks(new Map()), []);

  return { tasks, clearTasks, refreshTasks: fetchTasks };
}
