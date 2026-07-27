import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMockInvoker, type MockInvoker } from './helpers/mock-invoker.js';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

vi.mock('xterm', () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    loadAddon() {}
    open() {}
    onData() {
      return { dispose() {} };
    }
    write() {}
    dispose() {}
    focus() {}
  },
}));

vi.mock('xterm-addon-fit', () => ({
  FitAddon: class {
    fit() {}
  },
}));

const { App } = await import('../App.js');

describe('planning terminal failed first send sessionId repro', () => {
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

  it.fails('continues with the real sessionId returned by a failed first send', async () => {
    const plannerError = 'planner created a session but failed before replying';
    mock.api.planningChatSend = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        sessionId: 'real-session-after-failed-first-send',
        error: plannerError,
      })
      .mockResolvedValueOnce({
        ok: true,
        sessionId: 'real-session-after-failed-first-send',
        reply: 'Retry continued the server-side session.',
        draftPlanAvailable: false,
      }) as any;

    render(<App />);
    await openPlanningTerminal();

    submitPlanningText('first request fails after session creation');
    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-transcript')).toHaveTextContent(plannerError);
    });

    submitPlanningText('retry in the same planning session');
    await waitFor(() => expect(mock.api.planningChatSend).toHaveBeenCalledTimes(2));

    expect(mock.api.planningChatSend).toHaveBeenLastCalledWith({
      sessionId: 'real-session-after-failed-first-send',
      message: 'retry in the same planning session',
      presetKey: 'codex',
      confirmationMode: 'require',
    });
  });
});
