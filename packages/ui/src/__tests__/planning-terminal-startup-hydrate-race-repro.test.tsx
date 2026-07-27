import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { InAppPlanningListSessionsResponse, TerminalSessionDescriptor } from '@invoker/contracts';
import { createMockInvoker, makePlanningSessionSummary, type MockInvoker } from './helpers/mock-invoker.js';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

const { App } = await import('../App.js');

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

function restoredChatList(terminal: Partial<TerminalSessionDescriptor> = {}): InAppPlanningListSessionsResponse {
  return {
    ok: true,
    sessions: [
      makePlanningSessionSummary({
        id: 'planning-restored-race',
        title: 'Restored tmux race',
        status: 'still_discussing',
        presetKey: 'codex',
        draftPlanAvailable: false,
        messages: [
          {
            id: 1,
            role: 'assistant',
            text: 'Restored transcript',
            createdAt: '2026-07-07T00:00:01.000Z',
          },
        ],
        terminalMode: 'tmux',
        terminalSessionId: terminal.sessionId,
        terminalStatus: terminal.status,
        terminalOutputSnapshot: terminal.outputSnapshot,
        terminalUpdatedAt: terminal.createdAt,
      }),
    ],
  };
}

function livePlanningTerminal(): TerminalSessionDescriptor {
  return {
    sessionId: 'term-live-after-startup',
    taskId: 'planning:planning-restored-race',
    kind: 'planning',
    planningSessionId: 'planning-restored-race',
    status: 'running',
    mode: 'spawn',
    attached: false,
    createdAt: '2026-07-07T00:00:03.000Z',
    outputSnapshot: 'live tmux output\n',
  };
}

async function openPlanningTerminal() {
  fireEvent.click(await screen.findByTestId('sidebar-home'));
  const expandPlanningChats = screen.queryByRole('button', { name: 'Expand planning chats' });
  if (expandPlanningChats) fireEvent.click(expandPlanningChats);
  await screen.findByRole('heading', { name: 'Planning chat' });
}

describe('planning terminal startup hydrate race repro', () => {
  let mock: MockInvoker;

  beforeEach(() => {
    mock = createMockInvoker();
    mock.install();
  });

  afterEach(() => {
    mock.cleanup();
    vi.restoreAllMocks();
  });

  it('keeps the live planning tmux session when a stale startup list resolves after terminal-aware hydration', async () => {
    const staleStartupList = deferred<InAppPlanningListSessionsResponse>();
    const terminalAwareList = deferred<InAppPlanningListSessionsResponse>();
    const terminal = livePlanningTerminal();

    mock.api.planningChatList = vi
      .fn()
      .mockReturnValueOnce(staleStartupList.promise)
      .mockReturnValueOnce(terminalAwareList.promise) as any;
    mock.api.planningTerminalList = vi.fn(async () => [terminal]) as any;

    render(<App />);

    await waitFor(() => {
      expect(mock.api.planningChatList).toHaveBeenCalledTimes(2);
    });

    terminalAwareList.resolve(restoredChatList());

    await openPlanningTerminal();
    expect(await screen.findByTestId('invoker-terminal-tmux-pane')).toHaveAttribute(
      'data-session-id',
      'term-live-after-startup',
    );

    staleStartupList.resolve(restoredChatList());

    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-tmux-pane')).toHaveAttribute(
        'data-session-id',
        'term-live-after-startup',
      );
    });
  });
});
