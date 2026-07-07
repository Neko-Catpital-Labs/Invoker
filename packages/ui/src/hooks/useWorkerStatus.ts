import { useCallback, useEffect, useRef, useState } from 'react';
import type { WorkerStatusSnapshot } from '../types.js';

export function useWorkerStatus(pollMs = 2000): readonly [snapshot: WorkerStatusSnapshot | null, refresh: () => Promise<void>] {
  const [snapshot, setSnapshot] = useState<WorkerStatusSnapshot | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => () => {
    mountedRef.current = false;
  }, []);

  const fetchStatus = useCallback(async () => {
    try {
      const status = await window.invoker?.getWorkers();
      if (mountedRef.current && status) {
        setSnapshot(status);
      }
    } catch {
      // ignore polling errors
    }
  }, []);

  useEffect(() => {
    void fetchStatus();
    const interval = window.setInterval(() => {
      void fetchStatus();
    }, pollMs);
    return () => window.clearInterval(interval);
  }, [fetchStatus, pollMs]);

  return [snapshot, fetchStatus] as const;
}
