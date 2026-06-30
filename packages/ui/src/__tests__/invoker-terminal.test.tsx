import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { createMockInvoker, type MockInvoker } from './helpers/mock-invoker.js';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

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

  it('plans from a quoted goal and then runs the loaded plan', async () => {
    render(<App />);

    const input = screen.getByLabelText('Invoker terminal input');
    fireEvent.change(input, { target: { value: 'plan "Add README"' } });
    fireEvent.submit(input.closest('form')!);

    await waitFor(() => {
      expect(mock.api.planFromGoal).toHaveBeenCalledWith({ goal: 'Add README' });
      expect(screen.getByText('Plan "Mock Plan" loaded. Use run to execute.')).toBeInTheDocument();
    });

    fireEvent.change(input, { target: { value: 'run' } });
    fireEvent.submit(input.closest('form')!);

    await waitFor(() => {
      expect(mock.api.start).toHaveBeenCalled();
      expect(screen.getByText('Run started.')).toBeInTheDocument();
    });
  });
});
