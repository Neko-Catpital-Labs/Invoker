import { createElement } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskDAG } from '../components/TaskDAG.js';
import { makeUITask } from './helpers/mock-invoker.js';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

type TaskDAGProps = Parameters<typeof TaskDAG>[0];

afterEach(() => {
  cleanup();
});

function renderOneTaskDag(props: Partial<Omit<TaskDAGProps, 'tasks'>> = {}) {
  const task = makeUITask({
    id: 'task-1',
    description: 'Test task',
    status: 'running',
  });
  const tasks = new Map([[task.id, task]]);

  render(createElement(TaskDAG, { tasks, ...props }));

  return { task };
}

async function findRenderedTaskCard(taskId: string): Promise<HTMLElement> {
  const node = await screen.findByTestId(`rf__node-${taskId}`);
  return node.firstElementChild instanceof HTMLElement ? node.firstElementChild : node;
}

function dispatchUserDoubleClick(target: HTMLElement) {
  fireEvent.click(target);
  fireEvent.click(target);
  fireEvent.doubleClick(target);
}

describe('TaskDAG interactions', () => {
  it('dispatches exactly one double-click callback per user double-click', async () => {
    const onTaskClick = vi.fn();
    const onTaskDoubleClick = vi.fn();
    const { task } = renderOneTaskDag({ onTaskClick, onTaskDoubleClick });
    const taskCard = await findRenderedTaskCard(task.id);

    dispatchUserDoubleClick(taskCard);

    expect(onTaskDoubleClick).toHaveBeenCalledTimes(1);
    expect(onTaskDoubleClick).toHaveBeenCalledWith(task);
    expect(onTaskClick).toHaveBeenCalledTimes(2);
    expect(onTaskClick).toHaveBeenNthCalledWith(1, task);
    expect(onTaskClick).toHaveBeenNthCalledWith(2, task);
  });

  it('preserves single-click selection without double-click dispatch', async () => {
    const onTaskClick = vi.fn();
    const onTaskDoubleClick = vi.fn();
    const { task } = renderOneTaskDag({ onTaskClick, onTaskDoubleClick });
    const taskCard = await findRenderedTaskCard(task.id);

    fireEvent.click(taskCard);

    expect(onTaskClick).toHaveBeenCalledTimes(1);
    expect(onTaskClick).toHaveBeenCalledWith(task);
    expect(onTaskDoubleClick).not.toHaveBeenCalled();
  });

  it('preserves task context menu dispatch and default prevention', async () => {
    const onTaskContextMenu = vi.fn();
    const { task } = renderOneTaskDag({ onTaskContextMenu });
    const taskCard = await findRenderedTaskCard(task.id);
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });

    const wasNotPrevented = fireEvent(taskCard, event);

    expect(wasNotPrevented).toBe(false);
    expect(event.defaultPrevented).toBe(true);
    expect(onTaskContextMenu).toHaveBeenCalledTimes(1);
    expect(onTaskContextMenu.mock.calls[0][0]).toBe(task);
  });
});
