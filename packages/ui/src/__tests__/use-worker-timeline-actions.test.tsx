import React, { StrictMode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useWorkerTimelineActions } from '../hooks/useWorkerTimelineActions.js';

describe('useWorkerTimelineActions', () => {
  beforeEach(() => {
    vi.useRealTimers();
    (window as unknown as { invoker: Record<string, unknown> }).invoker = {
      getWorkerDecisions: vi.fn().mockResolvedValue({
        actions: [
          {
            id: 'wa-1',
            workerKind: 'autofix',
            actionType: 'repair',
            workflowId: 'wf-1',
            taskId: 'wf-1/task-1',
            subjectType: 'task',
            subjectId: 'wf-1/task-1',
            externalKey: 'wa-1',
            status: 'completed',
            attemptCount: 1,
            createdAt: '2026-07-15T10:00:00.000Z',
            updatedAt: '2026-07-15T10:00:10.000Z',
            completedAt: '2026-07-15T10:00:10.000Z',
          },
        ],
        limit: 100,
        offset: 0,
        hasMore: false,
        workflowId: 'wf-1',
      }),
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (window as unknown as { invoker?: unknown }).invoker;
  });

  it('hydrates worker actions under StrictMode', async () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => <StrictMode>{children}</StrictMode>;
    const { result } = renderHook(() => useWorkerTimelineActions('wf-1', 10_000), { wrapper });

    await waitFor(() => {
      expect(result.current.actions).toHaveLength(1);
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.actions[0]?.id).toBe('wa-1');
    expect(window.invoker.getWorkerDecisions).toHaveBeenCalledWith({ workflowId: 'wf-1', limit: 100, offset: 0 });
  });
});
