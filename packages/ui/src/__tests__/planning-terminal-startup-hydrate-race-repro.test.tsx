import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { InAppPlanningListSessionsResponse, TerminalSessionDescriptor } from '@invoker/contracts';
import { createMockInvoker, makePlanningSessionSummary, type MockInvoker } from './helpers/mock-invoker.js';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

vi.mock('xterm', () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    loadAddon(): void {}
    open(): void {}
    write(): void {}
    focus(): void {}
    dispose(): void {}
    onData(): { dispose: () => void } {
      return { dispose: () => {} };
    }
  },
}));

vi.mock('xterm-addon-fit', () => ({
  FitAddon: class {
    fit(): void {}
  },
}));

const { App } = await import('../App.js');

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
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

  it('keeps the terminal-aware restore when the chat-only startup hydrate resolves last', async () => {
    const legacyChatOnlyHydrate = deferred<InAppPlanningListSessionsResponse>();
    const terminalAwareHydrate = deferred<InAppPlanningListSessionsResponse>();
    const restoredSession = makePlanningSessionSummary({
      id: 'startup-plan-1',
      title: 'Restored tmux plan',
      status: 'still_discussing',
      draftPlanAvailable: false,
      draftPlanSummary: undefined,
      draftPlanText: undefined,
      terminalMode: 'tmux',
      terminalSessionId: 'persisted-terminal-from-summary',
      terminalStatus: 'running',
      terminalOutputSnapshot: 'summary snapshot\n',
    });
    const liveTerminal: TerminalSessionDescriptor = {
      sessionId: 'live-terminal-startup',
      taskId: 'planning:startup-plan-1',
      kind: 'planning',
      planningSessionId: 'startup-plan-1',
      status: 'running',
      cwd: '/repo',
      mode: 'spawn',
      attached: false,
      createdAt: '2026-07-26T00:00:00.000Z',
      outputSnapshot: 'live tmux snapshot\n',
    };

    mock.api.planningChatList = vi
      .fn()
      .mockImplementationOnce(() => legacyChatOnlyHydrate.promise)
      .mockImplementationOnce(() => terminalAwareHydrate.promise) as any;
    mock.api.planningTerminalList = vi.fn(async () => [liveTerminal]) as any;

    render(<App />);
    fireEvent.click(await screen.findByTestId('sidebar-home'));

    await waitFor(() => {
      expect(mock.api.planningChatList).toHaveBeenCalledTimes(2);
    });

    await act(async () => {
      terminalAwareHydrate.resolve({ ok: true, sessions: [restoredSession] });
      await terminalAwareHydrate.promise;
    });

    const tmuxPane = await screen.findByTestId('invoker-terminal-tmux-pane');
    expect(tmuxPane).toHaveAttribute('data-session-id', 'live-terminal-startup');
    expect(screen.getByRole('tab', { name: 'Tmux' })).toHaveAttribute('aria-selected', 'true');

    await act(async () => {
      legacyChatOnlyHydrate.resolve({ ok: true, sessions: [restoredSession] });
      await legacyChatOnlyHydrate.promise;
    });

    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'Tmux' })).toHaveAttribute('aria-selected', 'true');
      expect(screen.getByTestId('invoker-terminal-tmux-pane')).toHaveAttribute('data-session-id', 'live-terminal-startup');
    });
  });
});
