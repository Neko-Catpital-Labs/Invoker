import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { TerminalOutputEvent, TerminalSessionDescriptor } from '@invoker/contracts';
import { createMockInvoker, makePlanningSessionSummary, type MockInvoker } from './helpers/mock-invoker.js';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

const xtermMock = vi.hoisted(() => {
  type DataHandler = (data: string) => void;

  const instances: MockTerminal[] = [];
  const fitInstances: MockFitAddon[] = [];
  const writeLog: string[] = [];

  class MockTerminal {
    cols = 80;
    rows = 24;
    dataHandler: DataHandler | null = null;
    loadAddon = vi.fn();
    open = vi.fn((host: HTMLElement) => {
      const terminalElement = document.createElement('div');
      terminalElement.className = 'xterm';
      terminalElement.textContent = 'mock planning tmux';
      host.appendChild(terminalElement);
    });
    write = vi.fn((data: string) => {
      writeLog.push(data);
    });
    onData = vi.fn((cb: DataHandler) => {
      this.dataHandler = cb;
      return { dispose: vi.fn() };
    });
    focus = vi.fn();
    dispose = vi.fn();

    constructor() {
      instances.push(this);
    }
  }

  class MockFitAddon {
    fit = vi.fn();

    constructor() {
      fitInstances.push(this);
    }
  }

  return {
    Terminal: MockTerminal,
    FitAddon: MockFitAddon,
    instances,
    fitInstances,
    writeLog,
    reset: () => {
      instances.length = 0;
      fitInstances.length = 0;
      writeLog.length = 0;
    },
  };
});

vi.mock('xterm', () => ({ Terminal: xtermMock.Terminal }));
vi.mock('xterm-addon-fit', () => ({ FitAddon: xtermMock.FitAddon }));

const { App } = await import('../App.js');

describe('planning tmux terminal history across sidebar surface switches', () => {
  let mock: MockInvoker;

  beforeEach(() => {
    xtermMock.reset();
    mock = createMockInvoker();
    mock.install();
  });

  afterEach(() => {
    mock.cleanup();
    xtermMock.reset();
    vi.restoreAllMocks();
  });

  function planningTerminalEvent(data: string): TerminalOutputEvent {
    return {
      sessionId: 'planning-terminal-saved-tmux',
      taskId: 'planning:saved-tmux',
      kind: 'planning',
      planningSessionId: 'saved-tmux',
      data,
    };
  }

  it('replays tmux output emitted while the planning terminal is hidden by another sidebar surface', async () => {
    const restoredSnapshot = 'restored before switch\n';
    const liveSession: TerminalSessionDescriptor = {
      sessionId: 'planning-terminal-saved-tmux',
      taskId: 'planning:saved-tmux',
      kind: 'planning',
      planningSessionId: 'saved-tmux',
      status: 'running',
      mode: 'spawn',
      attached: false,
      createdAt: '2026-07-07T00:00:03.000Z',
      outputSnapshot: restoredSnapshot,
    };

    mock.api.planningChatList = vi.fn(async () => ({
      ok: true,
      sessions: [
        makePlanningSessionSummary({
          id: 'saved-tmux',
          title: 'Saved tmux plan',
          status: 'still_discussing',
          draftPlanAvailable: false,
          terminalMode: 'tmux',
          terminalSessionId: liveSession.sessionId,
          terminalStatus: 'running',
          terminalOutputSnapshot: restoredSnapshot,
          terminalUpdatedAt: liveSession.createdAt,
        }),
      ],
    }));
    mock.api.planningTerminalList = vi.fn(async () => [liveSession]);

    render(<App />);

    const initialPane = await screen.findByTestId('invoker-terminal-tmux-pane');
    expect(initialPane).toHaveAttribute('data-session-id', liveSession.sessionId);
    await waitFor(() => {
      expect(xtermMock.writeLog.join('')).toContain(restoredSnapshot);
    });

    fireEvent.click(screen.getByTestId('sidebar-planning'));
    await waitFor(() => {
      expect(screen.queryByTestId('invoker-terminal-tmux-pane')).not.toBeInTheDocument();
    });

    const writesBeforeHiddenOutput = [...xtermMock.writeLog];
    await act(async () => {
      mock.fireTerminalOutput(planningTerminalEvent('hidden while graph surface is active\n'));
      mock.fireTerminalOutput({
        sessionId: liveSession.sessionId,
        taskId: liveSession.taskId,
        kind: 'planning',
        data: 'fallback matched by terminal session id\n',
      });
    });
    expect(xtermMock.writeLog).toEqual(writesBeforeHiddenOutput);

    fireEvent.click(screen.getByTestId('sidebar-home'));

    const restoredPane = await screen.findByTestId('invoker-terminal-tmux-pane');
    expect(restoredPane).toHaveAttribute('data-session-id', liveSession.sessionId);
    await waitFor(() => {
      expect(xtermMock.instances.length).toBeGreaterThanOrEqual(2);
      expect(xtermMock.writeLog.join('')).toContain(
        [
          restoredSnapshot,
          'hidden while graph surface is active\n',
          'fallback matched by terminal session id\n',
        ].join(''),
      );
    });
    expect(mock.api.planningTerminalOpen).not.toHaveBeenCalled();
  });
});
