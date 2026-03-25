/**
 * Component test: Timeline view rendering and interaction.
 *
 * Demoted from packages/app/e2e/timeline-view.spec.ts.
 * Tests switching to timeline view, bar rendering, elapsed time, and task selection.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, act, waitFor, fireEvent } from '@testing-library/react';
import { vi } from 'vitest';
import { createMockInvoker, makeUITask, type MockInvoker } from './helpers/mock-invoker.js';

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
});

const beta = makeUITask({
  id: 'task-beta',
  description: 'Second test task',
  status: 'pending',
  dependencies: ['task-alpha'],
  command: 'echo hello-beta',
});

describe('Timeline view (component)', () => {
  let mock: MockInvoker;

  beforeEach(() => {
    mock = createMockInvoker();
    mock.install();
  });

  afterEach(() => {
    mock.cleanup();
  });

  it('clicking Timeline button shows the timeline view', async () => {
    render(<App />);
    act(() => mock.setTasks([alpha, beta]));

    await waitFor(() => {
      expect(screen.getByTestId('rf__node-task-alpha')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Timeline' }));

    await waitFor(() => {
      expect(screen.getByTestId('timeline-view')).toBeInTheDocument();
    });
  });

  it('timeline shows task bars after loading tasks', async () => {
    render(<App />);
    act(() => mock.setTasks([alpha, beta]));

    await waitFor(() => {
      expect(screen.getByTestId('rf__node-task-alpha')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Timeline' }));

    await waitFor(() => {
      expect(screen.getByTestId('timeline-bar-task-alpha')).toBeInTheDocument();
      expect(screen.getByTestId('timeline-bar-task-beta')).toBeInTheDocument();
    });
  });

  it('completed task shows elapsed time', async () => {
    const now = Date.now();
    const completedAlpha = makeUITask({
      id: 'task-alpha',
      description: 'First test task',
      status: 'completed',
      command: 'echo hello-alpha',
      execution: {
        startedAt: new Date(now - 5000),
        completedAt: new Date(now),
      },
    } as any);

    render(<App />);
    act(() => mock.setTasks([completedAlpha, beta]));

    await waitFor(() => {
      expect(screen.getByTestId('rf__node-task-alpha')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Timeline' }));

    await waitFor(() => {
      const bar = screen.getByTestId('timeline-bar-task-alpha');
      expect(bar).toHaveTextContent(/\d+s/);
    });
  });

  it('clicking a task bar selects it in the TaskPanel', async () => {
    render(<App />);
    act(() => mock.setTasks([alpha, beta]));

    await waitFor(() => {
      expect(screen.getByTestId('rf__node-task-alpha')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Timeline' }));

    await waitFor(() => {
      expect(screen.getByTestId('timeline-bar-task-alpha')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('timeline-bar-task-alpha'));

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'First test task' })).toBeInTheDocument();
    });
  });

  it('switching back to DAG view works', async () => {
    render(<App />);
    act(() => mock.setTasks([alpha, beta]));

    await waitFor(() => {
      expect(screen.getByTestId('rf__node-task-alpha')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Timeline' }));

    await waitFor(() => {
      expect(screen.getByTestId('timeline-view')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'DAG' }));

    await waitFor(() => {
      expect(screen.queryByTestId('timeline-view')).not.toBeInTheDocument();
      expect(screen.getByTestId('rf__node-task-alpha')).toBeInTheDocument();
    });
  });
});
