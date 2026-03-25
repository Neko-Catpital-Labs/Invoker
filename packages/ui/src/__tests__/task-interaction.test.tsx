/**
 * Component test: Task interaction — clicking nodes, TaskPanel details.
 *
 * Demoted from packages/app/e2e/task-interaction.spec.ts.
 * Dropped: terminal-related assertions (Electron shell feature).
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
  description: 'Second test task depending on alpha',
  status: 'pending',
  dependencies: ['task-alpha'],
  command: 'echo hello-beta',
});

describe('Task interaction (component)', () => {
  let mock: MockInvoker;

  beforeEach(() => {
    mock = createMockInvoker();
    mock.install();
  });

  afterEach(() => {
    mock.cleanup();
  });

  it('clicking a task node shows its details in the TaskPanel', async () => {
    render(<App />);
    act(() => mock.setTasks([alpha, beta]));

    await waitFor(() => {
      expect(screen.getByTestId('rf__node-task-alpha')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('rf__node-task-alpha'));

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'First test task' })).toBeInTheDocument();
    });
  });

  it('TaskPanel shows command type for command tasks', async () => {
    render(<App />);
    act(() => mock.setTasks([alpha, beta]));

    await waitFor(() => {
      expect(screen.getByTestId('rf__node-task-alpha')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('rf__node-task-alpha'));

    await waitFor(() => {
      expect(screen.getByText('Command')).toBeInTheDocument();
      expect(screen.getByText('echo hello-alpha')).toBeInTheDocument();
    });
  });

  it('TaskPanel shows dependencies for dependent tasks', async () => {
    render(<App />);
    act(() => mock.setTasks([alpha, beta]));

    await waitFor(() => {
      expect(screen.getByTestId('rf__node-task-beta')).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('rf__node-task-beta'));
    });

    await waitFor(() => {
      expect(screen.getByText('Dependencies')).toBeInTheDocument();
      // Beta depends on alpha — check the dependency tag in the panel
      const depsSection = screen.getByText('Dependencies').parentElement!;
      expect(depsSection).toHaveTextContent('task-alpha');
    });
  });
});
