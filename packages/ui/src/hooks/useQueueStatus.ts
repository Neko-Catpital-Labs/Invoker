import { useEffect, useState } from 'react';
import type { QueueStatus } from '../types.js';

export function useQueueStatus(pollMs = 2000): QueueStatus | null {
  const [queueStatus, setQueueStatus] = useState<QueueStatus | null>(null);

  useEffect(() => {
    let cancelled = false;

    const poll = async () => {
      try {
        const status = await window.invoker?.getQueueStatus();
        if (!cancelled && status) {
          setQueueStatus(status);
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
  }, [pollMs]);

  return queueStatus;
}
