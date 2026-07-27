import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { InAppPlanningListSessionsResponse, TerminalSessionDescriptor } from '@invoker/contracts';
import { createMockInvoker, makePlanningSessionSummary, type MockInvoker } from './helpers/mock-invoker.js';

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

// Adverse repro: startup has a list-only restore effect and a list+terminal
// hydrate effect. This pins the ordering where stale chat-list data resolves
// after the hydrated data so future changes cannot drop the live tmux descriptor.
describe('planning terminal startup hydrate race repro', () => {
  let mock: MockInvoker;

  beforeEach(() => {
    mock = createMockInvoker();
    mock.install();
  });

  afterEach(() => {
    mock.cleanup();
  });

  it('keeps the live planning tmux session when stale chat-list restore lands last', async () => {
    const listOnlyRestore = deferred<InAppPlanningListSessionsResponse>();
    const hydratedRestore = deferred<InAppPlanningListSessionsResponse>();
    const terminalRestore = deferred<TerminalSessionDescriptor[]>();
    const persistedChat = makePlanningSessionSummary({
      id: 'planning-race',
      title: 'Hydrate race',
      status: 'still_discussing',
      presetKey: 'codex',
      draftPlanAvailable: false,
      draftPlanSummary: undefined,
      draftPlanText: undefined,
      terminalMode: 'tmux',
      messages: [
        { id: 1, role: 'user', text: 'Restore my tmux planning pane.', createdAt: '2026-07-07T00:00:01.000Z' },
      ],
    });
    const liveTerminal: TerminalSessionDescriptor = {
      sessionId: 'live-planning-terminal',
      taskId: 'planning:planning-race',
      kind: 'planning',
      planningSessionId: 'planning-race',
      status: 'running',
      mode: 'spawn',
      attached: false,
      createdAt: '2026-07-07T00:00:02.000Z',
      outputSnapshot: 'restored tmux output\n',
    };

    mock.api.planningChatList = vi
      .fn()
      .mockImplementationOnce(() => listOnlyRestore.promise)
      .mockImplementationOnce(() => hydratedRestore.promise) as any;
    mock.api.planningTerminalList = vi.fn(() => terminalRestore.promise) as any;

    render(<App />);
    fireEvent.click(await screen.findByTestId('sidebar-home'));
    await waitFor(() => {
      expect(mock.api.planningChatList).toHaveBeenCalledTimes(2);
      expect(mock.api.planningTerminalList).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      hydratedRestore.resolve({ ok: true, sessions: [persistedChat] });
      terminalRestore.resolve([liveTerminal]);
      listOnlyRestore.resolve({ ok: true, sessions: [persistedChat] });
      await Promise.resolve();
    });

    expect(await screen.findByTestId('invoker-terminal-tmux-pane')).toHaveAttribute(
      'data-session-id',
      'live-planning-terminal',
    );
  });
});
