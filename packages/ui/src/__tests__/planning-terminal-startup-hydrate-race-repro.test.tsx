import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import type { InAppPlanningListSessionsResponse, TerminalSessionDescriptor } from '@invoker/contracts';
import { createMockInvoker, makePlanningSessionSummary, type MockInvoker } from './helpers/mock-invoker.js';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

const xtermMock = vi.hoisted(() => {
  class MockTerminal {
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
    cols = 80;
    rows = 24;
  }

  class MockFitAddon {
    fit = vi.fn();
  }

  return { Terminal: MockTerminal, FitAddon: MockFitAddon };
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

describe('planning terminal startup hydrate race repro', () => {
  let mock: MockInvoker;

  beforeEach(() => {
    mock = createMockInvoker();
    mock.install();
  });

  afterEach(() => {
    cleanup();
    mock.cleanup();
    vi.restoreAllMocks();
  });

  it('reproduces legacy chat hydrate overwriting terminal-aware startup restore', async () => {
    const legacyHydrate = deferred<InAppPlanningListSessionsResponse>();
    const terminalAwareHydrate = deferred<InAppPlanningListSessionsResponse>();
    const restoredSession = makePlanningSessionSummary({
      id: 'planning-restored-with-tmux',
      title: 'Restored terminal plan',
      status: 'still_discussing',
      draftPlanAvailable: false,
      draftPlanSummary: undefined,
      draftPlanText: undefined,
      terminalMode: 'tmux',
      terminalSessionId: 'term-restored-planning',
      terminalStatus: 'running',
      terminalOutputSnapshot: 'tmux already running\n',
    });
    const restoredList: InAppPlanningListSessionsResponse = {
      ok: true,
      sessions: [restoredSession],
    };
    const liveTerminal: TerminalSessionDescriptor = {
      sessionId: 'term-restored-planning',
      taskId: 'planning:planning-restored-with-tmux',
      kind: 'planning',
      planningSessionId: 'planning-restored-with-tmux',
      status: 'running',
      mode: 'spawn',
      attached: false,
      createdAt: '2026-07-07T00:00:03.000Z',
      outputSnapshot: 'live tmux output\n',
    };

    mock.api.planningChatList = vi
      .fn()
      .mockReturnValueOnce(legacyHydrate.promise)
      .mockReturnValueOnce(terminalAwareHydrate.promise) as any;
    mock.api.planningTerminalList = vi.fn(async () => [liveTerminal]) as any;

    render(<App />);

    await waitFor(() => {
      expect(mock.api.planningChatList).toHaveBeenCalledTimes(2);
    });

    await act(async () => {
      terminalAwareHydrate.resolve(restoredList);
      await Promise.resolve();
      legacyHydrate.resolve(restoredList);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getAllByText('Restored terminal plan').length).toBeGreaterThan(0);
    });
    expect(screen.getByRole('tab', { name: 'Chat' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByTestId('invoker-terminal-tmux-pane')).not.toBeInTheDocument();
  });
});
