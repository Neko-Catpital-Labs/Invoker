/**
 * useTasks — workflows-changed must clear workflow metadata when main sends [].
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useTasks } from '../hooks/useTasks.js';

describe('useTasks', () => {
  let workflowsChangedHandler: ((wfList: unknown[]) => void) | undefined;

  beforeEach(() => {
    workflowsChangedHandler = undefined;
    (window as unknown as { invoker: Record<string, unknown> }).invoker = {
      getTasks: vi.fn().mockResolvedValue({ tasks: [], workflows: [] }),
      onTaskDelta: vi.fn(() => () => {}),
      onWorkflowsChanged: vi.fn((cb: (wfList: unknown[]) => void) => {
        workflowsChangedHandler = cb;
        return () => {};
      }),
    };
  });

  afterEach(() => {
    delete (window as unknown as { invoker?: unknown }).invoker;
  });

  it('clears workflows when onWorkflowsChanged receives an empty array', async () => {
    const { result } = renderHook(() => useTasks());

    await waitFor(() => {
      expect(workflowsChangedHandler).toBeDefined();
    });

    act(() => {
      workflowsChangedHandler!([
        {
          id: 'wf-1',
          name: 'Test workflow',
          status: 'completed',
        },
      ]);
    });

    expect(result.current.workflows.size).toBe(1);
    expect(result.current.workflows.get('wf-1')?.name).toBe('Test workflow');

    act(() => {
      workflowsChangedHandler!([]);
    });

    expect(result.current.workflows.size).toBe(0);
  });

  it('replaces workflows when onWorkflowsChanged receives a non-empty list', async () => {
    const { result } = renderHook(() => useTasks());

    await waitFor(() => {
      expect(workflowsChangedHandler).toBeDefined();
    });

    act(() => {
      workflowsChangedHandler!([
        { id: 'wf-a', name: 'A', status: 'running' },
        { id: 'wf-b', name: 'B', status: 'running' },
      ]);
    });

    expect(result.current.workflows.size).toBe(2);

    act(() => {
      workflowsChangedHandler!([{ id: 'wf-b', name: 'B', status: 'failed' }]);
    });

    expect(result.current.workflows.size).toBe(1);
    expect(result.current.workflows.has('wf-a')).toBe(false);
    expect(result.current.workflows.get('wf-b')?.status).toBe('failed');
  });
});
