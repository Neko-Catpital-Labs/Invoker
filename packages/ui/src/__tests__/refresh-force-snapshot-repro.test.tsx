/**
 * Regression repro: the rail refresh button publishes a snapshot stamped with the
 * CURRENT (non-incrementing) stream sequence. Under live delta churn the renderer
 * watermark has already advanced past it, so the snapshot is discarded as stale and
 * the refresh visibly no-ops.
 *
 * A user-initiated refresh must carry `forced: true` and bypass the stale-sequence
 * discard. The final assertion describes the correct post-fix behavior: it fails on
 * the pre-fix code (forced snapshot discarded) and passes after the fix.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTasks } from '../hooks/useTasks.js';
import { makeUITask } from './helpers/mock-invoker.js';

function flushPipeline(ms = 130): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

describe('forced refresh snapshot bypasses the stale-sequence discard', () => {
  let taskGraphEventHandler: ((event: unknown) => void) | undefined;

  beforeEach(() => {
    vi.useRealTimers();
    taskGraphEventHandler = undefined;
    (window as unknown as { __INVOKER_BOOTSTRAP__?: unknown }).__INVOKER_BOOTSTRAP__ = { tasks: [], workflows: [] };
    (window as unknown as { invoker: Record<string, unknown> }).invoker = {
      getTasks: vi.fn().mockResolvedValue({ tasks: [], workflows: [], streamSequence: 0 }),
      listWorkflows: vi.fn().mockResolvedValue([]),
      reportUiPerf: vi.fn().mockResolvedValue(undefined),
      onTaskGraphEvent: vi.fn((cb: (event: unknown) => void) => {
        taskGraphEventHandler = cb;
        return () => {};
      }),
      onWorkflowsChanged: vi.fn(() => () => {}),
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (window as unknown as { invoker?: unknown }).invoker;
    delete (window as unknown as { __INVOKER_BOOTSTRAP__?: unknown }).__INVOKER_BOOTSTRAP__;
  });

  it('applies a forced snapshot even when its stream sequence is behind the watermark', async () => {
    const { result } = renderHook(() => useTasks());

    // Live churn advances the watermark to 10.
    await act(async () => {
      taskGraphEventHandler!({
        type: 'snapshot',
        tasks: [makeUITask({ id: 't1', description: 'first' })],
        workflows: [],
        reason: 'live',
        streamSequence: 10,
      });
      await flushPipeline();
    });
    expect(result.current.tasks.has('t1')).toBe(true);

    // A routine (non-forced) snapshot behind the watermark must stay discarded.
    await act(async () => {
      taskGraphEventHandler!({
        type: 'snapshot',
        tasks: [makeUITask({ id: 't1', description: 'first' }), makeUITask({ id: 't2-stale', description: 'stale' })],
        workflows: [],
        reason: 'stale',
        streamSequence: 5,
      });
      await flushPipeline();
    });
    expect(result.current.tasks.has('t2-stale')).toBe(false);

    // The manual rail refresh: forced snapshot, same low sequence, must APPLY.
    await act(async () => {
      taskGraphEventHandler!({
        type: 'snapshot',
        tasks: [makeUITask({ id: 't1', description: 'first' }), makeUITask({ id: 't2-forced', description: 'forced' })],
        workflows: [],
        reason: 'manual-refresh',
        streamSequence: 5,
        forced: true,
      });
      await flushPipeline();
    });
    expect(result.current.tasks.has('t2-forced')).toBe(true);
  });
});
