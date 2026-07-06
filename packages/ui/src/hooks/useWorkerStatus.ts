import { useCallback, useEffect, useState } from 'react';
import type { WorkerStatusSnapshot } from '../types.js';

export function useWorkerStatus(pollMs = 2000): readonly [snapshot: WorkerStatusSnapshot | null, refresh: () => Promise<void>] {
  const [snapshot, setSnapshot] = useState<WorkerStatusSnapshot | null>(null);

  const refresh = useCallback(async () => {
    try {
      const status = await window.invoker?.getWorkerStatus();
      if (status) {
        setSnapshot(status);
      }
    } catch {
      // ignore polling errors
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    const poll = async () => {
      try {
        const status = await window.invoker?.getWorkerStatus();
        if (!cancelled && status) {
          setSnapshot(status);
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

  return [snapshot, refresh] as const;
}
