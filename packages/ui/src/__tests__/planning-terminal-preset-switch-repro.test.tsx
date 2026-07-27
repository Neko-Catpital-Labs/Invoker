import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

  it('keeps a rapid chat-to-chat preset switch on the newly opened chat', async () => {
    render(<App />);
    await openPlanningTerminal();

    await act(async () => {
      fireEvent.change(screen.getByTestId('invoker-terminal-harness'), { target: { value: 'omp+claude' } });
      fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
    });

    expect(screen.getByTestId('invoker-terminal-harness')).toHaveValue('omp+claude');
  });

  it('uses a preset changed immediately before opening tmux for a local chat', async () => {
    mock.api.planningChatCreate = vi.fn(async () => ({
      ok: true,
      session: {
        id: 'tmux-session-created-after-preset-change',
        title: 'Untitled plan',
        status: 'still_discussing',
        presetKey: 'omp+claude',
        confirmationMode: 'require',
        messages: [],
        draftPlanAvailable: false,
        createdAt: '2026-07-07T00:00:00.000Z',
        updatedAt: '2026-07-07T00:00:00.000Z',
      },
    })) as any;
    mock.api.planningTerminalOpen = vi.fn(async (planningSessionId: string) => ({
      opened: true,
      session: {
        sessionId: `terminal-${planningSessionId}`,
        taskId: `planning:${planningSessionId}`,
        kind: 'planning',
        planningSessionId,
        status: 'running',
        mode: 'spawn',
        attached: false,
        createdAt: '2026-07-07T00:00:00.000Z',
      },
    })) as any;

    render(<App />);
    await openPlanningTerminal();

    await act(async () => {
      fireEvent.change(screen.getByTestId('invoker-terminal-harness'), { target: { value: 'omp+claude' } });
      fireEvent.click(screen.getByRole('tab', { name: 'Tmux' }));
    });

    await waitFor(() => expect(mock.api.planningChatCreate).toHaveBeenCalledTimes(1));
    expect(mock.api.planningChatCreate).toHaveBeenCalledWith({
      presetKey: 'omp+claude',
      title: 'Untitled plan',
      confirmationMode: 'require',
    });
  });
});
