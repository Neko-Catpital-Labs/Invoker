import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMockInvoker, type MockInvoker } from './helpers/mock-invoker.js';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

vi.mock('xterm', () => ({
  Terminal: class MockTerminal {
    cols = 80;
    rows = 24;
    loadAddon() {}
    open() {}
    write() {}
    onData() {
      return { dispose() {} };
    }
    dispose() {}
    focus() {}
  },
}));

vi.mock('xterm-addon-fit', () => ({
  FitAddon: class MockFitAddon {
    fit() {}
  },
}));

const { App } = await import('../App.js');

describe('planning terminal failed first-send session id repro', () => {
  let mock: MockInvoker;

  beforeEach(() => {
    mock = createMockInvoker();
    mock.install();
  });

  afterEach(() => {
    mock.cleanup();
  });

  async function openPlanningTerminal() {
    fireEvent.click(await screen.findByTestId('sidebar-home'));
    const expandPlanningChats = screen.queryByRole('button', { name: 'Expand planning chats' });
    if (expandPlanningChats) fireEvent.click(expandPlanningChats);
    fireEvent.click(await screen.findByRole('button', { name: 'Options' }));
    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-harness')).toHaveValue('codex');
    });
  }

  function submitPlanningText(text: string) {
    fireEvent.change(screen.getByTestId('invoker-terminal-input'), { target: { value: text } });
    fireEvent.submit(screen.getByTestId('invoker-terminal-input').closest('form')!);
  }

  it('reproduces dropping the real sessionId returned by a failed first send', async () => {
    mock.api.planningChatSend = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        sessionId: 'real-session-after-first-failure',
        error: 'planner failed after creating the conversation',
      })
      .mockResolvedValueOnce({
        ok: true,
        sessionId: 'fresh-retry-session',
        reply: 'retry created a separate conversation',
        draftPlanAvailable: false,
      }) as any;

    render(<App />);
    await openPlanningTerminal();

    submitPlanningText('first request creates then fails');
    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-transcript')).toHaveTextContent('planner failed after creating the conversation');
    });

    submitPlanningText('retry should have reused the failed session id');

    await waitFor(() => {
      expect(mock.api.planningChatSend).toHaveBeenCalledTimes(2);
      expect(mock.api.planningChatSend).toHaveBeenNthCalledWith(2, {
        message: 'retry should have reused the failed session id',
        presetKey: 'codex',
      });
    });
    expect(screen.getByTestId('planning-session-list')).not.toHaveTextContent('real-session-after-first-failure');
  });
});
