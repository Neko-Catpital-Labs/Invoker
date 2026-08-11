/**
 * Repro: after rebase+recreate, the UI can show a task as pending forever while
 * backend truth has already moved the task to running (Executing stays 0/N when
 * chips are derived from the task map).
 *
 * Mechanism under test (mutation-accept refresh race):
 *   1. Recreate resets the task → pending delta applies (matches user: "I see pending").
 *   2. Launch publishes running/executing delta.
 *   3. trackAcceptedMutation fires non-forced refreshTaskGraph; the snapshot is
 *      still mid-reset pending but stamped with the current (advanced) stream
 *      sequence — exactly what publishSnapshot + syncAllFromDb can emit.
 *   4. useTasks replaces the task map with that pending snapshot and advances
 *      the watermark, so the running delta is lost / clobbered.
 *
 * Correct behavior (assertions below): UI must show running after the race.
 * On current HEAD this test is expected to FAIL, proving the drift.
 *
 * Self-contained for git bisect: does not import getLiveQueueCounts (newer API).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useTasks } from '../hooks/useTasks.js';
import { makeUITask } from './helpers/mock-invoker.js';
import type { WorkflowMeta } from '../types.js';

vi.setConfig({ testTimeout: 20_000 });

const TASK_ID = 'wf-rebase-recreate/a';
const WORKFLOW_ID = 'wf-rebase-recreate';

function flushPipeline(ms = 130): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

function countActiveExecuting(tasks: Map<string, { status: string; execution?: { crashPreservedAt?: unknown } }>): number {
  let count = 0;
  for (const task of tasks.values()) {
    if (task.execution?.crashPreservedAt) continue;
    if (task.status === 'running' || task.status === 'fixing_with_ai') count += 1;
  }
  return count;
}

function makeFailedTask() {
  return makeUITask({
    id: TASK_ID,
    workflowId: WORKFLOW_ID, description: 'Fails then rebase-recreates',
    status: 'failed',
    execution: { phase: 'idle', exitCode: 1 },
    taskStateVersion: 1,
  });
}

function makePendingTask(version: number) {
  return makeUITask({
    id: TASK_ID,
    workflowId: WORKFLOW_ID, description: 'Fails then rebase-recreates',
    status: 'pending',
    execution: { phase: 'idle' },
    taskStateVersion: version,
  });
}

function makeRunningTask(version: number) {
  return makeUITask({
    id: TASK_ID,
    workflowId: WORKFLOW_ID, description: 'Fails then rebase-recreates',
    status: 'running',
    execution: { phase: 'executing', selectedAttemptId: 'attempt-1' },
    taskStateVersion: version,
  });
}

const workflow: WorkflowMeta = {
  id: WORKFLOW_ID,
  name: 'Rebase Recreate Drift',
  status: 'running',
};

describe('rebase-recreate UI task-graph drift', () => {
  let taskGraphEventHandler: ((event: unknown) => void) | undefined;

  beforeEach(() => {
    vi.useRealTimers();
    taskGraphEventHandler = undefined;
    (window as unknown as { __INVOKER_BOOTSTRAP__?: unknown }).__INVOKER_BOOTSTRAP__ = {
      tasks: [],
      workflows: [],
      streamSequence: 0,
    };
    (window as unknown as { invoker: Record<string, unknown> }).invoker = {
      getTasks: vi.fn().mockResolvedValue({ tasks: [], workflows: [], streamSequence: 0 }),
      listWorkflows: vi.fn().mockResolvedValue([]),
      reportUiPerf: vi.fn().mockResolvedValue(undefined),
      refreshTaskGraph: vi.fn().mockResolvedValue(undefined),
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

  it('keeps running after recreate when a stale pending refresh snapshot races the stream', async () => {
    const { result } = renderHook(() => useTasks());

    // Seed: failed task (pre-recreate).
    await act(async () => {
      taskGraphEventHandler!({
        type: 'snapshot',
        tasks: [makeFailedTask()],
        workflows: [workflow],
        reason: 'live',
        streamSequence: 1,
      });
      await flushPipeline();
    });
    expect(result.current.tasks.get(TASK_ID)?.status).toBe('failed');

    // 1. Recreate reset → pending (user sees this).
    await act(async () => {
      taskGraphEventHandler!({
        type: 'delta',
        delta: {
          type: 'updated',
          taskId: TASK_ID,
          changes: { status: 'pending', execution: { phase: 'idle' } },
          taskStateVersion: 2,
          previousTaskStateVersion: 1,
          streamSequence: 2,
        },
        workflowRollups: [],
      });
      await flushPipeline();
    });
    expect(result.current.tasks.get(TASK_ID)?.status).toBe('pending');

    // 2. Backend progresses to running (orchestrator/query truth).
    const backendTruth = makeRunningTask(3);
    await act(async () => {
      taskGraphEventHandler!({
        type: 'delta',
        delta: {
          type: 'updated',
          taskId: TASK_ID,
          changes: {
            status: 'running',
            execution: { phase: 'executing', selectedAttemptId: 'attempt-1' },
          },
          taskStateVersion: 3,
          previousTaskStateVersion: 2,
          streamSequence: 3,
        },
        workflowRollups: [],
      });
      await flushPipeline();
    });
    expect(result.current.tasks.get(TASK_ID)?.status).toBe('running');
    expect(countActiveExecuting(result.current.tasks)).toBe(1);

    // 3. Non-forced mutation-accept refresh: mid-launch pending snapshot stamped
    // with the current advanced stream sequence (publishSnapshot behavior).
    await act(async () => {
      taskGraphEventHandler!({
        type: 'snapshot',
        tasks: [makePendingTask(2)],
        workflows: [{ ...workflow, status: 'pending' }],
        reason: 'refresh-task-graph',
        streamSequence: 3,
        // forced intentionally omitted — desktop IPC does not pass forced today
      });
      await flushPipeline();
    });

    const uiStatus = result.current.tasks.get(TASK_ID)?.status;
    const uiExecuting = countActiveExecuting(result.current.tasks);

    // Backend already running; UI must not stay stuck on pending / Executing 0.
    expect(backendTruth.status).toBe('running');
    expect(uiStatus).toBe('running');
    expect(uiExecuting).toBe(1);
  });
});
