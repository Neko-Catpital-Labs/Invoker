import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { createMockInvoker, makePlanningSessionSummary, type MockInvoker } from './helpers/mock-invoker.js';
import type { TerminalSessionDescriptor } from '@invoker/contracts';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

const xtermMock = vi.hoisted(() => {
  class MockTerminal {
    cols = 80;
    rows = 24;
    loadAddon = vi.fn();
    open = vi.fn((host: HTMLElement) => {
      const terminalElement = document.createElement('div');
      terminalElement.className = 'xterm';
      host.appendChild(terminalElement);
    });
    write = vi.fn();
    onData = vi.fn(() => ({ dispose: vi.fn() }));
    focus = vi.fn();
    dispose = vi.fn();
  }

  class MockFitAddon {
    fit = vi.fn();
  }

  return {
    Terminal: MockTerminal,
    FitAddon: MockFitAddon,
  };
});

vi.mock('xterm', () => ({ Terminal: xtermMock.Terminal }));
vi.mock('xterm-addon-fit', () => ({ FitAddon: xtermMock.FitAddon }));

const { App } = await import('../App.js');

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

describe('planning-terminal startup hydrate race repro', () => {
  let mock: MockInvoker;

  beforeEach(() => {
    mock = createMockInvoker();
    mock.install();
  });

  afterEach(() => {
    mock.cleanup();
    vi.restoreAllMocks();
  });

  // `it.fails`: this asserts the desired startup invariant. The current UI has
  // two independent planning hydrate paths, so a fast chat-list response can
  // render a saved tmux conversation as chat before terminal hydration catches up.
  it.fails('does not render a saved tmux planning session through a chat-only intermediate state', async () => {
    const terminalList = deferred<TerminalSessionDescriptor[]>();
    const restoredSession = makePlanningSessionSummary({
      id: 'saved-tmux-plan',
      title: 'Saved tmux plan',
      status: 'still_discussing',
      presetKey: 'codex',
      draftPlanAvailable: false,
      draftPlanSummary: undefined,
      draftPlanText: undefined,
      terminalMode: 'tmux',
      terminalSessionId: 'term-saved-tmux-plan',
      terminalStatus: 'running',
      terminalOutputSnapshot: 'already running',
    });

    mock.api.planningChatList = vi.fn(async () => ({
      ok: true,
      sessions: [restoredSession],
    })) as any;
    mock.api.planningTerminalList = vi.fn(() => terminalList.promise) as any;

    render(<App />);

    expect(await screen.findByText('Saved tmux plan')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Tmux' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByTestId('invoker-terminal-empty-hero')).not.toBeInTheDocument();

    terminalList.resolve([
      {
        sessionId: 'term-saved-tmux-plan',
        taskId: 'planning:saved-tmux-plan',
        kind: 'planning',
        planningSessionId: 'saved-tmux-plan',
        status: 'running',
        mode: 'spawn',
        attached: false,
        createdAt: '2026-07-26T00:00:00.000Z',
        outputSnapshot: 'already running',
      },
    ]);

    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-tmux-pane')).toHaveTextContent('already running');
    });
  });
});
