import { useCallback, useEffect, useRef, useState } from 'react';
import type { WorkerStatusSnapshot } from '../types.js';
import { areStructurallyEqual } from './useDedupedState.js';
import { subscribeVisibilityAwarePoll } from './visibilityAwarePoll.js';

export function useWorkerStatus(
  pollMs = 2000,
  enabled = true,
): readonly [snapshot: WorkerStatusSnapshot | null, refresh: () => Promise<void>] {
  const [snapshot, setSnapshot] = useState<WorkerStatusSnapshot | null>(null);
  const mountedRef = useRef(true);
  const inFlightRef = useRef(false);

  useEffect(() => () => {
    mountedRef.current = false;
  }, []);

  const fetchStatus = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      const status = await window.invoker?.getWorkers();
      if (mountedRef.current && status) {
        setSnapshot((previous) =>
          areStructurallyEqual(previous, status) ? previous : status,
        );
      }
    } catch {
      // ignore polling errors
    } finally {
      inFlightRef.current = false;
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    return subscribeVisibilityAwarePoll(() => {
      void fetchStatus();
    }, pollMs, { restoreDelayMs: 100 });
  }, [enabled, fetchStatus, pollMs]);

  return [snapshot, fetchStatus] as const;
}
