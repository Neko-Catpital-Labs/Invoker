import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMockInvoker, makePlanningSessionSummary, type MockInvoker } from './helpers/mock-invoker.js';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

vi.mock('xterm', () => ({
  Terminal: class MockTerminal {
    cols = 80;
    rows = 24;
    loadAddon() {}
    open() {}
    write() {}
    onData() {
      return { dispose() {} };
    }
    dispose() {}
    focus() {}
  },
}));

vi.mock('xterm-addon-fit', () => ({
  FitAddon: class MockFitAddon {
    fit() {}
  },
}));

const { App } = await import('../App.js');

describe('planning terminal preset switching repro', () => {
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

  it('reproduces a global preset selection leaking when switching from one chat to another', async () => {
    mock.api.planningChatSend = vi.fn(async (request: any) => {
      if (request.message === 'first uses claude') {
        return {
          ok: true,
          sessionId: 'chat-started-on-claude',
          reply: 'first chat reply',
          draftPlanAvailable: false,
        };
      }
      if (request.message === 'second uses codex') {
        return {
          ok: true,
          sessionId: 'chat-started-on-codex',
          reply: 'second chat reply',
          draftPlanAvailable: false,
        };
      }
      return {
        ok: true,
        sessionId: request.sessionId,
        reply: 'continued first chat',
        draftPlanAvailable: false,
      };
    }) as any;

    render(<App />);
    await openPlanningTerminal();

    fireEvent.change(screen.getByTestId('invoker-terminal-harness'), { target: { value: 'omp+claude' } });
    submitPlanningText('first uses claude');
    await waitFor(() => {
      expect(mock.api.planningChatSend).toHaveBeenNthCalledWith(1, {
        message: 'first uses claude',
        presetKey: 'omp+claude',
      });
    });

    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
    fireEvent.change(screen.getByTestId('invoker-terminal-harness'), { target: { value: 'codex' } });
    submitPlanningText('second uses codex');
    await waitFor(() => {
      expect(mock.api.planningChatSend).toHaveBeenNthCalledWith(2, {
        message: 'second uses codex',
        presetKey: 'codex',
      });
    });

    const firstChatButton = within(screen.getByTestId('planning-session-list'))
      .getByText('first uses claude')
      .closest('button');
    if (!firstChatButton) throw new Error('first chat row did not render as a button');
    fireEvent.click(firstChatButton);

    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-transcript')).toHaveTextContent('first chat reply');
    });
    expect(screen.getByTestId('invoker-terminal-harness')).toHaveValue('codex');

    submitPlanningText('continue first chat');

    await waitFor(() => {
      expect(mock.api.planningChatSend).toHaveBeenNthCalledWith(3, {
        sessionId: 'chat-started-on-claude',
        message: 'continue first chat',
        presetKey: 'codex',
      });
    });
  });

  it('reproduces using the stale chat preset when the preset changes before tmux open', async () => {
    mock.api.planningChatCreate = vi.fn(async (request: any) => ({
      ok: true,
      session: makePlanningSessionSummary({
        id: 'tmux-created-chat',
        title: request.title,
        status: 'still_discussing',
        presetKey: request.presetKey,
        messages: [],
        draftPlanAvailable: false,
      }),
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
        outputSnapshot: '',
      },
    })) as any;

    render(<App />);
    await openPlanningTerminal();

    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
    fireEvent.change(screen.getByTestId('invoker-terminal-harness'), { target: { value: 'omp+claude' } });
    fireEvent.click(screen.getByRole('tab', { name: 'Tmux' }));

    await waitFor(() => {
      expect(mock.api.planningChatCreate).toHaveBeenCalledWith({
        presetKey: 'codex',
        title: 'Untitled plan',
      });
      expect(mock.api.planningTerminalOpen).toHaveBeenCalledWith('tmux-created-chat');
    });
  });
});
