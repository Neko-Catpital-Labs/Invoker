import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMockInvoker, type MockInvoker } from './helpers/mock-invoker.js';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

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

  // `it.fails`: this asserts the desired lifecycle contract. Current UI keeps
  // the local placeholder id after a failed first send returns a real sessionId.
  it.fails('continues the real session id returned by a failed first send', async () => {
    mock.api.planningChatSend = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        sessionId: 'real-session-from-failed-first-send',
        error: 'planner created the session but failed before replying',
      })
      .mockResolvedValueOnce({
        ok: true,
        sessionId: 'real-session-from-failed-first-send',
        reply: 'Recovered in the same session.',
        draftPlanAvailable: false,
      }) as any;

    render(<App />);
    await openPlanningTerminal();

    submitPlanningText('first request fails after create');
    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-transcript')).toHaveTextContent(
        'planner created the session but failed before replying',
      );
    });

    submitPlanningText('retry in the created session');

    await waitFor(() => expect(mock.api.planningChatSend).toHaveBeenCalledTimes(2));
    expect(mock.api.planningChatSend).toHaveBeenLastCalledWith({
      sessionId: 'real-session-from-failed-first-send',
      message: 'retry in the created session',
      presetKey: 'codex',
      confirmationMode: 'require',
    });
  });
});
