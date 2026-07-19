import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  InvokerTerminalHarness,
  createTerminalHarnessController,
} from './helpers/invoker-terminal-harness.js';

describe('CodeRabbit PR #3050 - draft state cleared after submit', () => {
  it('dismisses the ready bar and disables the composer after a successful submit', async () => {
    const controller = createTerminalHarnessController();
    render(
      <InvokerTerminalHarness
        controller={controller}
        initialDraftPlanAvailable={true}
      />,
    );

    expect(screen.getByTestId('invoker-terminal-ready-bar')).toHaveTextContent(
      'draft ready - "Mock Plan" - 2 tasks',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Submit to Invoker' }));

    await waitFor(() => {
      expect(controller.onSubmitDraft).toHaveBeenCalledTimes(1);
      expect(screen.queryByTestId('invoker-terminal-ready-bar')).not.toBeInTheDocument();
    });
    expect(screen.getByTestId('invoker-terminal-input')).toBeDisabled();
    expect(screen.getByLabelText('Agent')).toBeDisabled();
  });
});
