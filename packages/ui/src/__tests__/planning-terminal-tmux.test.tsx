import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
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
      terminalElement.textContent = 'mock terminal';
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
    refresh = vi.fn();
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

describe('planning terminal tmux persistence', () => {
  let mock: MockInvoker;

  beforeEach(() => {
    mock = createMockInvoker();
    mock.install();
  });

  afterEach(() => {
    mock.cleanup();
    xtermMock.reset();
  });

  it('restores planning tmux output emitted while the terminal surface is hidden without reopening', async () => {
    mock.api.planningChatList = vi.fn(async () => ({
      ok: true,
      sessions: [
        makePlanningSessionSummary({
          id: 'plan-hidden-output',
          title: 'Hidden tmux session',
          status: 'still_discussing',
          draftPlanAvailable: false,
          terminalMode: 'tmux',
          terminalSessionId: 'term-hidden-output',
          terminalStatus: 'running',
          terminalOutputSnapshot: '',
        }),
      ],
    })) as any;

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-tmux-pane')).toHaveAttribute(
        'data-session-id',
        'term-hidden-output',
      );
    });
    expect(mock.api.planningTerminalOpen).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('sidebar-planning'));
    await waitFor(() => {
      expect(screen.getByTestId('sidebar-planning')).toHaveAttribute('aria-current', 'page');
    });
    expect(screen.queryByTestId('invoker-terminal-tmux-pane')).not.toBeInTheDocument();

    await act(async () => {
      mock.fireTerminalOutput({
        sessionId: 'term-hidden-output',
        taskId: 'planning:plan-hidden-output',
        kind: 'planning',
        planningSessionId: 'plan-hidden-output',
        data: 'HIDDEN_TMUX_OUTPUT\n',
      });
      mock.fireTerminalOutput({
        sessionId: 'term-hidden-output',
        taskId: 'planning:plan-hidden-output',
        kind: 'planning',
        data: 'HIDDEN_TMUX_OUTPUT_BY_SESSION\n',
      });
    });
    expect(xtermMock.writeLog.filter((entry) => entry.includes('HIDDEN_TMUX_OUTPUT\n'))).toHaveLength(0);
    expect(xtermMock.writeLog.filter((entry) => entry.includes('HIDDEN_TMUX_OUTPUT_BY_SESSION\n'))).toHaveLength(0);

    fireEvent.click(screen.getByTestId('sidebar-home'));

    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-tmux-pane')).toHaveAttribute(
        'data-session-id',
        'term-hidden-output',
      );
      expect(xtermMock.writeLog.filter((entry) => entry.includes('HIDDEN_TMUX_OUTPUT\n'))).toHaveLength(1);
      expect(xtermMock.writeLog.filter((entry) => entry.includes('HIDDEN_TMUX_OUTPUT_BY_SESSION\n'))).toHaveLength(1);
    });
    expect(mock.api.planningTerminalOpen).not.toHaveBeenCalled();
  });
});
