import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  InvokerTerminalHarness,
  createTerminalHarnessController,
} from './helpers/invoker-terminal-harness.js';

describe('InvokerTerminal agent selector', () => {
  it('renders the agent selector directly in the composer without an options toggle', () => {
    render(<InvokerTerminalHarness />);

    const selector = screen.getByLabelText('Agent');
    expect(selector).toBe(screen.getByTestId('invoker-terminal-harness'));
    expect(selector).toHaveValue('codex');
    expect(screen.queryByRole('button', { name: 'Options' })).not.toBeInTheDocument();
  });

  it('uses the selected agent preset when submitting from the visible composer controls', async () => {
    const controller = createTerminalHarnessController();
    render(<InvokerTerminalHarness controller={controller} />);

    fireEvent.change(screen.getByLabelText('Agent'), { target: { value: 'claude' } });
    expect(controller.onPresetChange).toHaveBeenCalledWith('claude');

    fireEvent.change(screen.getByTestId('invoker-terminal-input'), {
      target: { value: 'draft a focused selector plan' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      expect(controller.onSubmit).toHaveBeenCalledWith({
        message: 'draft a focused selector plan',
        presetKey: 'claude',
      });
    });
  });

  it('keeps the selector visible after typing and clearing a submitted message', async () => {
    const controller = createTerminalHarnessController();
    render(<InvokerTerminalHarness controller={controller} />);

    fireEvent.change(screen.getByTestId('invoker-terminal-input'), {
      target: { value: 'hello' },
    });
    fireEvent.submit(screen.getByTestId('invoker-terminal-input').closest('form')!);

    await waitFor(() => expect(controller.onSubmit).toHaveBeenCalledTimes(1));
    expect(screen.getByLabelText('Agent')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Options' })).not.toBeInTheDocument();
    expect(screen.getByTestId('invoker-terminal-input')).toHaveValue('');
  });
});
