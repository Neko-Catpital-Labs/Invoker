import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { createMockInvoker, type MockInvoker } from './helpers/mock-invoker.js';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

const { App } = await import('../App.js');

describe('planning terminal failed first send session id persist repro', () => {
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
    if (!screen.queryByTestId('invoker-terminal-harness')) {
      fireEvent.click(await screen.findByRole('button', { name: 'Options' }));
    }
    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-harness')).toHaveValue('codex');
    });
  }

  function submitPlanningText(text: string) {
    fireEvent.change(screen.getByTestId('invoker-terminal-input'), { target: { value: text } });
    fireEvent.submit(screen.getByTestId('invoker-terminal-input').closest('form')!);
  }

  // Regression proof: the first failing send may still create a real
  // persisted session in the app process. The renderer keeps that id for
  // the retry instead of sending a second "new chat" request.
  it('persists a real session id returned by a failed first send before retrying', async () => {
    mock.api.planningChatSend = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        sessionId: 'session-created-before-error',
        error: 'planner exited before producing a reply',
      })
      .mockResolvedValueOnce({
        ok: true,
        sessionId: 'session-created-before-error',
        reply: 'Recovered on the same session.',
        draftPlanAvailable: false,
      }) as any;

    render(<App />);
    await openPlanningTerminal();

    submitPlanningText('draft a plan that fails before replying');
    expect(await screen.findByText('planner exited before producing a reply')).toBeInTheDocument();
    expect(mock.api.planningChatSend).toHaveBeenNthCalledWith(1, {
      turnId: expect.any(String),
      message: 'draft a plan that fails before replying',
      presetKey: 'codex',
      confirmationMode: 'require',
    });

    submitPlanningText('retry in the same chat');

    await waitFor(() => {
      expect(mock.api.planningChatSend).toHaveBeenCalledTimes(2);
      expect(mock.api.planningChatSend).toHaveBeenLastCalledWith({
        turnId: expect.any(String),
        sessionId: 'session-created-before-error',
        message: 'retry in the same chat',
        presetKey: 'codex',
        confirmationMode: 'require',
      });
    });
    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-transcript')).toHaveTextContent('Recovered on the same session.');
    });
    expect(screen.queryByText('This planning chat lost its server session. Start a new chat to continue planning.')).not.toBeInTheDocument();
  });
});
