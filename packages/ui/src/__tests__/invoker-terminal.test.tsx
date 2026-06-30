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

  it('explains that run needs a loaded plan first', async () => {
    render(<App />);

    fireEvent.change(screen.getByTestId('invoker-terminal-input'), { target: { value: 'run' } });
    fireEvent.submit(screen.getByTestId('invoker-terminal-input').closest('form')!);

    expect(await screen.findByText('Load or generate a plan before running.')).toBeInTheDocument();
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
