import { StrictMode, type ReactNode } from 'react';
import { renderHook, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useWorkerActionHistory } from '../hooks/useWorkerActionHistory.js';
import type { WorkerActionHistoryRequest, WorkerActionHistoryResponse } from '@invoker/contracts';
import type { WorkerActionSummary } from '../types.js';

function makeAction(id: string): WorkerActionSummary {
  return {
    id,
    workerKind: 'autofix',
    actionType: 'fix-with-agent',
    subjectType: 'task',
    subjectId: id,
    externalKey: id,
    status: 'completed',
    attemptCount: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

/** In-memory history keyed by worker kind; the fake paginates it like the real store. */
const history: Record<string, WorkerActionSummary[]> = {};

function pageFor(kind: string, offset: number, limit: number): WorkerActionHistoryResponse {
  const all = history[kind] ?? [];
  const page = all.slice(offset, offset + limit);
  const hasMore = offset + limit < all.length;
  return {
    workerKind: kind,
    actions: page,
    limit,
    offset,
    hasMore,
    ...(hasMore ? { nextOffset: offset + page.length } : {}),
  };
}

function deferredResponse(): {
  promise: Promise<WorkerActionHistoryResponse>;
  resolve: (response: WorkerActionHistoryResponse) => void;
} {
  let resolve: (response: WorkerActionHistoryResponse) => void = () => {
    throw new Error('deferred response resolved before initialization');
  };
  const promise = new Promise<WorkerActionHistoryResponse>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function setHistoryFn(fn: (request: WorkerActionHistoryRequest) => Promise<WorkerActionHistoryResponse>) {
  (window as unknown as { invoker: { getWorkerActionHistory: typeof fn } }).invoker = { getWorkerActionHistory: fn };
}

describe('useWorkerActionHistory', () => {
  beforeEach(() => {
    for (const key of Object.keys(history)) delete history[key];
    setHistoryFn(vi.fn(async ({ workerKind, offset, limit }) => pageFor(workerKind, offset ?? 0, limit ?? 1000)));
  });

  afterEach(() => {
    delete (window as unknown as { invoker?: unknown }).invoker;
  });

  it('loads the first page for the selected worker', async () => {
    history.autofix = [makeAction('a1'), makeAction('a2'), makeAction('a3')];

    const { result } = renderHook(() => useWorkerActionHistory('autofix', 2));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.actions.map((a) => a.id)).toEqual(['a1', 'a2']);
    expect(result.current.hasMore).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it('loads the first page under React StrictMode remounts', async () => {
    history.autofix = [makeAction('a1')];
    const deferred = deferredResponse();
    setHistoryFn(vi.fn(() => deferred.promise));

    const wrapper = ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>;
    const { result } = renderHook(() => useWorkerActionHistory('autofix', 5), { wrapper });

    await act(async () => {
      deferred.resolve(pageFor('autofix', 0, 5));
    });

    await waitFor(() => expect(result.current.actions.map((a) => a.id)).toEqual(['a1']));
    expect(result.current.loading).toBe(false);
  });

  it('appends older pages on loadMore and stops when exhausted', async () => {
    history.autofix = [makeAction('a1'), makeAction('a2'), makeAction('a3')];

    const { result } = renderHook(() => useWorkerActionHistory('autofix', 2));
    await waitFor(() => expect(result.current.actions).toHaveLength(2));

    act(() => result.current.loadMore());

    await waitFor(() => expect(result.current.actions).toHaveLength(3));
    expect(result.current.actions.map((a) => a.id)).toEqual(['a1', 'a2', 'a3']);
    expect(result.current.hasMore).toBe(false);
  });

  it('resets and reloads when the selected worker changes', async () => {
    history.autofix = [makeAction('a1')];
    history['ci-failure'] = [makeAction('c1'), makeAction('c2')];

    const { result, rerender } = renderHook(({ kind }) => useWorkerActionHistory(kind, 5), {
      initialProps: { kind: 'autofix' as string | null },
    });
    await waitFor(() => expect(result.current.actions.map((a) => a.id)).toEqual(['a1']));

    rerender({ kind: 'ci-failure' });

    await waitFor(() => expect(result.current.actions.map((a) => a.id)).toEqual(['c1', 'c2']));
  });

  it('clears loadingMore when switching workers during an older-page fetch', async () => {
    history.autofix = [makeAction('a1'), makeAction('a2'), makeAction('a3')];
    history['ci-failure'] = [makeAction('c1'), makeAction('c2'), makeAction('c3')];
    const deferredAppend = deferredResponse();
    const fn = vi.fn(({ workerKind, offset, limit }: WorkerActionHistoryRequest) => {
      if (workerKind === 'autofix' && (offset ?? 0) === 2) return deferredAppend.promise;
      return Promise.resolve(pageFor(workerKind, offset ?? 0, limit ?? 1000));
    });
    setHistoryFn(fn);

    const { result, rerender } = renderHook(({ kind }) => useWorkerActionHistory(kind, 2), {
      initialProps: { kind: 'autofix' as string | null },
    });
    await waitFor(() => expect(result.current.actions.map((a) => a.id)).toEqual(['a1', 'a2']));

    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.loadingMore).toBe(true));

    rerender({ kind: 'ci-failure' });
    await waitFor(() => expect(result.current.actions.map((a) => a.id)).toEqual(['c1', 'c2']));

    await act(async () => {
      deferredAppend.resolve(pageFor('autofix', 2, 2));
    });

    expect(result.current.loadingMore).toBe(false);
    expect(result.current.hasMore).toBe(true);
  });

  it('does not fetch when no worker is selected', async () => {
    const fn = vi.fn(async ({ workerKind, offset, limit }: WorkerActionHistoryRequest) =>
      pageFor(workerKind, offset ?? 0, limit ?? 1000),
    );
    setHistoryFn(fn);

    const { result } = renderHook(() => useWorkerActionHistory(null));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fn).not.toHaveBeenCalled();
    expect(result.current.actions).toEqual([]);
    expect(result.current.hasMore).toBe(false);
  });

  it('surfaces and logs fetch errors instead of swallowing them', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    setHistoryFn(vi.fn(async () => {
      throw new Error('boom');
    }));

    const { result } = renderHook(() => useWorkerActionHistory('autofix'));

    await waitFor(() => expect(result.current.error).toBe('boom'));
    expect(result.current.actions).toEqual([]);
    expect(result.current.loading).toBe(false);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
