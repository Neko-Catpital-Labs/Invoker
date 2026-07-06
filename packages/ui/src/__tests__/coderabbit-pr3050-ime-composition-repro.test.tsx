import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { createMockInvoker, type MockInvoker } from './helpers/mock-invoker.js';

vi.mock('@xyflow/react', async () => {
  // Dynamic import is required because Vitest hoists mock factories before test imports.
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

// Dynamic import is required so App sees the hoisted @xyflow/react mock.
const { App } = await import('../App.js');

// CodeRabbit PR #3050 (discussion r3523490884): the composer's Enter-to-submit
// handler did not check IME composition, so the Enter that confirms a CJK/IME
// candidate submitted a half-composed message. This repro presses Enter with
// nativeEvent.isComposing === true and asserts nothing is sent. Buggy code sends
// the in-progress text -> planningChatSend is called -> FAIL.
describe('CodeRabbit PR #3050 — Enter-to-submit ignores IME composition', () => {
  let mock: MockInvoker;

  beforeEach(() => {
    mock = createMockInvoker();
    mock.install();
  });

  afterEach(() => {
    mock.cleanup();
  });

  async function openPlanningTerminal() {
    fireEvent.click(await screen.findByTestId('sidebar-planning'));
    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-harness')).toHaveValue('codex');
    });
  }

  it('does not submit while an IME composition is in progress', async () => {
    render(<App />);
    await openPlanningTerminal();

    const input = screen.getByTestId('invoker-terminal-input');
    fireEvent.change(input, { target: { value: 'こんにちは' } });

    // Enter that only confirms the IME candidate — must not submit.
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    await Promise.resolve();
    expect(mock.api.planningChatSend).not.toHaveBeenCalled();

    // A subsequent plain Enter (composition finished) submits normally.
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => {
      expect(mock.api.planningChatSend).toHaveBeenCalledWith({ message: 'こんにちは', presetKey: 'codex' });
    });
  });
});
