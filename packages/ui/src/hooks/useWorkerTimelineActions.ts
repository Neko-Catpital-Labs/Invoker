import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { WorkerActionSummary, WorkerDecisionsRequest, WorkerDecisionsResponse } from '../types.js';
import { subscribeVisibilityAwarePoll } from './visibilityAwarePoll.js';

interface WorkerTimelinePageState {
  readonly head: WorkerDecisionsResponse | null;
  readonly older: readonly WorkerDecisionsResponse[];
}

export interface WorkerTimelineActionsState {
  readonly actions: readonly WorkerActionSummary[];
  readonly loading: boolean;
  readonly loadingMore: boolean;
  readonly hasMore: boolean;
  readonly refresh: () => Promise<void>;
  readonly loadMore: () => Promise<void>;
}

export function useWorkerTimelineActions(
  workflowId: string | null,
  pollMs = 4000,
): WorkerTimelineActionsState {
  const mountedRef = useRef(true);
  const [pages, setPages] = useState<WorkerTimelinePageState>({ head: null, older: [] });
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    setPages({ head: null, older: [] });
  }, [workflowId]);

  const actions = useMemo(() => {
    const seen = new Set<string>();
    const merged: WorkerActionSummary[] = [];
    const allPages = [pages.head, ...pages.older].filter((page): page is WorkerDecisionsResponse => page !== null);
    for (const page of allPages) {
      for (const action of page.actions) {
        if (seen.has(action.id)) continue;
        seen.add(action.id);
        merged.push(action);
      }
    }
    return merged;
  }, [pages]);

  const hasMore = useMemo(() => {
    const tail = pages.older[pages.older.length - 1] ?? pages.head;
    return tail?.hasMore ?? false;
  }, [pages]);

  const nextOffset = useMemo(() => {
    const tail = pages.older[pages.older.length - 1] ?? pages.head;
    if (!tail) return 0;
    return tail.offset + tail.actions.length;
  }, [pages]);

  const fetchPage = useCallback(async (
    request: WorkerDecisionsRequest,
    mode: 'refresh' | 'append',
  ) => {
    const response = await window.invoker?.getWorkerDecisions?.(request);
    if (!mountedRef.current || !response) return;
    setPages((current) => {
      if (mode === 'append') {
        return { head: current.head, older: [...current.older, response] };
      }
      return { head: response, older: current.older };
    });
  }, []);

  const refresh = useCallback(async () => {
    if (!workflowId) {
      setPages({ head: null, older: [] });
      return;
    }
    setLoading(true);
    try {
      await fetchPage({ workflowId, limit: 100, offset: 0 }, 'refresh');
    } catch (err) {
      console.warn('[useWorkerTimelineActions] refresh failed', err);
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [fetchPage, workflowId]);

  const loadMore = useCallback(async () => {
    if (!workflowId || loadingMore || !hasMore) return;
    setLoadingMore(true);
    try {
      await fetchPage({ workflowId, limit: 100, offset: nextOffset }, 'append');
    } catch (err) {
      console.warn('[useWorkerTimelineActions] load more failed', err);
    } finally {
      if (mountedRef.current) setLoadingMore(false);
    }
  }, [fetchPage, hasMore, loadingMore, nextOffset, workflowId]);

  useEffect(() => {
    if (!workflowId) {
      void refresh();
      return undefined;
    }
    return subscribeVisibilityAwarePoll(() => {
      void refresh();
    }, pollMs, { restoreDelayMs: 300, initialDelayMs: 150 });
  }, [pollMs, refresh, workflowId]);

  return {
    actions,
    loading,
    loadingMore,
    hasMore,
    refresh,
    loadMore,
  };
}
