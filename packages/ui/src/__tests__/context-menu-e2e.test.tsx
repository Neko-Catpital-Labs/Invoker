/**
 * Component test: Context menu on task nodes.
 *
 * Demoted from packages/app/e2e/context-menu.spec.ts.
 * Tests right-click, Escape close, click-outside close, and menu items.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, act, waitFor, fireEvent } from '@testing-library/react';
import { vi } from 'vitest';
import { createMockInvoker, makeUITask, type MockInvoker } from './helpers/mock-invoker.js';
import type { WorkflowMeta } from '../../types.js';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

const { App } = await import('../App.js');

const alpha = makeUITask({
  id: 'task-alpha',
  description: 'First test task',
  status: 'pending',
  command: 'echo hello-alpha',
  workflowId: 'wf-1',
});

const beta = makeUITask({
  id: 'task-beta',
  description: 'Second test task',
  status: 'pending',
  dependencies: ['task-alpha'],
  command: 'echo hello-beta',
  workflowId: 'wf-1',
});

const workflows: WorkflowMeta[] = [
  { id: 'wf-1', name: 'Test Workflow', status: 'running', baseBranch: 'master' },
];

describe('Context menu (component)', () => {
  let mock: MockInvoker;

  beforeEach(() => {
    mock = createMockInvoker();
    mock.install();
  });

  afterEach(() => {
    mock.cleanup();
  });

  async function setupAndRightClick(taskTestId = 'rf__node-task-alpha') {
    render(<App />);
    act(() => mock.setTasks([alpha, beta], workflows));

    await waitFor(() => {
      expect(screen.getByTestId(taskTestId)).toBeInTheDocument();
    });

    fireEvent.contextMenu(screen.getByTestId(taskTestId));
  }

  it('right-clicking a task node shows context menu', async () => {
    await setupAndRightClick();

    await waitFor(() => {
      expect(screen.getByText('Restart Task')).toBeInTheDocument();
      expect(screen.getByText('Open Terminal')).toBeInTheDocument();
    });
  });

  it('Escape closes the context menu', async () => {
    await setupAndRightClick();

    await waitFor(() => {
      expect(screen.getByText('Restart Task')).toBeInTheDocument();
    });

    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => {
      expect(screen.queryByText('Restart Task')).not.toBeInTheDocument();
    });
  });

  it('clicking outside closes the context menu', async () => {
    await setupAndRightClick();

    await waitFor(() => {
      expect(screen.getByText('Restart Task')).toBeInTheDocument();
    });

    fireEvent.mouseDown(document.body);

    await waitFor(() => {
      expect(screen.queryByText('Restart Task')).not.toBeInTheDocument();
    });
  });

  it('Restart Task is enabled for pending tasks', async () => {
    await setupAndRightClick();

    await waitFor(() => {
      const btn = screen.getByText('Restart Task');
      expect(btn).toBeInTheDocument();
      expect(btn.closest('button')).not.toBeDisabled();
    });
  });

  it('clicking Restart Task closes the context menu', async () => {
    await setupAndRightClick();

    await waitFor(() => {
      expect(screen.getByText('Restart Task')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Restart Task'));

    await waitFor(() => {
      expect(screen.queryByText('Restart Task')).not.toBeInTheDocument();
    });
  });

  it('Open Terminal option is present', async () => {
    await setupAndRightClick();

    await waitFor(() => {
      const btn = screen.getByText('Open Terminal');
      expect(btn).toBeInTheDocument();
      expect(btn.closest('button')).not.toBeDisabled();
    });
  });

  it('Rebase & Retry is visible for tasks with workflowId', async () => {
    await setupAndRightClick();

    await waitFor(() => {
      expect(screen.getByText('Rebase & Retry')).toBeInTheDocument();
    });
  });

  it('shows and triggers Recreate from Task', async () => {
    await setupAndRightClick();

    await waitFor(() => {
      expect(screen.getByText('Recreate from Task')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Recreate from Task'));

    await waitFor(() => {
      expect(mock.api.recreateTask).toHaveBeenCalledWith('task-alpha');
      expect(screen.queryByText('Restart Task')).not.toBeInTheDocument();
    });
  });
});
