import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi } from 'vitest';
import { createMockInvoker, type MockInvoker } from './helpers/mock-invoker.js';

vi.mock('@xyflow/react', async () => {
  // Dynamic import is required because Vitest hoists mock factories before test imports.
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

// Dynamic import is required so App sees the hoisted @xyflow/react mock.
const { App } = await import('../App.js');

describe('Invoker terminal (component)', () => {
  let mock: MockInvoker;

  beforeEach(() => {
    mock = createMockInvoker();
    mock.install();
  });

  afterEach(() => {
    mock.cleanup();
  });

  it('generates a plan from a quoted goal command', async () => {
    render(<App />);

    fireEvent.change(screen.getByTestId('invoker-terminal-input'), { target: { value: 'plan "Add README"' } });
    fireEvent.submit(screen.getByTestId('invoker-terminal-input').closest('form')!);

    await waitFor(() => {
      expect(mock.api.planFromGoal).toHaveBeenCalledWith({ goal: 'Add README' });
      expect(screen.getByText('Plan "Mock Plan" loaded. Use run to execute.')).toBeInTheDocument();
    });
  });

  it('refreshes the graph after terminal planning succeeds', async () => {
    mock.api.planFromGoal = vi.fn(async () => {
      mock.setTasks([
        {
          id: 'task-alpha',
          description: 'Alpha task',
          status: 'pending',
          config: {
            baseBranch: 'main',
            prompt: 'Do alpha',
            agent: 'codex',
            dependencies: [],
            canRunInParallel: true,
            requiresReview: true,
            autoRetry: false,
            sandboxMode: 'workspace-write',
            model: 'gpt-5',
            workflowId: 'wf-graph',
          },
        } as any,
      ], [
        { id: 'wf-graph', name: 'Mock Plan', status: 'pending' } as any,
      ]);
      return { ok: true as const, planName: 'Mock Plan', workflowId: 'wf-graph' };
    }) as any;

    render(<App />);

    fireEvent.change(screen.getByTestId('invoker-terminal-input'), { target: { value: 'plan "Add README"' } });
    fireEvent.submit(screen.getByTestId('invoker-terminal-input').closest('form')!);

    await waitFor(() => {
      expect(mock.api.planFromGoal).toHaveBeenCalledWith({ goal: 'Add README' });
      expect(mock.api.refreshTaskGraph).toHaveBeenCalled();
      expect(screen.getByTestId('workflow-node-wf-graph')).toBeInTheDocument();
    });

    expect(screen.queryByText('What to expect')).not.toBeInTheDocument();
    expect(screen.getByTestId('workflow-inspector-title')).toHaveTextContent('Mock Plan');
  });

  it('explains that run needs a loaded plan first', async () => {
    render(<App />);

    fireEvent.change(screen.getByTestId('invoker-terminal-input'), { target: { value: 'run' } });
    fireEvent.submit(screen.getByTestId('invoker-terminal-input').closest('form')!);

    expect(await screen.findByText('Create a plan before running.')).toBeInTheDocument();
    expect(mock.api.start).not.toHaveBeenCalled();
  });

  it('starts execution after a generated plan is loaded', async () => {
    render(<App />);

    fireEvent.change(screen.getByTestId('invoker-terminal-input'), { target: { value: 'plan "Add README"' } });
    fireEvent.submit(screen.getByTestId('invoker-terminal-input').closest('form')!);
    await screen.findByText('Plan "Mock Plan" loaded. Use run to execute.');

    fireEvent.change(screen.getByTestId('invoker-terminal-input'), { target: { value: 'run' } });
    fireEvent.submit(screen.getByTestId('invoker-terminal-input').closest('form')!);

    await waitFor(() => {
      expect(mock.api.start).toHaveBeenCalled();
      expect(screen.getByText('Run started.')).toBeInTheDocument();
    });
  });
});
