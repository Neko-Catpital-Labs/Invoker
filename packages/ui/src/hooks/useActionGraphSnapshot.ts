import { useCallback, useEffect, useState } from 'react';
import type { ActionGraphResponse } from '@invoker/contracts';

export function useActionGraphSnapshot(pollMs = 2000): {
  graph: ActionGraphResponse | null;
  error: string | null;
  refreshActionGraph: () => Promise<void>;
} {
  const [graph, setGraph] = useState<ActionGraphResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshActionGraph = useCallback(async () => {
    try {
      const response = await window.invoker?.getActionGraph?.();
      if (response) {
        setGraph(response);
        setError(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    const poll = async () => {
      try {
        const response = await window.invoker?.getActionGraph?.();
        if (!cancelled && response) {
          setGraph(response);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
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

  return { graph, error, refreshActionGraph };
}
