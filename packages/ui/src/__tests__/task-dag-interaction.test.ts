import { createElement } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeUITask } from './helpers/mock-invoker.js';
import type { TaskState } from '../types.js';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

const { TaskDAG } = await import('../components/TaskDAG.js');

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function taskMap(task: TaskState): Map<string, TaskState> {
  return new Map([[task.id, task]]);
}

describe('TaskDAG interactions', () => {
  it('dispatches exactly one task double-click callback for a user double-click', async () => {
    const task = makeUITask({
      id: 'task-1',
      description: 'Test task',
      status: 'running',
      workflowId: 'wf-a',
    });
    const onTaskClick = vi.fn();
    const onTaskDoubleClick = vi.fn();

    render(createElement(TaskDAG, {
      tasks: taskMap(task),
      onTaskClick,
      onTaskDoubleClick,
    }));

    const node = await screen.findByTestId('rf__node-task-1');
    fireEvent.click(node);
    fireEvent.click(node);
    fireEvent.doubleClick(node);

    expect(onTaskClick).toHaveBeenCalledTimes(2);
    expect(onTaskDoubleClick).toHaveBeenCalledTimes(1);
    expect(onTaskDoubleClick).toHaveBeenCalledWith(task);
  });

  it('keeps single-click selection separate from double-click handling', async () => {
    const task = makeUITask({
      id: 'task-1',
      description: 'Test task',
      workflowId: 'wf-a',
    });
    const onTaskClick = vi.fn();
    const onTaskDoubleClick = vi.fn();

    render(createElement(TaskDAG, {
      tasks: taskMap(task),
      onTaskClick,
      onTaskDoubleClick,
    }));

    fireEvent.click(await screen.findByTestId('rf__node-task-1'));

    expect(onTaskClick).toHaveBeenCalledTimes(1);
    expect(onTaskClick).toHaveBeenCalledWith(task);
    expect(onTaskDoubleClick).not.toHaveBeenCalled();
  });

  it('preserves task context menu dispatch', async () => {
    const task = makeUITask({
      id: 'task-1',
      description: 'Test task',
      workflowId: 'wf-a',
    });
    const onTaskContextMenu = vi.fn();

    render(createElement(TaskDAG, {
      tasks: taskMap(task),
      onTaskContextMenu,
    }));

    fireEvent.contextMenu(await screen.findByTestId('rf__node-task-1'));

    expect(onTaskContextMenu).toHaveBeenCalledTimes(1);
    expect(onTaskContextMenu.mock.calls[0]?.[0]).toBe(task);
  });
});
