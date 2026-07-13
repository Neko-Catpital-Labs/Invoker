import { useCallback, useEffect, useState } from 'react';
import type { ActionGraphResponse } from '@invoker/contracts';
import { areStructurallyEqual } from './useDedupedState.js';
import { subscribeVisibilityAwarePoll } from './visibilityAwarePoll.js';

export function useActionGraphSnapshot(pollMs = 2000, enabled = true): {
  graph: ActionGraphResponse | null;
  error: string | null;
  refreshActionGraph: () => Promise<void>;
} {
  const [graph, setGraph] = useState<ActionGraphResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshActionGraph = useCallback(async () => {
    if (!enabled) return;
    try {
      const response = await window.invoker?.getActionGraph?.();
      if (response) {
        setGraph((previous) =>
          areStructurallyEqual(previous, response) ? previous : response,
        );
        setError(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let inFlight = false;

    const poll = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const response = await window.invoker?.getActionGraph?.();
        if (!cancelled && response) {
          setGraph((previous) =>
            areStructurallyEqual(previous, response) ? previous : response,
          );
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        inFlight = false;
      }
    };

    const unsubscribe = subscribeVisibilityAwarePoll(() => {
      void poll();
    }, pollMs, { restoreDelayMs: 400, initialDelayMs: 150 });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [enabled, pollMs]);

  return { graph, error, refreshActionGraph };
}
