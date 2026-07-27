import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import type { InAppPlanningListSessionsResponse, TerminalSessionDescriptor } from '@invoker/contracts';
import { createMockInvoker, makePlanningSessionSummary, type MockInvoker } from './helpers/mock-invoker.js';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
  configurable: true,
  value: vi.fn(() => ({
    fillStyle: '',
    fillRect: vi.fn(),
    createLinearGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
    getImageData: vi.fn(() => ({ data: [0, 0, 0, 255] })),
  })),
});

const { App } = await import('../App.js');

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
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

  // it.fails: this asserts the desired post-fix behavior. Today the older
  // planningChatList-only hydrate can resolve after the richer terminal hydrate
  // and replace the restored tmux view with chat-mode state.
  it.fails('keeps the tmux session when the slower startup hydrate resolves last', async () => {
    const firstChatList = deferred<InAppPlanningListSessionsResponse>();
    const secondChatList = deferred<InAppPlanningListSessionsResponse>();
    const restoredSession = makePlanningSessionSummary({
      id: 'restored-tmux-chat',
      title: 'Restored tmux chat',
      status: 'still_discussing',
      draftPlanAvailable: false,
      terminalMode: 'tmux',
      terminalSessionId: 'term-restored',
      terminalStatus: 'running',
      terminalOutputSnapshot: 'persisted tmux output\n',
      terminalUpdatedAt: '2026-07-07T00:00:03.000Z',
      messages: [
        {
          id: 1,
          role: 'system',
          text: 'Restored planning shell.',
          createdAt: '2026-07-07T00:00:00.000Z',
        },
      ],
    });
    const liveTerminal: TerminalSessionDescriptor = {
      sessionId: 'term-restored',
      taskId: 'planning:restored-tmux-chat',
      kind: 'planning',
      planningSessionId: 'restored-tmux-chat',
      status: 'running',
      mode: 'spawn',
      attached: false,
      createdAt: '2026-07-07T00:00:03.000Z',
      outputSnapshot: 'live tmux output\n',
    };
    const response: InAppPlanningListSessionsResponse = { ok: true, sessions: [restoredSession] };

    mock.api.planningChatList = vi
      .fn()
      .mockImplementationOnce(() => firstChatList.promise)
      .mockImplementationOnce(() => secondChatList.promise)
      .mockResolvedValue(response) as any;
    mock.api.planningTerminalList = vi.fn(async () => [liveTerminal]) as any;

    render(<App />);

    await waitFor(() => {
      expect(mock.api.planningChatList).toHaveBeenCalledTimes(2);
      expect(mock.api.planningTerminalList).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      secondChatList.resolve(response);
      await Promise.resolve();
      firstChatList.resolve(response);
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-tmux-pane')).toHaveAttribute('data-session-id', 'term-restored');
    });
    expect(screen.getByRole('tab', { name: 'Tmux' })).toHaveAttribute('aria-selected', 'true');
  });
});
