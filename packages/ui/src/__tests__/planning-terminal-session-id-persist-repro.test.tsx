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

  it.fails('continues the real backend session after a failed first send returns sessionId', async () => {
    const plannerError = 'planner spawned but auth failed after creating the conversation';
    mock.api.planningChatSend = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        sessionId: 'backend-session-after-failure',
        error: plannerError,
      })
      .mockResolvedValueOnce({
        ok: true,
        sessionId: 'backend-session-after-failure',
        reply: 'Recovered in the original planning conversation.',
        draftPlanAvailable: false,
      }) as any;

    render(<App />);
    await openPlanningTerminal();

    submitPlanningText('draft the first plan');
    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-transcript')).toHaveTextContent(plannerError);
    });

    submitPlanningText('retry after logging in');

    await waitFor(() => {
      expect(mock.api.planningChatSend).toHaveBeenCalledTimes(2);
    });
    expect(mock.api.planningChatSend).toHaveBeenLastCalledWith({
      sessionId: 'backend-session-after-failure',
      message: 'retry after logging in',
      presetKey: 'codex',
    });
  });
});
