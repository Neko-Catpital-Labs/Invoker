/**
 * Repro: a workflow label can show a failed WorkflowMeta.status while its
 * selected task-graph node still shows a RUNNING TaskState.status.
 *
 * The two come from separate renderer channels:
 *   - Workflow node labels read WorkflowMeta.status.
 *   - Selected mini-DAG task nodes read TaskState.status.
 *   - workflow-rollup returns 'failed' as soon as any task is failed, even when
 *     another task is still running.
 *   - Workflow metadata (onWorkflowsChanged) can arrive after the task deltas
 *     that move a task back to running, so the label lags the task graph.
 *
 * This test preserves the divergence — it does not assert any product fix.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, waitFor, fireEvent, within } from '@testing-library/react';
import { computeWorkflowRollupFromSummaries } from '@invoker/workflow-graph';
import { createMockInvoker, makeUITask, type MockInvoker } from './helpers/mock-invoker.js';
import type { TaskState, WorkflowMeta } from '../types.js';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

const { App } = await import('../App.js');

/** Build WorkflowMeta whose status/rollup come from the real workflow rollup. */
function workflowMetaFromTasks(
  tasks: TaskState[],
  name = 'Divergence Proof Workflow',
): WorkflowMeta {
  const rollup = computeWorkflowRollupFromSummaries(
    tasks.map((task) => ({
      id: task.id,
      description: task.description,
      status: task.status,
      dependencies: task.dependencies,
      execution: task.execution,
    })),
  );

  return {
    id: 'wf-diverge',
    name,
    status: rollup.status,
    rollup,
    baseBranch: 'main',
  };
}

/** Render App, push a snapshot, select the workflow, return its mini-DAG. */
async function renderWorkflow(
  mock: MockInvoker,
  tasks: TaskState[],
  workflows: WorkflowMeta[],
): Promise<HTMLElement> {
  render(<App />);
  act(() => mock.setTasks(tasks, workflows));

  await waitFor(() => {
    expect(screen.getByTestId('workflow-node-wf-diverge')).toBeInTheDocument();
  });

  fireEvent.click(screen.getByTestId('workflow-node-wf-diverge'));

  return screen.findByTestId('selected-workflow-mini-dag');
}

describe('workflow / task-graph status divergence', () => {
  let mock: MockInvoker;

  beforeEach(() => {
    mock = createMockInvoker();
    mock.install();
  });

  afterEach(() => {
    mock.cleanup();
  });

  it('shows a failed workflow beside a running task when the real rollup has both statuses', async () => {
    const runningTask = makeUITask({
      id: 'wf-diverge/running-task',
      description: 'Still running task',
      status: 'running',
      workflowId: 'wf-diverge',
      execution: { phase: 'executing' },
      taskStateVersion: 1,
    });
    const failedTask = makeUITask({
      id: 'wf-diverge/failed-task',
      description: 'Already failed task',
      status: 'failed',
      workflowId: 'wf-diverge',
      taskStateVersion: 1,
    });

    const workflow = workflowMetaFromTasks([runningTask, failedTask]);
    expect(workflow.status).toBe('failed');

    const miniDag = await renderWorkflow(mock, [runningTask, failedTask], [workflow]);

    expect(screen.getByTestId('workflow-node-wf-diverge')).toHaveTextContent('failed');

    await waitFor(() => {
      expect(miniDag).toHaveTextContent('Still running task');
      expect(miniDag).toHaveTextContent('RUNNING · EXECUTING');
      expect(miniDag).toHaveTextContent('Already failed task');
      expect(miniDag).toHaveTextContent('FAILED');
    });
  });

  it('keeps the workflow label on older metadata until the workflow metadata channel catches up', async () => {
    const failedTask = makeUITask({
      id: 'wf-diverge/task-a',
      description: 'Task that restarts',
      status: 'failed',
      workflowId: 'wf-diverge',
      taskStateVersion: 1,
    });

    const failedWorkflow = workflowMetaFromTasks([failedTask]);
    const miniDag = await renderWorkflow(mock, [failedTask], [failedWorkflow]);

    expect(screen.getByTestId('workflow-node-wf-diverge')).toHaveTextContent('failed');
    await waitFor(() => {
      expect(miniDag).toHaveTextContent('FAILED');
    });

    // Task delta restarts the task — the task graph updates ahead of metadata.
    act(() =>
      mock.fireDelta({
        type: 'updated',
        taskId: 'wf-diverge/task-a',
        changes: { status: 'running', execution: { phase: 'executing' } },
        taskStateVersion: 2,
        previousTaskStateVersion: 1,
        streamSequence: 1,
      }),
    );

    await waitFor(() => {
      expect(miniDag).toHaveTextContent('RUNNING · EXECUTING');
    });

    // Label still reads the older failed metadata: separate renderer channels.
    expect(screen.getByTestId('workflow-node-wf-diverge')).toHaveTextContent('failed');

    const runningTask: TaskState = {
      ...failedTask,
      status: 'running',
      execution: { phase: 'executing' },
      taskStateVersion: 2,
    };
    const runningWorkflow = workflowMetaFromTasks([runningTask]);
    expect(runningWorkflow.status).toBe('running');

    act(() => mock.fireWorkflowsChanged([runningWorkflow]));

    await waitFor(() => {
      expect(screen.getByTestId('workflow-node-wf-diverge')).toHaveTextContent('running');
    });
  });
});
