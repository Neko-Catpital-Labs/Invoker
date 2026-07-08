import { useCallback, useEffect, useRef, useState } from 'react';
import type { WorkerActionSummary } from '../types.js';

/** Page size for the worker action history pane; each "load older" click fetches one more page. */
export const WORKER_ACTION_HISTORY_PAGE_SIZE = 20;

export interface WorkerActionHistoryState {
  /** Accumulated actions, newest first. Older pages are appended, never replaced. */
  readonly actions: readonly WorkerActionSummary[];
  /** First page is loading (no rows shown yet). */
  readonly loading: boolean;
  /** A "load older" page is in flight. */
  readonly loadingMore: boolean;
  /** The store reports more rows past what is loaded. */
  readonly hasMore: boolean;
  /** Last fetch error, or null. Surfaced so failures are visible rather than swallowed. */
  readonly error: string | null;
  /** Fetch the next page and append it to `actions`. No-op while a fetch is in flight or when nothing is selected. */
  readonly loadMore: () => void;
}

/**
 * Loads a single worker's durable action history with cursor pagination.
 *
 * Selecting a different worker resets the list and loads its first page. Calling
 * `loadMore()` appends the next page so older history accumulates below the first
 * page instead of replacing it. There is no polling: the pane reflects the worker
 * as of selection/load, which keeps the "load older without replacing" invariant
 * simple and correct.
 */
export function useWorkerActionHistory(
  workerKind: string | null,
  pageSize: number = WORKER_ACTION_HISTORY_PAGE_SIZE,
): WorkerActionHistoryState {
  const [actions, setActions] = useState<WorkerActionSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Cursor for the next page and a monotonic request id so stale responses (from a
  // superseded worker selection or overlapping loadMore) are ignored.
  const nextOffsetRef = useRef(0);
  const requestSeqRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const fetchPage = useCallback(
    async (kind: string, offset: number, mode: 'reset' | 'append') => {
      const seq = ++requestSeqRef.current;
      if (mode === 'reset') setLoading(true);
      else setLoadingMore(true);
      setError(null);
      try {
        const response = await window.invoker?.getWorkerActionHistory({ workerKind: kind, limit: pageSize, offset });
        if (!mountedRef.current || seq !== requestSeqRef.current) return;
        if (!response) return;
        setActions((prev) => (mode === 'reset' ? [...response.actions] : [...prev, ...response.actions]));
        setHasMore(response.hasMore);
        nextOffsetRef.current = response.nextOffset ?? offset + response.actions.length;
      } catch (err) {
        if (!mountedRef.current || seq !== requestSeqRef.current) return;
        // Surface the failure explicitly instead of silently leaving the pane blank.
        console.error(`Failed to load worker action history for "${kind}" at offset ${offset}:`, err);
        setError(err instanceof Error ? err.message : String(err));
        if (mode === 'reset') {
          setActions([]);
          setHasMore(false);
        }
      } finally {
        if (mountedRef.current && seq === requestSeqRef.current) {
          if (mode === 'reset') setLoading(false);
          else setLoadingMore(false);
        }
      }
    },
    [pageSize],
  );

  useEffect(() => {
    nextOffsetRef.current = 0;
    setActions([]);
    setHasMore(false);
    setError(null);
    setLoadingMore(false);
    if (!workerKind) {
      // Cancel any in-flight page and drop to the idle empty state.
      requestSeqRef.current += 1;
      setLoading(false);
      return;
    }
    void fetchPage(workerKind, 0, 'reset');
  }, [workerKind, fetchPage]);

  const loadMore = useCallback(() => {
    if (!workerKind || loading || loadingMore || !hasMore) return;
    void fetchPage(workerKind, nextOffsetRef.current, 'append');
  }, [workerKind, loading, loadingMore, hasMore, fetchPage]);

  return { actions, loading, loadingMore, hasMore, error, loadMore };
}
