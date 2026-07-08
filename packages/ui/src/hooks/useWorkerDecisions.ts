import { useCallback, useEffect, useRef, useState } from 'react';
import type { WorkerActionSummary, WorkerDecisionsRequest } from '../types.js';

export function useWorkerDecisions(
  request: WorkerDecisionsRequest | null,
  pollMs = 4000,
): readonly [decisions: WorkerActionSummary[], refresh: () => Promise<void>] {
  const [decisions, setDecisions] = useState<WorkerActionSummary[]>([]);
  const mountedRef = useRef(true);
  const key = request ? JSON.stringify(request) : null;

  useEffect(() => () => {
    mountedRef.current = false;
  }, []);

  const fetchDecisions = useCallback(async () => {
    if (!key) {
      setDecisions([]);
      return;
    }
    try {
      const response = await window.invoker?.getWorkerDecisions?.(JSON.parse(key) as WorkerDecisionsRequest);
      if (mountedRef.current && response) {
        setDecisions(response.actions);
      }
    } catch (err) {
      console.warn('[useWorkerDecisions] poll failed', err);
    }
  }, [key]);

  useEffect(() => {
    void fetchDecisions();
    if (!key) return undefined;
    const interval = window.setInterval(() => {
      void fetchDecisions();
    }, pollMs);
    return () => window.clearInterval(interval);
  }, [fetchDecisions, key, pollMs]);

  return [decisions, fetchDecisions] as const;
}
