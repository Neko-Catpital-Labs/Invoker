import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { createMockInvoker, type MockInvoker } from './helpers/mock-invoker.js';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

const { App } = await import('../App.js');

describe('planning terminal failed first send session id repro', () => {
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

  // `it.fails` asserts the desired behavior. The current renderer leaves the
  // active chat on its local id after this first-send failure.
  it.fails('continues with the real session id returned by a failed first send', async () => {
    const firstError = 'planner failed after creating the backing chat session';
    mock.api.planningChatSend = vi.fn(async (request: { message: string; sessionId?: string }) => {
      if (request.message === 'first turn creates then fails') {
        return {
          ok: false,
          sessionId: 'real-session-from-failed-first-send',
          error: firstError,
        };
      }
      return {
        ok: true,
        sessionId: request.sessionId ?? 'unexpected-new-session',
        reply: 'continued after failure',
        draftPlanAvailable: false,
      };
    }) as any;

    render(<App />);
    await openPlanningTerminal();

    submitPlanningText('first turn creates then fails');

    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-transcript')).toHaveTextContent(firstError);
    });

    submitPlanningText('continue after fixing auth');

    await waitFor(() => {
      expect(mock.api.planningChatSend).toHaveBeenCalledTimes(2);
    });
    expect(mock.api.planningChatSend).toHaveBeenLastCalledWith({
      sessionId: 'real-session-from-failed-first-send',
      message: 'continue after fixing auth',
      presetKey: 'codex',
    });
  });
});
