import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMockInvoker, makePlanningSessionSummary, type MockInvoker } from './helpers/mock-invoker.js';

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

  it('restores each chat-owned preset when switching between planning chats', async () => {
    mock.api.planningChatSend = vi.fn(async (request: any) => {
      const sessionId = request.sessionId
        ?? (request.presetKey === 'omp+claude' ? 'claude-chat-session' : 'codex-chat-session');
      return {
        ok: true,
        sessionId,
        reply: `${request.presetKey} reply for ${request.message}`,
        confirmationMode: 'require',
        draftPlanAvailable: false,
      };
    }) as any;

    render(<App />);
    await openPlanningTerminal();

    submitPlanningText('first codex request');
    await waitFor(() => {
      expect(mock.api.planningChatSend).toHaveBeenLastCalledWith({
        message: 'first codex request',
        presetKey: 'codex',
        confirmationMode: 'require',
      });
    });

    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
    fireEvent.change(screen.getByTestId('invoker-terminal-harness'), { target: { value: 'omp+claude' } });
    submitPlanningText('second claude request');
    await waitFor(() => {
      expect(mock.api.planningChatSend).toHaveBeenLastCalledWith({
        message: 'second claude request',
        presetKey: 'omp+claude',
        confirmationMode: 'require',
      });
    });

    fireEvent.click(screen.getByText('first codex request'));
    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-harness')).toHaveValue('codex');
    });

    submitPlanningText('continue codex request');
    await waitFor(() => {
      expect(mock.api.planningChatSend).toHaveBeenLastCalledWith({
        sessionId: 'codex-chat-session',
        message: 'continue codex request',
        presetKey: 'codex',
        confirmationMode: 'require',
      });
    });
  });

  it('uses a preset selected on a local chat before opening tmux', async () => {
    mock.api.planningChatCreate = vi.fn(async (request: any) => ({
      ok: true,
      session: makePlanningSessionSummary({
        id: 'tmux-created-session',
        title: request?.title ?? 'Untitled plan',
        status: 'still_discussing',
        presetKey: request?.presetKey ?? 'codex',
        confirmationMode: request?.confirmationMode ?? 'require',
        messages: [],
        draftPlanAvailable: false,
        draftPlanSummary: undefined,
      }),
    })) as any;

    render(<App />);
    await openPlanningTerminal();

    fireEvent.change(screen.getByTestId('invoker-terminal-harness'), { target: { value: 'omp+claude' } });
    fireEvent.click(screen.getByRole('tab', { name: 'Tmux' }));

    await waitFor(() => {
      expect(mock.api.planningChatCreate).toHaveBeenCalledWith(expect.objectContaining({
        presetKey: 'omp+claude',
        confirmationMode: 'require',
        title: 'Untitled plan',
      }));
      expect(mock.api.planningTerminalOpen).toHaveBeenCalledWith('tmux-created-session');
    });
    expect(await screen.findByTestId('invoker-terminal-tmux-pane')).toHaveAttribute(
      'data-session-id',
      'mock-planning-terminal-tmux-created-session',
    );
  });
});
