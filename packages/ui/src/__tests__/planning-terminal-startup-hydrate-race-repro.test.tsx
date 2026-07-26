import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import type {
  InAppPlanningListSessionsResponse,
  TerminalSessionDescriptor,
} from '@invoker/contracts';
import { createMockInvoker, makePlanningSessionSummary, type MockInvoker } from './helpers/mock-invoker.js';

const xtermMock = vi.hoisted(() => ({
  Terminal: vi.fn().mockImplementation(() => ({
    cols: 80,
    rows: 24,
    loadAddon: vi.fn(),
    open: vi.fn((host: HTMLElement) => {
      const element = document.createElement('div');
      element.className = 'xterm';
      host.appendChild(element);
    }),
    write: vi.fn(),
    onData: vi.fn(() => ({ dispose: vi.fn() })),
    dispose: vi.fn(),
    focus: vi.fn(),
  })),
  FitAddon: vi.fn().mockImplementation(() => ({ fit: vi.fn() })),
}));

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});
vi.mock('xterm', () => ({ Terminal: xtermMock.Terminal }));
vi.mock('xterm-addon-fit', () => ({ FitAddon: xtermMock.FitAddon }));

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

  it('keeps the live tmux restore when the stale startup chat hydrate resolves last', async () => {
    const staleChatList = deferred<InAppPlanningListSessionsResponse>();
    const liveChatList = deferred<InAppPlanningListSessionsResponse>();
    const liveTerminalList = deferred<TerminalSessionDescriptor[]>();

    const restoredChat = makePlanningSessionSummary({
      id: 'restored-planning-chat',
      title: 'Restored planning tmux',
      status: 'still_discussing',
      presetKey: 'codex',
      messages: [
        {
          id: 1,
          role: 'user',
          text: 'Keep the restored tmux session attached after startup.',
          createdAt: '2026-07-26T00:00:01.000Z',
        },
      ],
      draftPlanAvailable: false,
      draftPlanSummary: undefined,
      draftPlanText: undefined,
      terminalMode: 'tmux',
      terminalSessionId: 'persisted-planning-terminal',
      terminalStatus: 'running',
      terminalOutputSnapshot: 'persisted tmux output\n',
      terminalUpdatedAt: '2026-07-26T00:00:02.000Z',
    });

    const liveTerminal: TerminalSessionDescriptor = {
      sessionId: 'live-planning-terminal',
      taskId: 'planning:restored-planning-chat',
      kind: 'planning',
      planningSessionId: 'restored-planning-chat',
      status: 'running',
      cwd: '/repo',
      mode: 'spawn',
      attached: false,
      createdAt: '2026-07-26T00:00:02.000Z',
      outputSnapshot: 'live tmux output\n',
    };

    mock.api.planningChatList = vi
      .fn()
      .mockImplementationOnce(() => staleChatList.promise)
      .mockImplementationOnce(() => liveChatList.promise) as any;
    mock.api.planningTerminalList = vi.fn(() => liveTerminalList.promise) as any;

    render(<App />);

    await waitFor(() => {
      expect(mock.api.planningChatList).toHaveBeenCalledTimes(2);
      expect(mock.api.planningTerminalList).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      liveChatList.resolve({ ok: true, sessions: [restoredChat] });
      liveTerminalList.resolve([liveTerminal]);
      await liveChatList.promise;
      await liveTerminalList.promise;
    });

    await waitFor(() => {
      expect(screen.getAllByText('Restored planning tmux').length).toBeGreaterThan(0);
      expect(screen.getByTestId('invoker-terminal-tmux-pane')).toHaveAttribute(
        'data-session-id',
        'live-planning-terminal',
      );
    });

    await act(async () => {
      staleChatList.resolve({
        ok: true,
        sessions: [
          makePlanningSessionSummary({
            ...restoredChat,
            terminalMode: 'chat',
            terminalSessionId: undefined,
            terminalStatus: undefined,
            terminalOutputSnapshot: '',
            terminalUpdatedAt: undefined,
          }),
        ],
      });
      await staleChatList.promise;
    });

    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-tmux-pane')).toHaveAttribute(
        'data-session-id',
        'live-planning-terminal',
      );
      expect(screen.queryByTestId('invoker-terminal-transcript')).not.toBeInTheDocument();
    });
  });
});
