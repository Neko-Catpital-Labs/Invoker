import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { WorkflowStatusChips } from '../components/WorkflowStatusChips.js';
import { useQueueStatus } from '../hooks/useQueueStatus.js';
import { useTasks } from '../hooks/useTasks.js';
import type { QueueStatus, WorkflowMeta } from '../types.js';
import { createMockInvoker, makeUITask, type MockInvoker } from './helpers/mock-invoker.js';

vi.setConfig({ testTimeout: 20_000 });

async function flushInitialQueuePoll(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

async function flushTaskAndWorkflowEvents(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100);
  });
}

function QueueStatusProbe(): JSX.Element {
  const { workflows } = useTasks();
  const queueStatus = useQueueStatus();

  return (
    <WorkflowStatusChips
      workflows={workflows}
      activeFilters={new Set()}
      onStatusClick={() => {}}
      queueStatus={queueStatus}
    />
  );
}

describe('queue status can lag behind live workflow/task updates', () => {
  let mock: MockInvoker;
  let visibility: DocumentVisibilityState;
  let queueStatus: QueueStatus;

  beforeEach(() => {
    vi.useFakeTimers();
    visibility = 'visible';
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => visibility,
    });

    queueStatus = {
      maxConcurrency: 13,
      runningCount: 0,
      activeExecutionCount: 0,
      launchingCount: 0,
      running: [],
      queued: [],
    };

    mock = createMockInvoker();
    mock.api.getQueueStatus = vi.fn(async () => ({
      maxConcurrency: queueStatus.maxConcurrency,
      runningCount: queueStatus.runningCount,
      activeExecutionCount: queueStatus.activeExecutionCount,
      launchingCount: queueStatus.launchingCount,
      running: [...queueStatus.running],
      queued: [...queueStatus.queued],
    }));
    mock.install();
    (window as unknown as { __INVOKER_BOOTSTRAP__?: unknown }).__INVOKER_BOOTSTRAP__ = {
      tasks: [],
      workflows: [],
      streamSequence: 0,
    };
  });

  afterEach(() => {
    mock.cleanup();
    delete (window as unknown as { __INVOKER_BOOTSTRAP__?: unknown }).__INVOKER_BOOTSTRAP__;
    vi.useRealTimers();
  });

  it('shows a running workflow while the queue chips still read 0/13 until the next queue poll', async () => {
    render(<QueueStatusProbe />);
    await flushInitialQueuePoll();

    expect(screen.getByTestId('queue-chip-running')).toHaveTextContent('Executing (0/13)');
    expect(screen.getByTestId('queue-chip-slots')).toHaveTextContent('Slots (0/13)');

    const workflow: WorkflowMeta = {
      id: 'wf-ssh-stale',
      name: 'CI Fix Step 3 - SSH Shard Stability',
      status: 'running',
    };
    const runningTask = makeUITask({
      id: 'wf-ssh-stale/implement-ssh-shard-fixes',
      workflowId: 'wf-ssh-stale',
      description: 'Resolve shard-30 and shard-31 SSH regressions in cross-executor case scripts',
      status: 'running',
      execution: { phase: 'executing' },
      taskStateVersion: 1,
    });

    queueStatus = {
      maxConcurrency: 13,
      runningCount: 1,
      activeExecutionCount: 1,
      launchingCount: 0,
      running: [{ taskId: runningTask.id, description: runningTask.description }],
      queued: [],
    };

    await act(async () => {
      mock.setTasks([runningTask], [workflow]);
      await Promise.resolve();
    });
    await flushTaskAndWorkflowEvents();

    expect(screen.getByTestId('workflow-status-pill-running')).toHaveTextContent('workflows running (1)');
    expect(screen.getByTestId('queue-chip-running')).toHaveTextContent('Executing (0/13)');
    expect(screen.getByTestId('queue-chip-slots')).toHaveTextContent('Slots (0/13)');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_899);
    });
    expect(screen.getByTestId('queue-chip-running')).toHaveTextContent('Executing (0/13)');
    expect(screen.getByTestId('queue-chip-slots')).toHaveTextContent('Slots (0/13)');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(screen.getByTestId('queue-chip-running')).toHaveTextContent('Executing (1/13)');
    expect(screen.getByTestId('queue-chip-slots')).toHaveTextContent('Slots (1/13)');
  });

  it('stays stale while a queue poll is in flight, because later ticks are skipped', async () => {
    const slowPoll = Promise.withResolvers<QueueStatus>();
    let pollCount = 0;
    mock.api.getQueueStatus = vi.fn(async () => {
      pollCount += 1;
      if (pollCount === 1) {
        return {
          maxConcurrency: 13,
          runningCount: 0,
          activeExecutionCount: 0,
          launchingCount: 0,
          running: [],
          queued: [],
        };
      }
      if (pollCount === 2) {
        return slowPoll.promise;
      }
      return {
        maxConcurrency: queueStatus.maxConcurrency,
        runningCount: queueStatus.runningCount,
        activeExecutionCount: queueStatus.activeExecutionCount,
        launchingCount: queueStatus.launchingCount,
        running: [...queueStatus.running],
        queued: [...queueStatus.queued],
      };
    });

    render(<QueueStatusProbe />);
    await flushInitialQueuePoll();

    expect(screen.getByTestId('queue-chip-running')).toHaveTextContent('Executing (0/13)');
    expect(screen.getByTestId('queue-chip-slots')).toHaveTextContent('Slots (0/13)');

    const workflow: WorkflowMeta = {
      id: 'wf-slow-poll',
      name: 'CI Fix Step 3 - SSH Shard Stability',
      status: 'running',
    };
    const runningTask = makeUITask({
      id: 'wf-slow-poll/implement-ssh-shard-fixes',
      workflowId: 'wf-slow-poll',
      description: 'Resolve shard-30 and shard-31 SSH regressions in cross-executor case scripts',
      status: 'running',
      execution: { phase: 'executing' },
      taskStateVersion: 1,
    });

    queueStatus = {
      maxConcurrency: 13,
      runningCount: 1,
      activeExecutionCount: 1,
      launchingCount: 0,
      running: [{ taskId: runningTask.id, description: runningTask.description }],
      queued: [],
    };

    await act(async () => {
      mock.setTasks([runningTask], [workflow]);
      await Promise.resolve();
    });
    await flushTaskAndWorkflowEvents();

    expect(screen.getByTestId('workflow-status-pill-running')).toHaveTextContent('workflows running (1)');
    expect(screen.getByTestId('queue-chip-running')).toHaveTextContent('Executing (0/13)');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_899);
    });
    expect(screen.getByTestId('queue-chip-running')).toHaveTextContent('Executing (0/13)');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
      await Promise.resolve();
    });
    expect(screen.getByTestId('queue-chip-running')).toHaveTextContent('Executing (0/13)');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(screen.getByTestId('queue-chip-running')).toHaveTextContent('Executing (0/13)');
    expect(screen.getByTestId('queue-chip-slots')).toHaveTextContent('Slots (0/13)');

    await act(async () => {
      slowPoll.resolve({
        maxConcurrency: queueStatus.maxConcurrency,
        runningCount: queueStatus.runningCount,
        activeExecutionCount: queueStatus.activeExecutionCount,
        launchingCount: queueStatus.launchingCount,
        running: [...queueStatus.running],
        queued: [...queueStatus.queued],
      });
      await Promise.resolve();
    });
    expect(screen.getByTestId('queue-chip-running')).toHaveTextContent('Executing (1/13)');
    expect(screen.getByTestId('queue-chip-slots')).toHaveTextContent('Slots (1/13)');
  });

  it('keeps the old queue numbers after a poll error until a later poll succeeds', async () => {
    let pollCount = 0;
    mock.api.getQueueStatus = vi.fn(async () => {
      pollCount += 1;
      if (pollCount === 1) {
        return {
          maxConcurrency: 13,
          runningCount: 0,
          activeExecutionCount: 0,
          launchingCount: 0,
          running: [],
          queued: [],
        };
      }
      if (pollCount === 2) {
        throw new Error('queue read failed');
      }
      return {
        maxConcurrency: queueStatus.maxConcurrency,
        runningCount: queueStatus.runningCount,
        activeExecutionCount: queueStatus.activeExecutionCount,
        launchingCount: queueStatus.launchingCount,
        running: [...queueStatus.running],
        queued: [...queueStatus.queued],
      };
    });

    render(<QueueStatusProbe />);
    await flushInitialQueuePoll();

    expect(screen.getByTestId('queue-chip-running')).toHaveTextContent('Executing (0/13)');
    expect(screen.getByTestId('queue-chip-slots')).toHaveTextContent('Slots (0/13)');

    const workflow: WorkflowMeta = {
      id: 'wf-poll-error',
      name: 'CI Fix Step 3 - SSH Shard Stability',
      status: 'running',
    };
    const runningTask = makeUITask({
      id: 'wf-poll-error/implement-ssh-shard-fixes',
      workflowId: 'wf-poll-error',
      description: 'Resolve shard-30 and shard-31 SSH regressions in cross-executor case scripts',
      status: 'running',
      execution: { phase: 'executing' },
      taskStateVersion: 1,
    });

    queueStatus = {
      maxConcurrency: 13,
      runningCount: 1,
      activeExecutionCount: 1,
      launchingCount: 0,
      running: [{ taskId: runningTask.id, description: runningTask.description }],
      queued: [],
    };

    await act(async () => {
      mock.setTasks([runningTask], [workflow]);
      await Promise.resolve();
    });
    await flushTaskAndWorkflowEvents();

    expect(screen.getByTestId('workflow-status-pill-running')).toHaveTextContent('workflows running (1)');
    expect(screen.getByTestId('queue-chip-running')).toHaveTextContent('Executing (0/13)');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_899);
    });
    expect(screen.getByTestId('queue-chip-running')).toHaveTextContent('Executing (0/13)');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
      await Promise.resolve();
    });
    expect(screen.getByTestId('queue-chip-running')).toHaveTextContent('Executing (0/13)');
    expect(screen.getByTestId('queue-chip-slots')).toHaveTextContent('Slots (0/13)');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
      await Promise.resolve();
    });
    expect(screen.getByTestId('queue-chip-running')).toHaveTextContent('Executing (1/13)');
    expect(screen.getByTestId('queue-chip-slots')).toHaveTextContent('Slots (1/13)');
  });

  it('stays stale while the window is hidden, then catches up on visibility restore', async () => {
    render(<QueueStatusProbe />);
    await flushInitialQueuePoll();

    expect(screen.getByTestId('queue-chip-running')).toHaveTextContent('Executing (0/13)');
    expect(screen.getByTestId('queue-chip-slots')).toHaveTextContent('Slots (0/13)');

    await act(async () => {
      visibility = 'hidden';
      document.dispatchEvent(new Event('visibilitychange'));
    });

    const workflow: WorkflowMeta = {
      id: 'wf-hidden-stale',
      name: 'CI Fix Step 3 - SSH Shard Stability',
      status: 'running',
    };
    const runningTask = makeUITask({
      id: 'wf-hidden-stale/implement-ssh-shard-fixes',
      workflowId: 'wf-hidden-stale',
      description: 'Resolve shard-30 and shard-31 SSH regressions in cross-executor case scripts',
      status: 'running',
      execution: { phase: 'executing' },
      taskStateVersion: 1,
    });

    queueStatus = {
      maxConcurrency: 13,
      runningCount: 1,
      activeExecutionCount: 1,
      launchingCount: 0,
      running: [{ taskId: runningTask.id, description: runningTask.description }],
      queued: [],
    };

    await act(async () => {
      mock.setTasks([runningTask], [workflow]);
      await Promise.resolve();
    });
    await flushTaskAndWorkflowEvents();

    expect(screen.getByTestId('workflow-status-pill-running')).toHaveTextContent('workflows running (1)');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(screen.getByTestId('queue-chip-running')).toHaveTextContent('Executing (0/13)');
    expect(screen.getByTestId('queue-chip-slots')).toHaveTextContent('Slots (0/13)');

    await act(async () => {
      visibility = 'visible';
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(249);
    });
    expect(screen.getByTestId('queue-chip-running')).toHaveTextContent('Executing (0/13)');
    expect(screen.getByTestId('queue-chip-slots')).toHaveTextContent('Slots (0/13)');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(screen.getByTestId('queue-chip-running')).toHaveTextContent('Executing (1/13)');
    expect(screen.getByTestId('queue-chip-slots')).toHaveTextContent('Slots (1/13)');
  });
});
