import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { InAppPlanningListSessionsResponse, TerminalSessionDescriptor } from '@invoker/contracts';
import { createMockInvoker, makePlanningSessionSummary, type MockInvoker } from './helpers/mock-invoker.js';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

const { App } = await import('../App.js');

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

describe('planning terminal startup hydrate race repro', () => {
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

  it('keeps a live planning tmux session when chat-only hydrate resolves after terminal hydrate', async () => {
    const chatOnlyHydrate = deferred<InAppPlanningListSessionsResponse>();
    const terminalAwareHydrate = deferred<InAppPlanningListSessionsResponse>();
    const restoredChat = makePlanningSessionSummary({
      id: 'planning-hydrate-race',
      title: 'Hydrated tmux chat',
      status: 'still_discussing',
      messages: [
        {
          id: 1,
          role: 'system',
          text: 'Restored planning chat.',
          createdAt: '2026-07-26T00:00:00.000Z',
        },
      ],
      draftPlanAvailable: false,
      draftPlanSummary: undefined,
      draftPlanText: undefined,
      terminalMode: 'tmux',
      terminalSessionId: undefined,
      terminalOutputSnapshot: '',
      updatedAt: '2026-07-26T00:00:01.000Z',
    });
    const liveTerminal: TerminalSessionDescriptor = {
      sessionId: 'live-planning-terminal',
      taskId: 'planning:planning-hydrate-race',
      kind: 'planning',
      planningSessionId: 'planning-hydrate-race',
      status: 'running',
      mode: 'spawn',
      attached: false,
      cwd: '/repo',
      createdAt: '2026-07-26T00:00:02.000Z',
      outputSnapshot: 'already running in tmux\n',
    };

    mock.api.planningChatList = vi
      .fn()
      .mockReturnValueOnce(chatOnlyHydrate.promise)
      .mockReturnValueOnce(terminalAwareHydrate.promise) as any;
    mock.api.planningTerminalList = vi.fn(async () => [liveTerminal]) as any;

    render(<App />);
    await waitFor(() => {
      expect(mock.api.planningChatList).toHaveBeenCalledTimes(2);
    });

    await act(async () => {
      terminalAwareHydrate.resolve({ ok: true, sessions: [restoredChat] });
    });

    expect(await screen.findByTestId('invoker-terminal-tmux-pane')).toHaveAttribute(
      'data-session-id',
      'live-planning-terminal',
    );
    expect(screen.getByTestId('planning-session-rail')).toHaveTextContent('Hydrated tmux chat');

    await act(async () => {
      chatOnlyHydrate.resolve({ ok: true, sessions: [restoredChat] });
    });

    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-tmux-pane')).toHaveAttribute(
        'data-session-id',
        'live-planning-terminal',
      );
    });
    expect(mock.api.planningTerminalOpen).not.toHaveBeenCalled();
  });

  it('merges delayed restore without replacing an already-edited local planning chat', async () => {
    const chatOnlyHydrate = deferred<InAppPlanningListSessionsResponse>();
    const terminalAwareHydrate = deferred<InAppPlanningListSessionsResponse>();
    const restoredChat = makePlanningSessionSummary({
      id: 'restored-existing-chat',
      title: 'Restored existing chat',
      status: 'still_discussing',
      messages: [
        {
          id: 4,
          role: 'assistant',
          text: 'Existing restored transcript.',
          createdAt: '2026-07-26T00:00:00.000Z',
        },
      ],
      draftPlanAvailable: false,
      draftPlanSummary: undefined,
      draftPlanText: undefined,
      updatedAt: '2026-07-26T00:00:01.000Z',
    });

    mock.api.planningChatList = vi
      .fn()
      .mockReturnValueOnce(chatOnlyHydrate.promise)
      .mockReturnValueOnce(terminalAwareHydrate.promise) as any;
    mock.api.planningChatSend = vi.fn(() => new Promise(() => {}) as any) as any;
    mock.api.planningTerminalList = vi.fn(async () => []) as any;

    render(<App />);
    await waitFor(() => {
      expect(mock.api.planningChatList).toHaveBeenCalledTimes(2);
    });
    await openPlanningTerminal();

    submitPlanningText('local planning work started before restore');
    await waitFor(() => {
      expect(mock.api.planningChatSend).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('invoker-terminal-transcript')).toHaveTextContent('local planning work started before restore');
    });

    await act(async () => {
      terminalAwareHydrate.resolve({ ok: true, sessions: [restoredChat] });
    });

    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-transcript')).toHaveTextContent('local planning work started before restore');
      expect(screen.getByTestId('planning-session-rail')).toHaveTextContent('Restored existing chat');
    });

    await act(async () => {
      chatOnlyHydrate.resolve({ ok: true, sessions: [restoredChat] });
    });

    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-transcript')).toHaveTextContent('local planning work started before restore');
      expect(screen.getByTestId('planning-session-rail')).toHaveTextContent('Restored existing chat');
    });
  });
});
