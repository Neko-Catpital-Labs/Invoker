import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TaskDAG } from '../components/TaskDAG.js';
import { makeUITask } from './helpers/mock-invoker.js';
import type { TaskState, WorkflowMeta } from '../types.js';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

const workflows = new Map<string, WorkflowMeta>([
  ['wf-1', { id: 'wf-1', name: 'wf-1', status: 'running' }],
]);

function renderGraph() {
  const skipped = makeUITask({
    id: 'wf-1/skipped-task',
    workflowId: 'wf-1',
    status: 'skipped',
    description: 'skipped task',
  });
  const stale = makeUITask({
    id: 'wf-1/stale-task',
    workflowId: 'wf-1',
    status: 'stale',
    description: 'stale task',
  });
  const completed = makeUITask({
    id: 'wf-1/completed-task',
    workflowId: 'wf-1',
    status: 'completed',
    description: 'completed task',
  });
  const tasks = new Map<string, TaskState>([
    [skipped.id, skipped],
    [stale.id, stale],
    [completed.id, completed],
  ]);

  const onTaskClick = vi.fn();
  const onTaskDoubleClick = vi.fn();
  const onTaskContextMenu = vi.fn();

  render(
    <TaskDAG
      tasks={tasks}
      workflows={workflows}
      onTaskClick={onTaskClick}
      onTaskDoubleClick={onTaskDoubleClick}
      onTaskContextMenu={onTaskContextMenu}
    />,
  );

  return { skipped, stale, completed, onTaskClick, onTaskDoubleClick, onTaskContextMenu };
}

describe('skipped and stale task nodes are not actionable', () => {
  it('ignores React Flow node events raised on the wrapper element', async () => {
    const { skipped, stale, completed, onTaskClick, onTaskDoubleClick, onTaskContextMenu } = renderGraph();

    await waitFor(() => {
      expect(screen.getByTestId(`rf__node-${skipped.id}`)).toBeInTheDocument();
    });

    for (const id of [skipped.id, stale.id]) {
      const wrapper = screen.getByTestId(`rf__node-${id}`);
      fireEvent.click(wrapper);
      fireEvent.doubleClick(wrapper);
      fireEvent.contextMenu(wrapper);
    }

    expect(onTaskClick).not.toHaveBeenCalled();
    expect(onTaskDoubleClick).not.toHaveBeenCalled();
    expect(onTaskContextMenu).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId(`rf__node-${completed.id}`));
    expect(onTaskClick).toHaveBeenCalledTimes(1);
    expect(onTaskClick.mock.calls[0][0].id).toBe(completed.id);
  });

  it('marks non-actionable nodes unselectable so React Flow skips selection and focus', async () => {
    const { skipped, stale, completed } = renderGraph();

    await waitFor(() => {
      expect(screen.getByTestId(`rf__node-${skipped.id}`)).toBeInTheDocument();
    });

    for (const id of [skipped.id, stale.id]) {
      const wrapper = screen.getByTestId(`rf__node-${id}`);
      expect(wrapper.classList.contains('selectable')).toBe(false);
      expect(wrapper.getAttribute('tabindex')).toBeNull();
    }

    const completedWrapper = screen.getByTestId(`rf__node-${completed.id}`);
    expect(completedWrapper.classList.contains('selectable')).toBe(true);
    expect(completedWrapper.getAttribute('tabindex')).toBe('0');
  });
});
