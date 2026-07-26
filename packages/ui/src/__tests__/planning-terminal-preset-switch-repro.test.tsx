import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import type { InAppPlanningChatResponse } from '@invoker/contracts';
import { createMockInvoker, type MockInvoker } from './helpers/mock-invoker.js';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

const { App } = await import('../App.js');

describe('planning terminal preset ownership repros', () => {
  let mock: MockInvoker;

  beforeEach(() => {
    mock = createMockInvoker();
    mock.install();
  });

  afterEach(() => {
    mock.cleanup();
    vi.restoreAllMocks();
  });

  async function openPlanningTerminal() {
    fireEvent.click(await screen.findByTestId('sidebar-home'));
    fireEvent.click(await screen.findByRole('button', { name: 'Options' }));
    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-harness')).toHaveValue('codex');
    });
  }

  function submitPlanningText(text: string) {
    fireEvent.change(screen.getByTestId('invoker-terminal-input'), { target: { value: text } });
    fireEvent.submit(screen.getByTestId('invoker-terminal-input').closest('form')!);
  }

  it.fails('restores each chat-owned preset when switching between planning chats', async () => {
    mock.api.planningChatSend = vi.fn(async (request) => {
      const message = String((request as { message?: string }).message ?? '');
      const sessionId = message.includes('codex') ? 'codex-owned-chat' : 'claude-owned-chat';
      return {
        ok: true,
        sessionId,
        reply: `Reply for ${sessionId}.`,
        draftPlanAvailable: false,
      } satisfies InAppPlanningChatResponse;
    }) as never;

    render(<App />);
    await openPlanningTerminal();

    submitPlanningText('first codex chat');
    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-transcript')).toHaveTextContent('Reply for codex-owned-chat.');
    });

    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
    fireEvent.change(screen.getByTestId('invoker-terminal-harness'), { target: { value: 'omp+claude' } });
    submitPlanningText('second claude chat');
    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-transcript')).toHaveTextContent('Reply for claude-owned-chat.');
    });

    fireEvent.click(within(screen.getByTestId('planning-session-list')).getByText('first codex chat'));

    expect(screen.getByTestId('invoker-terminal-harness')).toHaveValue('codex');
  });

  it.fails('uses the selected preset when a local chat switches preset before opening tmux', async () => {
    render(<App />);
    await openPlanningTerminal();

    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
    fireEvent.change(screen.getByTestId('invoker-terminal-harness'), { target: { value: 'omp+claude' } });
    fireEvent.click(screen.getByRole('tab', { name: 'Tmux' }));

    await waitFor(() => {
      expect(mock.api.planningChatCreate).toHaveBeenCalledTimes(1);
    });
    expect(mock.api.planningChatCreate).toHaveBeenCalledWith(expect.objectContaining({
      presetKey: 'omp+claude',
    }));
  });
});

