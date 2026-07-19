import { useEffect, useRef, useState } from 'react';
import type { QueueStatus } from '../types.js';
import { areStructurallyEqual } from './useDedupedState.js';
import { subscribeVisibilityAwarePoll } from './visibilityAwarePoll.js';

export function useQueueStatus(pollMs = 5000, enabled = true): QueueStatus | null {
  const [queueStatus, setQueueStatus] = useState<QueueStatus | null>(null);
  const inFlightRef = useRef(false);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    const poll = async () => {
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      try {
        const status = await window.invoker?.getQueueStatus();
        if (!cancelled && status) {
          setQueueStatus((previous) =>
            areStructurallyEqual(previous, status) ? previous : status,
          );
        }
      } catch {
        // ignore polling errors
      } finally {
        inFlightRef.current = false;
      }
    };

    const unsubscribe = subscribeVisibilityAwarePoll(() => {
      void poll();
    }, pollMs, { restoreDelayMs: 250 });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [enabled, pollMs]);

  return queueStatus;
}
