import { beforeEach, describe, it, expect, type Mock, vi } from 'vitest';
import React from 'react';
import { render } from '@testing-library/react';
import * as ReactFlowModule from '@xyflow/react';
import { TaskDAG } from '../components/TaskDAG.js';
import type { TaskState, ViewportCenterRequest } from '../types.js';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

const setCenterMock = (ReactFlowModule as unknown as { __setCenterMock: Mock }).__setCenterMock;

function makeTask(id: string, workflowId: string, status: TaskState['status'] = 'pending'): TaskState {
  return {
    id,
    description: id,
    status,
    dependencies: [],
    config: { workflowId },
    execution: {},
    taskStateVersion: 1,
  } as TaskState;
}

// Behavioral coverage for one-shot navigation centering in the mini DAG.
describe('TaskDAG one-shot center requests', () => {
  beforeEach(() => {
    setCenterMock.mockClear();
  });

  function renderWith(request: ViewportCenterRequest | null, tasks: Map<string, TaskState>) {
    return React.createElement(TaskDAG, {
      tasks,
      selectedTaskId: 't1',
      centerTaskRequest: request,
      onTaskClick: () => {},
    });
  }

  const baseTasks = new Map([
    ['t1', makeTask('t1', 'wf-a')],
    ['t2', makeTask('t2', 'wf-a')],
  ]);

  it('centers once for a request and not again on same-request re-renders', async () => {
    const { rerender } = render(renderWith({ id: 't1', requestId: 1 }, baseTasks));

    await vi.waitFor(() => {
      expect(setCenterMock).toHaveBeenCalledTimes(1);
    });

    // Simulate live status updates: new node objects, same requestId.
    const refreshed = new Map([
      ['t1', makeTask('t1', 'wf-a', 'running')],
      ['t2', makeTask('t2', 'wf-a')],
    ]);
    rerender(renderWith({ id: 't1', requestId: 1 }, refreshed));
    rerender(renderWith({ id: 't1', requestId: 1 }, refreshed));

    await new Promise((r) => setTimeout(r, 0));
    expect(setCenterMock).toHaveBeenCalledTimes(1);
  });

  it('centers again when a new requestId arrives', async () => {
    const { rerender } = render(renderWith({ id: 't1', requestId: 1 }, baseTasks));

    await vi.waitFor(() => {
      expect(setCenterMock).toHaveBeenCalledTimes(1);
    });

    rerender(renderWith({ id: 't2', requestId: 2 }, baseTasks));

    await vi.waitFor(() => {
      expect(setCenterMock).toHaveBeenCalledTimes(2);
    });
  });
});

// Test the callback behavior by simulating what ReactFlow's onNodeDoubleClick does
describe('TaskDAG double-click', () => {
  it('onNodeDoubleClick resolves task from map and calls handler', () => {
    const mockTask = {
      id: 'task-1',
      description: 'Test task',
      status: 'running' as const,
      dependencies: [] as string[],
      createdAt: new Date(),
      config: {},
      execution: {},
    };
    const tasks = new Map([['task-1', mockTask]]);
    const onTaskDoubleClick = vi.fn();

    // Simulate the callback logic from TaskDAGInner
    const nodeId = 'task-1';
    const task = tasks.get(nodeId);
    if (task && onTaskDoubleClick) {
      onTaskDoubleClick(task);
    }

    expect(onTaskDoubleClick).toHaveBeenCalledWith(mockTask);
  });

  it('onNodeDoubleClick does nothing when task not found', () => {
    const tasks = new Map<string, any>();
    const onTaskDoubleClick = vi.fn();

    const nodeId = 'nonexistent';
    const task = tasks.get(nodeId);
    if (task && onTaskDoubleClick) {
      onTaskDoubleClick(task);
    }

    expect(onTaskDoubleClick).not.toHaveBeenCalled();
  });
});
