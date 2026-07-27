import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMockInvoker, type MockInvoker } from './helpers/mock-invoker.js';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

const { App } = await import('../App.js');

describe('planning terminal preset ownership repro', () => {
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
    await showOptions();
  }

  async function showOptions() {
    if (!screen.queryByTestId('invoker-terminal-harness')) {
      fireEvent.click(await screen.findByRole('button', { name: 'Options' }));
    }
    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-harness')).toBeInTheDocument();
    });
  }

  function submitPlanningText(text: string) {
    fireEvent.change(screen.getByTestId('invoker-terminal-input'), { target: { value: text } });
    fireEvent.submit(screen.getByTestId('invoker-terminal-input').closest('form')!);
  }

  it.fails('keeps each chat row bound to the preset used to create that chat', async () => {
    mock.api.planningChatSend = vi.fn(async (request: any) => ({
      ok: true,
      sessionId: request.message.includes('second') ? 'session-claude' : 'session-codex',
      reply: request.message.includes('second') ? 'Claude chat reply.' : 'Codex chat reply.',
      draftPlanAvailable: false,
    })) as any;

    render(<App />);
    await openPlanningTerminal();

    submitPlanningText('first codex chat');
    await waitFor(() => {
      expect(mock.api.planningChatSend).toHaveBeenCalledWith({
        message: 'first codex chat',
        presetKey: 'codex',
      });
    });

    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
    await showOptions();
    fireEvent.change(screen.getByTestId('invoker-terminal-harness'), { target: { value: 'omp+claude' } });
    submitPlanningText('second claude chat');

    await waitFor(() => {
      expect(mock.api.planningChatSend).toHaveBeenCalledWith({
        message: 'second claude chat',
        presetKey: 'omp+claude',
      });
    });

    fireEvent.click(within(screen.getByTestId('planning-session-list')).getByText('first codex chat'));
    await showOptions();

    expect(screen.getByTestId('invoker-terminal-harness')).toHaveValue('codex');
  });

  it.fails('uses a preset changed after New chat when opening tmux before the first send', async () => {
    render(<App />);
    await openPlanningTerminal();

    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
    await showOptions();
    fireEvent.change(screen.getByTestId('invoker-terminal-harness'), { target: { value: 'omp+claude' } });
    fireEvent.click(screen.getByRole('tab', { name: 'Tmux' }));

    await waitFor(() => {
      expect(mock.api.planningChatCreate).toHaveBeenCalledTimes(1);
    });
    expect(mock.api.planningChatCreate).toHaveBeenCalledWith({
      presetKey: 'omp+claude',
      title: 'Untitled plan',
    });
  });
});
