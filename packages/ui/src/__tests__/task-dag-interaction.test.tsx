import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskDAG } from '../components/TaskDAG.js';
import { makeUITask } from './helpers/mock-invoker.js';
import type { TaskState, WorkflowMeta } from '../types.js';

vi.mock('@xyflow/react', async () => {
  // Vitest hoists mock factories before static helper imports initialize, so
  // the mock module must be pulled in dynamically here.
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const workflows = new Map<string, WorkflowMeta>([
  ['wf-1', { id: 'wf-1', name: 'wf-1', status: 'running' }],
]);

async function renderNode(task: TaskState, handlers: {
  onTaskClick?: (task: TaskState) => void;
  onTaskDoubleClick?: (task: TaskState) => void;
  onTaskContextMenu?: (task: TaskState, event: React.MouseEvent) => void;
}) {
  render(
    <TaskDAG tasks={new Map([[task.id, task]])} workflows={workflows} {...handlers} />,
  );
  return waitFor(() => screen.getByTestId(`rf__node-${task.id}`));
}

describe('TaskDAG node interactions', () => {
  it('single click selects the task and never opens the terminal', async () => {
    const onTaskClick = vi.fn();
    const onTaskDoubleClick = vi.fn();
    const task = makeUITask({ id: 'wf-1/task', workflowId: 'wf-1' });
    const node = await renderNode(task, { onTaskClick, onTaskDoubleClick });

    fireEvent.click(node);

    expect(onTaskClick).toHaveBeenCalledTimes(1);
    expect(onTaskClick).toHaveBeenCalledWith(task);
    expect(onTaskDoubleClick).not.toHaveBeenCalled();
  });

  // Regression for PR #680: a double-click opened the terminal twice because
  // three mechanisms fired for one gesture (native onNodeDoubleClick, a
  // hand-rolled click-timing detector in onNodeClick, and TaskNode's own
  // onDoubleClick). One gesture must open it exactly once.
  it('opens the terminal exactly once per double-click on a task node', async () => {
    const onTaskDoubleClick = vi.fn();
    const task = makeUITask({ id: 'wf-1/task', workflowId: 'wf-1' });
    const node = await renderNode(task, { onTaskDoubleClick });

    // A physical double-click dispatches click, click, then dblclick.
    fireEvent.click(node);
    fireEvent.click(node);
    fireEvent.doubleClick(node);

    expect(onTaskDoubleClick).toHaveBeenCalledTimes(1);
    expect(onTaskDoubleClick).toHaveBeenCalledWith(task);
  });

  it('opens the terminal exactly once per double-click on a merge-gate node', async () => {
    const onTaskDoubleClick = vi.fn();
    const task = makeUITask({
      id: 'wf-1/merge',
      workflowId: 'wf-1',
      isMergeNode: true,
    });
    const node = await renderNode(task, { onTaskDoubleClick });

    fireEvent.click(node);
    fireEvent.click(node);
    fireEvent.doubleClick(node);

    expect(onTaskDoubleClick).toHaveBeenCalledTimes(1);
    expect(onTaskDoubleClick).toHaveBeenCalledWith(task);
  });

  // The e2e flow (packages/app/e2e/visual-proof.spec.ts) dispatches dblclick on
  // the inner task card. With TaskNode's own handler removed, the event must
  // still reach the native handler by bubbling and open the terminal once.
  it('opens the terminal when the inner task card is double-clicked', async () => {
    const onTaskDoubleClick = vi.fn();
    const task = makeUITask({ id: 'wf-1/task', workflowId: 'wf-1' });
    const node = await renderNode(task, { onTaskDoubleClick });
    const card = node.querySelector('[title]') ?? node;

    fireEvent.doubleClick(card);

    expect(onTaskDoubleClick).toHaveBeenCalledTimes(1);
    expect(onTaskDoubleClick).toHaveBeenCalledWith(task);
  });

  it('opens the context menu without firing click or double-click handlers', async () => {
    const onTaskClick = vi.fn();
    const onTaskDoubleClick = vi.fn();
    const onTaskContextMenu = vi.fn();
    const task = makeUITask({ id: 'wf-1/task', workflowId: 'wf-1' });
    const node = await renderNode(task, {
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
