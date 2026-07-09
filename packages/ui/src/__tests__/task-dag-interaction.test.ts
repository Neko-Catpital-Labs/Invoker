import { createElement } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskDAG } from '../components/TaskDAG.js';
import type { TaskState } from '../types.js';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

afterEach(() => {
  vi.useRealTimers();
});

function makeTask(id = 'task-1'): TaskState {
  return {
    id,
    description: 'Test task',
    status: 'running',
    dependencies: [],
    createdAt: new Date('2025-01-01T00:00:00Z'),
    config: {},
    execution: {},
    taskStateVersion: 1,
  };
}

function renderTaskDAG(props: Partial<Parameters<typeof TaskDAG>[0]> = {}) {
  const task = makeTask();
  const tasks = new Map([[task.id, task]]);

  render(createElement(TaskDAG, { tasks, ...props }));

  return {
    task,
    node: screen.getByTestId(`rf__node-${task.id}`),
  };
}

describe('TaskDAG interactions', () => {
  it('selects a task on single click', () => {
    const onTaskClick = vi.fn();
    const onTaskDoubleClick = vi.fn();
    const { task, node } = renderTaskDAG({ onTaskClick, onTaskDoubleClick });

    fireEvent.click(node, { detail: 1 });

    expect(onTaskClick).toHaveBeenCalledTimes(1);
    expect(onTaskClick).toHaveBeenCalledWith(task);
    expect(onTaskDoubleClick).not.toHaveBeenCalled();
  });

  it('dispatches one double-click callback for a user double-click event sequence', () => {
    const onTaskClick = vi.fn();
    const onTaskDoubleClick = vi.fn();
    const { task, node } = renderTaskDAG({ onTaskClick, onTaskDoubleClick });

    vi.useFakeTimers();
    fireEvent.click(node, { detail: 1 });
    fireEvent.click(node, { detail: 2 });
    fireEvent.doubleClick(node, { detail: 2 });
    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(onTaskClick).toHaveBeenCalledTimes(1);
    expect(onTaskDoubleClick).toHaveBeenCalledTimes(1);
    expect(onTaskDoubleClick).toHaveBeenCalledWith(task);
  });

  it('opens the task context menu without dispatching click handlers', () => {
    const onTaskClick = vi.fn();
    const onTaskDoubleClick = vi.fn();
    const onTaskContextMenu = vi.fn();
    const { task, node } = renderTaskDAG({
      onTaskClick,
      onTaskDoubleClick,
      onTaskContextMenu,
    });

    fireEvent.contextMenu(node);

    expect(onTaskContextMenu).toHaveBeenCalledTimes(1);
    expect(onTaskContextMenu.mock.calls[0][0]).toBe(task);
    expect(onTaskClick).not.toHaveBeenCalled();
    expect(onTaskDoubleClick).not.toHaveBeenCalled();
  });
});
