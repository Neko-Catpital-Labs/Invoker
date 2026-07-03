import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useActionGraphSnapshot } from '../hooks/useActionGraphSnapshot.js';

const emptyGraph = { generatedAt: '2026-06-30T00:00:00.000Z', stallThresholdMs: 60_000, nodes: [], edges: [] };

describe('useActionGraphSnapshot', () => {
  beforeEach(() => {
    vi.useRealTimers();
    (window as unknown as { invoker: Record<string, unknown> }).invoker = {
      getActionGraph: vi.fn().mockResolvedValue(emptyGraph),
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (window as unknown as { invoker?: unknown }).invoker;
  });

  it('does not fetch action graph data while disabled', async () => {
    const getActionGraph = vi.fn().mockResolvedValue(emptyGraph);
    (window as unknown as { invoker: Record<string, unknown> }).invoker = { getActionGraph };

    const { result, unmount } = renderHook(() => useActionGraphSnapshot(20, false));

    await act(async () => {
      await result.current.refreshActionGraph();
    });

    expect(getActionGraph).not.toHaveBeenCalled();
    expect(result.current.graph).toBeNull();
    unmount();
  });

  it('fetches immediately when enabled', async () => {
    const getActionGraph = vi.fn().mockResolvedValue(emptyGraph);
    (window as unknown as { invoker: Record<string, unknown> }).invoker = { getActionGraph };

    const { result, rerender, unmount } = renderHook(({ enabled }) => useActionGraphSnapshot(20, enabled), {
      initialProps: { enabled: false },
    });

    rerender({ enabled: true });

    await waitFor(() => {
      expect(result.current.graph).toEqual(emptyGraph);
    });
    expect(getActionGraph).toHaveBeenCalled();
    unmount();
  });
});
