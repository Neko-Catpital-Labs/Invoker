import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { createMockInvoker, makePlanningSessionSummary, type MockInvoker } from './helpers/mock-invoker.js';

vi.mock('xterm', () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    loadAddon() {}
    open() {}
    write() {}
    onData() {
      return { dispose() {} };
    }
    focus() {}
    dispose() {}
  },
}));

vi.mock('xterm-addon-fit', () => ({
  FitAddon: class {
    fit() {}
  },
}));

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

  function submitPlanningText(text: string) {
    fireEvent.change(screen.getByTestId('invoker-terminal-input'), { target: { value: text } });
    fireEvent.submit(screen.getByTestId('invoker-terminal-input').closest('form')!);
  }

  function planningSessionButton(text: string): HTMLElement {
    return within(screen.getByTestId('planning-session-list')).getByText(text).closest('button')!;
  }

  it('keeps each chat bound to its own preset when switching chat-to-chat', async () => {
    mock.api.planningChatSend = vi.fn(async (request: any) => {
      const sessionId = request.sessionId
        ?? (request.message.includes('omp') ? 'session-omp' : 'session-codex');
      return {
        ok: true,
        sessionId,
        reply: `Reply from ${request.presetKey}`,
        draftPlanAvailable: false,
      };
    }) as any;

    render(<App />);
    await openPlanningTerminal();

    submitPlanningText('first codex chat');
    await waitFor(() => expect(mock.api.planningChatSend).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
    fireEvent.change(screen.getByTestId('invoker-terminal-harness'), { target: { value: 'omp+claude' } });
    submitPlanningText('second omp chat');
    await waitFor(() => expect(mock.api.planningChatSend).toHaveBeenCalledTimes(2));

    fireEvent.click(planningSessionButton('first codex chat'));
    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-harness')).toHaveValue('codex');
    });
    submitPlanningText('follow up on codex chat');

    await waitFor(() => {
      expect(mock.api.planningChatSend).toHaveBeenCalledTimes(3);
      expect(mock.api.planningChatSend).toHaveBeenLastCalledWith({
        sessionId: 'session-codex',
        message: 'follow up on codex chat',
        presetKey: 'codex',
        confirmationMode: 'require',
      });
    });
  });

  it('uses the latest preset when it changes immediately before opening tmux', async () => {
    mock.api.planningChatCreate = vi.fn(async (request: any) => ({
      ok: true,
      session: makePlanningSessionSummary({
        id: 'session-created-for-tmux',
        title: 'Untitled plan',
        presetKey: request.presetKey,
        confirmationMode: request.confirmationMode,
        messages: [],
        draftPlanAvailable: false,
      }),
    })) as any;
    mock.api.planningTerminalOpen = vi.fn(async (planningSessionId: string) => ({
      opened: true,
      session: {
        sessionId: 'term-created-for-latest-preset',
        taskId: `planning:${planningSessionId}`,
        kind: 'planning',
        planningSessionId,
        status: 'running',
        mode: 'spawn',
        attached: false,
        createdAt: '2026-07-07T00:00:03.000Z',
      },
    })) as any;

    render(<App />);
    await openPlanningTerminal();

    await act(async () => {
      fireEvent.change(screen.getByTestId('invoker-terminal-harness'), { target: { value: 'omp+claude' } });
      fireEvent.click(within(screen.getByTestId('invoker-terminal-mode-toggle')).getByRole('tab', { name: 'Tmux' }));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(mock.api.planningChatCreate).toHaveBeenCalledWith({
        presetKey: 'omp+claude',
        title: 'Untitled plan',
        confirmationMode: 'require',
      });
      expect(mock.api.planningTerminalOpen).toHaveBeenCalledWith('session-created-for-tmux');
      expect(screen.getByTestId('invoker-terminal-tmux-pane')).toHaveAttribute('data-session-id', 'term-created-for-latest-preset');
    });
  });
});
