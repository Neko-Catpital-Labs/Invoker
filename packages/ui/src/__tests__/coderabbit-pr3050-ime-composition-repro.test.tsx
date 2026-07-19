import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  InvokerTerminalHarness,
  createTerminalHarnessController,
} from './helpers/invoker-terminal-harness.js';

describe('CodeRabbit PR #3050 - Enter-to-submit ignores IME composition', () => {
  it('does not submit while an IME composition is in progress', async () => {
    const controller = createTerminalHarnessController();
    render(<InvokerTerminalHarness controller={controller} />);

    const input = screen.getByTestId('invoker-terminal-input');
    fireEvent.change(input, { target: { value: 'hello' } });

    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    await Promise.resolve();
    expect(controller.onSubmit).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => {
      expect(controller.onSubmit).toHaveBeenCalledWith({
        message: 'hello',
        presetKey: 'codex',
      });
    });
  });
});
