import { useCallback, useEffect, useRef, useState } from 'react';
import type { WorkerActionSummary, WorkerDecisionsRequest } from '../types.js';
import { subscribeVisibilityAwarePoll } from './visibilityAwarePoll.js';

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
    if (!key) {
      void fetchDecisions();
      return undefined;
    }
    // Visibility-gated so the 4s poll does not tick while backgrounded and land
    // in the refocus turn; initialDelay lets the panel paint before the fetch.
    return subscribeVisibilityAwarePoll(() => {
      void fetchDecisions();
    }, pollMs, { restoreDelayMs: 300, initialDelayMs: 150 });
  }, [fetchDecisions, key, pollMs]);

  return [decisions, fetchDecisions] as const;
}
