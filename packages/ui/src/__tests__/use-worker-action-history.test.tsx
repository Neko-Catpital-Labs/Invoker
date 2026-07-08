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
