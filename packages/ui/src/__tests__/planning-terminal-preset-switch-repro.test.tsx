import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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
    fireEvent.click(await screen.findByRole('button', { name: 'Options' }));
    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-harness')).toHaveValue('codex');
    });
  }

  function submitPlanningText(text: string) {
    fireEvent.change(screen.getByTestId('invoker-terminal-input'), { target: { value: text } });
    fireEvent.submit(screen.getByTestId('invoker-terminal-input').closest('form')!);
  }

  // `it.fails` asserts the desired behavior. The current preset select is
  // global, so switching chats can show and send the last preset from another chat.
  it.fails('restores the owning chat preset when switching between active chats', async () => {
    mock.api.planningChatSend = vi.fn(async (request: { message: string; sessionId?: string }) => ({
      ok: true,
      sessionId: request.sessionId ?? (request.message === 'codex-owned chat' ? 'codex-chat' : 'claude-chat'),
      reply: `${request.message} reply`,
      draftPlanAvailable: false,
    })) as any;

    render(<App />);
    await openPlanningTerminal();

    submitPlanningText('codex-owned chat');
    await waitFor(() => {
      expect(mock.api.planningChatSend).toHaveBeenCalledWith({
        message: 'codex-owned chat',
        presetKey: 'codex',
      });
    });

    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
    fireEvent.change(screen.getByTestId('invoker-terminal-harness'), { target: { value: 'omp+claude' } });
    submitPlanningText('claude-owned chat');
    await waitFor(() => {
      expect(mock.api.planningChatSend).toHaveBeenCalledWith({
        message: 'claude-owned chat',
        presetKey: 'omp+claude',
      });
    });

    fireEvent.click(screen.getByText('codex-owned chat'));

    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-harness')).toHaveValue('codex');
    });

    submitPlanningText('continue codex-owned chat');

    await waitFor(() => {
      expect(mock.api.planningChatSend).toHaveBeenLastCalledWith({
        sessionId: 'codex-chat',
        message: 'continue codex-owned chat',
        presetKey: 'codex',
      });
    });
  });

  // `it.fails` asserts the desired behavior. A local chat created while Codex
  // was selected keeps that old preset when Tmux creates the real session.
  it.fails('uses a preset changed in chat mode before opening tmux', async () => {
    render(<App />);
    await openPlanningTerminal();

    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
    fireEvent.change(screen.getByTestId('invoker-terminal-harness'), { target: { value: 'omp+claude' } });
    fireEvent.click(screen.getByRole('tab', { name: 'Tmux' }));

    await waitFor(() => {
      expect(mock.api.planningChatCreate).toHaveBeenCalled();
    });
    expect(mock.api.planningChatCreate).toHaveBeenCalledWith({
      presetKey: 'omp+claude',
      title: 'Untitled plan',
    });
  });
});
