import { useCallback, useEffect, useRef, useState } from 'react';
import type { WorkerStatusSnapshot } from '../types.js';
import { areStructurallyEqual } from './useDedupedState.js';

export function useWorkerStatus(
  pollMs = 2000,
  enabled = true,
): readonly [snapshot: WorkerStatusSnapshot | null, refresh: () => Promise<void>] {
  const [snapshot, setSnapshot] = useState<WorkerStatusSnapshot | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => () => {
    mountedRef.current = false;
  }, []);

  const fetchStatus = useCallback(async () => {
    try {
      const status = await window.invoker?.getWorkerStatus();
      if (mountedRef.current && status) {
        setSnapshot((previous) =>
          areStructurallyEqual(previous, status) ? previous : status,
        );
      }
    } catch {
      // ignore polling errors
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void fetchStatus();
    const interval = window.setInterval(() => {
      void fetchStatus();
    }, pollMs);
    return () => window.clearInterval(interval);
  }, [enabled, fetchStatus, pollMs]);

  return [snapshot, fetchStatus] as const;
}
