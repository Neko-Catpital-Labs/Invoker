import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
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
  vi.useRealTimers();
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

describe('TaskDAG interactions', () => {
  it('selects a task on single click', async () => {
    const onTaskClick = vi.fn();
    const onTaskDoubleClick = vi.fn();
    const { task } = renderOneTaskDag({ onTaskClick, onTaskDoubleClick });
    const taskCard = await findRenderedTaskCard(task.id);

    fireEvent.click(taskCard, { detail: 1 });

    expect(onTaskClick).toHaveBeenCalledTimes(1);
    expect(onTaskClick).toHaveBeenCalledWith(task);
    expect(onTaskDoubleClick).not.toHaveBeenCalled();
  });

  it('dispatches one double-click callback for a user double-click event sequence', async () => {
    const onTaskClick = vi.fn();
    const onTaskDoubleClick = vi.fn();
    const { task } = renderOneTaskDag({ onTaskClick, onTaskDoubleClick });
    const taskCard = await findRenderedTaskCard(task.id);

    vi.useFakeTimers();
    fireEvent.click(taskCard, { detail: 1 });
    fireEvent.click(taskCard, { detail: 2 });
    fireEvent.doubleClick(taskCard, { detail: 2 });
    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(onTaskClick).toHaveBeenCalledTimes(1);
    expect(onTaskDoubleClick).toHaveBeenCalledTimes(1);
    expect(onTaskDoubleClick).toHaveBeenCalledWith(task);
  });

  it('preserves task context menu dispatch and default prevention', async () => {
    const onTaskContextMenu = vi.fn();
    const onTaskClick = vi.fn();
    const onTaskDoubleClick = vi.fn();
    const { task } = renderOneTaskDag({ onTaskContextMenu, onTaskClick, onTaskDoubleClick });
    const taskCard = await findRenderedTaskCard(task.id);
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });

    const wasNotPrevented = fireEvent(taskCard, event);

    expect(wasNotPrevented).toBe(false);
    expect(event.defaultPrevented).toBe(true);
    expect(onTaskContextMenu).toHaveBeenCalledTimes(1);
    expect(onTaskContextMenu.mock.calls[0][0]).toBe(task);
    expect(onTaskClick).not.toHaveBeenCalled();
    expect(onTaskDoubleClick).not.toHaveBeenCalled();
  });
});
