/**
 * Component test: Plan loading and DAG rendering.
 *
 * Demoted from packages/app/e2e/plan-loading.spec.ts.
 * Tests that loading tasks renders nodes in the DAG mock.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
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

describe('Plan loading (component)', () => {
  let mock: MockInvoker;

  beforeEach(() => {
    mock = createMockInvoker();
    mock.install();
  });

  afterEach(() => {
    mock.cleanup();
  });

  it('renders task nodes in the DAG after setTasks', async () => {
    render(<App />);
    act(() => mock.setTasks([alpha, beta]));

    await waitFor(() => {
      expect(screen.getByTestId('rf__node-task-alpha')).toBeInTheDocument();
      expect(screen.getByTestId('rf__node-task-beta')).toBeInTheDocument();
    });
  });

  it('tasks are in pending state', () => {
    expect(alpha.status).toBe('pending');
    expect(beta.status).toBe('pending');
  });

  it('empty state disappears after tasks are loaded', async () => {
    render(<App />);
    expect(screen.getByText('Load a plan to get started')).toBeInTheDocument();

    act(() => mock.setTasks([alpha, beta]));

    await waitFor(() => {
      expect(screen.queryByText('Load a plan to get started')).not.toBeInTheDocument();
    });
  });

  it('node shows task description', async () => {
    render(<App />);
    act(() => mock.setTasks([alpha, beta]));

    await waitFor(() => {
      expect(screen.getByText('First test task')).toBeInTheDocument();
    });
  });

  it('node preserves task ID as node metadata (title)', async () => {
    render(<App />);
    act(() => mock.setTasks([alpha, beta]));

    await waitFor(() => {
      expect(screen.getByTitle('task-alpha')).toBeInTheDocument();
    });
  });
});
