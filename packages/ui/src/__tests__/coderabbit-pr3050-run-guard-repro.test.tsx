import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  InvokerTerminalHarness,
  createTerminalHarnessController,
} from './helpers/invoker-terminal-harness.js';

describe('CodeRabbit PR #3050 - submitted planning stays guarded', () => {
  it('keeps submitted planning read-only and prevents message or draft resubmission', async () => {
    const controller = createTerminalHarnessController();
    render(
      <InvokerTerminalHarness
        controller={controller}
        readOnly={true}
        initialValue="run"
        initialDraftPlanAvailable={true}
      />,
    );

    expect(screen.queryByTestId('invoker-terminal-ready-bar')).not.toBeInTheDocument();
    expect(screen.getByTestId('invoker-terminal-input')).toBeDisabled();
    expect(screen.getByLabelText('Agent')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();

    fireEvent.submit(screen.getByTestId('invoker-terminal-input').closest('form')!);
    fireEvent.keyDown(screen.getByTestId('invoker-terminal-input'), { key: 'Enter' });
    await Promise.resolve();

    expect(controller.onSubmit).not.toHaveBeenCalled();
    expect(controller.onSubmitDraft).not.toHaveBeenCalled();
  });
});
