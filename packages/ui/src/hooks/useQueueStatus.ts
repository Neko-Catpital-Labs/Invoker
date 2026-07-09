import { useEffect, useState } from 'react';
import type { QueueStatus } from '../types.js';
import { areStructurallyEqual } from './useDedupedState.js';

export function useQueueStatus(pollMs = 2000, enabled = true): QueueStatus | null {
  const [queueStatus, setQueueStatus] = useState<QueueStatus | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    const poll = async () => {
      try {
        const status = await window.invoker?.getQueueStatus();
        if (!cancelled && status) {
          setQueueStatus((previous) =>
            areStructurallyEqual(previous, status) ? previous : status,
          );
        }
      } catch {
        // ignore polling errors
      }
    };

    void poll();
    const interval = window.setInterval(() => {
      void poll();
    }, pollMs);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [enabled, pollMs]);

  return queueStatus;
}
