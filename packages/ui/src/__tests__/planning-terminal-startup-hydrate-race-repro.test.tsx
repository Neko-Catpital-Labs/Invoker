import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import type { InAppPlanningListSessionsResponse, TerminalSessionDescriptor } from '@invoker/contracts';
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

class Deferred<T> {
  promise: Promise<T>;
  resolve!: (value: T) => void;

  constructor() {
    this.promise = new Promise<T>((resolve) => {
      this.resolve = resolve;
    });
  }
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

  function restoredChat(): InAppPlanningListSessionsResponse {
    return {
      ok: true,
      sessions: [
        makePlanningSessionSummary({
          id: 'restored-tmux-chat',
          title: 'Restored tmux chat',
          status: 'still_discussing',
          presetKey: 'codex',
          draftPlanAvailable: false,
          terminalMode: 'tmux',
          terminalSessionId: 'term-restored-from-db',
          terminalStatus: 'running',
          terminalOutputSnapshot: 'restored terminal output\n',
          messages: [
            {
              id: 1,
              role: 'user',
              text: 'Restore the planning terminal',
              createdAt: '2026-07-07T00:00:01.000Z',
            },
          ],
        }),
      ],
    };
  }

  function restoredTerminal(): TerminalSessionDescriptor {
    return {
      sessionId: 'term-restored-live',
      taskId: 'planning:restored-tmux-chat',
      kind: 'planning',
      planningSessionId: 'restored-tmux-chat',
      status: 'running',
      mode: 'spawn',
      attached: false,
      createdAt: '2026-07-07T00:00:03.000Z',
      outputSnapshot: 'live terminal output\n',
    };
  }

  it('keeps the restored tmux attachment when startup chat hydrate resolves after chat+terminal hydrate', async () => {
    const firstChatHydrate = new Deferred<InAppPlanningListSessionsResponse>();
    const chatWithTerminalHydrate = new Deferred<InAppPlanningListSessionsResponse>();
    const terminalHydrate = new Deferred<TerminalSessionDescriptor[]>();

    mock.api.planningChatList = vi
      .fn()
      .mockImplementationOnce(() => firstChatHydrate.promise)
      .mockImplementationOnce(() => chatWithTerminalHydrate.promise) as any;
    mock.api.planningTerminalList = vi.fn(() => terminalHydrate.promise) as any;

    render(<App />);
    fireEventClickHome();
    await screen.findByTestId('invoker-terminal-mode-toggle');

    await act(async () => {
      chatWithTerminalHydrate.resolve(restoredChat());
      terminalHydrate.resolve([restoredTerminal()]);
      firstChatHydrate.resolve(restoredChat());
      await Promise.resolve();
    });

    await waitFor(() => {
      const modeToggle = screen.getByTestId('invoker-terminal-mode-toggle');
      expect(within(modeToggle).getByRole('tab', { name: 'Tmux' })).toHaveAttribute('aria-selected', 'true');
      expect(screen.getByTestId('invoker-terminal-tmux-pane')).toHaveAttribute('data-session-id', 'term-restored-live');
    });
  });
});

function fireEventClickHome(): void {
  const home = screen.queryByTestId('sidebar-home');
  if (home) {
    home.click();
  }
}
