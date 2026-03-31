/**
 * Snapshot test: Visual proof states.
 *
 * Demoted from packages/app/e2e/visual-proof.spec.ts.
 * DOM snapshots catch structural regressions (missing elements, wrong text).
 * Pixel screenshots remain via scripts/ui-visual-proof.sh for PR reviews.
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

describe('Visual proof snapshots', () => {
  let mock: MockInvoker;

  beforeEach(() => {
    mock = createMockInvoker();
    mock.install();
  });

  afterEach(() => {
    mock.cleanup();
  });

  it('empty-state', () => {
    const { container } = render(<App />);
    expect(screen.getByText('Load a plan to get started')).toBeInTheDocument();
    expect(screen.getByText('Open File')).toBeInTheDocument();
    expect(screen.getByText('Refresh')).toBeInTheDocument();
    expect(screen.getByText('Clear')).toBeInTheDocument();
    expect(container).toMatchSnapshot();
  });

  it('dag-loaded', async () => {
    const alpha = makeUITask({ id: 'task-alpha', description: 'First test task', status: 'pending' });
    const beta = makeUITask({ id: 'task-beta', description: 'Second test task', status: 'pending', dependencies: ['task-alpha'] });

    const { container } = render(<App />);
    act(() => mock.setTasks([alpha, beta]));

    await waitFor(() => {
      expect(screen.getByTestId('rf__node-task-alpha')).toBeInTheDocument();
      expect(screen.getByTestId('rf__node-task-beta')).toBeInTheDocument();
    });

    expect(container).toMatchSnapshot();
  });

  it('task-running', async () => {
    const now = Date.now();
    const alpha = makeUITask({ id: 'task-alpha', description: 'First test task', status: 'running', execution: { startedAt: new Date(now - 3000) } } as any);
    const beta = makeUITask({ id: 'task-beta', description: 'Second test task', status: 'pending', dependencies: ['task-alpha'] });

    const { container } = render(<App />);
    act(() => mock.setTasks([alpha, beta]));

    await waitFor(() => {
      expect(screen.getByTestId('rf__node-task-alpha')).toBeInTheDocument();
    });

    expect(container).toMatchSnapshot();
  });

  it('task-complete', async () => {
    const now = Date.now();
    const alpha = makeUITask({
      id: 'task-alpha', description: 'First test task', status: 'completed',
      execution: { startedAt: new Date(now - 10000), completedAt: new Date(now - 5000) },
    } as any);
    const beta = makeUITask({
      id: 'task-beta', description: 'Second test task', status: 'completed',
      dependencies: ['task-alpha'],
      execution: { startedAt: new Date(now - 5000), completedAt: new Date(now) },
    } as any);

    const { container } = render(<App />);
    act(() => mock.setTasks([alpha, beta]));

    await waitFor(() => {
      expect(screen.getByTestId('rf__node-task-alpha')).toBeInTheDocument();
    });

    expect(container).toMatchSnapshot();
  });

  it('task-panel', async () => {
    const alpha = makeUITask({ id: 'task-alpha', description: 'First test task', status: 'pending', command: 'echo hello-alpha' });
    const beta = makeUITask({ id: 'task-beta', description: 'Second test task', status: 'pending', dependencies: ['task-alpha'] });

    const { container } = render(<App />);
    act(() => mock.setTasks([alpha, beta]));

    await waitFor(() => {
      expect(screen.getByTestId('rf__node-task-alpha')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('rf__node-task-alpha'));

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'First test task' })).toBeInTheDocument();
    });

    expect(container).toMatchSnapshot();
  });

  it('task-panel-agent-selector', async () => {
    const alpha = makeUITask({
      id: 'task-alpha',
      description: 'Agent selector task',
      status: 'pending',
      prompt: 'Write tests for the agent selector',
      config: { prompt: 'Write tests for the agent selector', executionAgent: 'claude' } as any,
    });

    const { container } = render(<App />);
    act(() => mock.setTasks([alpha]));

    await waitFor(() => {
      expect(screen.getByTestId('rf__node-task-alpha')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('rf__node-task-alpha'));

    await waitFor(() => {
      expect(screen.getByTestId('execution-agent-select')).toBeInTheDocument();
    });

    expect(container).toMatchSnapshot();
  });
});
