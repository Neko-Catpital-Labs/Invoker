import { useEffect, useRef, useState } from 'react';
import type { QueueStatus, TaskGraphEvent } from '../types.js';
import { areStructurallyEqual } from './useDedupedState.js';
import { subscribeVisibilityAwarePoll } from './visibilityAwarePoll.js';

function isExecutingStatus(status: unknown): boolean {
  return status === 'running' || status === 'fixing_with_ai';
}

function isTerminalOrIdleStatus(status: unknown): boolean {
  return status === 'completed' ||
    status === 'failed' ||
    status === 'closed' ||
    status === 'blocked' ||
    status === 'needs_input' ||
    status === 'awaiting_approval' ||
    status === 'review_ready' ||
    status === 'stale' ||
    status === 'pending' ||
    status === 'queued';
}

export function useQueueStatus(pollMs = 5000, enabled = true): QueueStatus | null {
  const [queueStatus, setQueueStatus] = useState<QueueStatus | null>(null);
  const inFlightRef = useRef(false);
  const pendingRefreshRef = useRef(false);
  const optimisticSlotTaskIdsRef = useRef<Set<string>>(new Set());
  const optimisticExecutingTaskIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    const rememberConfirmedQueueStatus = (status: QueueStatus) => {
      const slotIds = new Set(status.running.map((entry) => entry.taskId));
      optimisticSlotTaskIdsRef.current = slotIds;
      optimisticExecutingTaskIdsRef.current = new Set(
        status.running
          .slice(0, status.activeExecutionCount ?? status.runningCount)
          .map((entry) => entry.taskId),
      );
    };

    const patchOptimisticQueueStatus = (taskId: string, state: 'executing' | 'launching' | 'idle') => {
      setQueueStatus((previous) => {
        if (!previous) return previous;

        const slotIds = new Set(optimisticSlotTaskIdsRef.current);
        const executingIds = new Set(optimisticExecutingTaskIdsRef.current);
        const running = previous.running.filter((entry) => entry.taskId !== taskId);

        if (state === 'idle') {
          slotIds.delete(taskId);
          executingIds.delete(taskId);
        } else {
          slotIds.add(taskId);
          if (!running.some((entry) => entry.taskId === taskId)) {
            running.push({ taskId, description: taskId });
          }
          if (state === 'executing') {
            executingIds.add(taskId);
          } else {
            executingIds.delete(taskId);
          }
        }

        optimisticSlotTaskIdsRef.current = slotIds;
        optimisticExecutingTaskIdsRef.current = executingIds;

        const next: QueueStatus = {
          ...previous,
          runningCount: slotIds.size,
          activeExecutionCount: executingIds.size,
          launchingCount: Math.max(0, slotIds.size - executingIds.size),
          running,
        };
        return areStructurallyEqual(previous, next) ? previous : next;
      });
    };

    const patchFromTaskGraphEvent = (event: TaskGraphEvent) => {
      if (event.type === 'snapshot') return;
      const delta = event.delta;
      if (delta.type === 'created') {
        if (isExecutingStatus(delta.task.status)) {
          patchOptimisticQueueStatus(delta.task.id, 'executing');
        } else if (
          (delta.task.status === 'pending' || delta.task.status === 'queued') &&
          delta.task.execution.phase === 'launching'
        ) {
          patchOptimisticQueueStatus(delta.task.id, 'launching');
        }
        return;
      }
      if (delta.type === 'removed') {
        patchOptimisticQueueStatus(delta.taskId, 'idle');
        return;
      }

      const nextStatus = delta.changes.status;
      if (isExecutingStatus(nextStatus)) {
        patchOptimisticQueueStatus(delta.taskId, 'executing');
        return;
      }
      if (
        (nextStatus === 'pending' || nextStatus === 'queued') &&
        delta.changes.execution?.phase === 'launching'
      ) {
        patchOptimisticQueueStatus(delta.taskId, 'launching');
        return;
      }
      if (isTerminalOrIdleStatus(nextStatus)) {
        patchOptimisticQueueStatus(delta.taskId, 'idle');
      }
    };

    const poll = async (options?: { refresh?: boolean }) => {
      if (inFlightRef.current) {
        if (options?.refresh) pendingRefreshRef.current = true;
        return;
      }
      inFlightRef.current = true;
      try {
        const status = await window.invoker?.getQueueStatus(options);
        if (!cancelled && status) {
          rememberConfirmedQueueStatus(status);
          setQueueStatus((previous) =>
            areStructurallyEqual(previous, status) ? previous : status,
          );
        }
      } catch {
        // ignore polling errors
      } finally {
        inFlightRef.current = false;
        if (!cancelled && pendingRefreshRef.current) {
          pendingRefreshRef.current = false;
          void poll({ refresh: true });
        }
      }
    };

    const unsubscribe = subscribeVisibilityAwarePoll(() => {
      void poll();
    }, pollMs, { restoreDelayMs: 250 });
    const unsubscribeTaskGraph = window.invoker?.onTaskGraphEvent?.((event: TaskGraphEvent) => {
      patchFromTaskGraphEvent(event);
      if (event.type === 'snapshot') {
        void poll({ refresh: true });
        return;
      }
      if (
        event.delta.type === 'created' ||
        event.delta.type === 'removed' ||
        event.delta.changes.status !== undefined ||
        event.delta.changes.execution?.phase !== undefined ||
        event.delta.changes.execution?.selectedAttemptId !== undefined
      ) {
        void poll({ refresh: true });
      }
    });
    return () => {
      cancelled = true;
      unsubscribe();
      unsubscribeTaskGraph?.();
    };
  }, [enabled, pollMs]);

  return queueStatus;
}
