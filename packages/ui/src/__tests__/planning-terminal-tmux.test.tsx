import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMockInvoker, type MockInvoker } from './helpers/mock-invoker.js';

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

const PLANNING_SESSION_ID = 'session-1';
const TERMINAL_SESSION_ID = `mock-planning-terminal-${PLANNING_SESSION_ID}`;

describe('planning terminal tmux persistence', () => {
  let mock: MockInvoker;

  beforeEach(() => {
    xtermMock.reset();
    mock = createMockInvoker();
    mock.install();
  });

  afterEach(() => {
    cleanup();
    mock.cleanup();
    vi.restoreAllMocks();
  });

  async function openPlanningTmux(): Promise<void> {
    render(<App />);

    fireEvent.click(await screen.findByTestId('sidebar-home'));
    fireEvent.click(await screen.findByRole('tab', { name: 'Tmux' }));

    await waitFor(() => {
      expect(mock.api.planningTerminalOpen).toHaveBeenCalledWith(PLANNING_SESSION_ID);
      expect(screen.getByTestId('invoker-terminal-tmux-pane')).toHaveAttribute('data-session-id', TERMINAL_SESSION_ID);
    });
  }

  function firePlanningOutput(data: string): void {
    mock.fireTerminalOutput({
      sessionId: TERMINAL_SESSION_ID,
      taskId: `planning:${PLANNING_SESSION_ID}`,
      kind: 'planning',
      planningSessionId: PLANNING_SESSION_ID,
      data,
    });
  }

  it('restores planning tmux output emitted while the terminal surface is hidden', async () => {
    await openPlanningTmux();
    expect(mock.api.planningTerminalOpen).toHaveBeenCalledTimes(1);
    xtermMock.writeLog.length = 0;

    fireEvent.click(screen.getByTestId('sidebar-planning'));
    await waitFor(() => {
      expect(screen.queryByTestId('invoker-terminal-tmux-pane')).not.toBeInTheDocument();
    });

    const hiddenOutput = 'hidden planning output while graph is open\n';
    await act(async () => {
      firePlanningOutput(hiddenOutput);
    });
    expect(xtermMock.writeLog).toHaveLength(0);

    fireEvent.click(screen.getByTestId('sidebar-home'));

    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-tmux-pane')).toHaveAttribute('data-session-id', TERMINAL_SESSION_ID);
      expect(xtermMock.writeLog).toContain(hiddenOutput);
    });
    expect(mock.api.planningTerminalOpen).toHaveBeenCalledTimes(1);
  });

  it('keeps planning tmux output across chat/tmux tab switching without reopening', async () => {
    await openPlanningTmux();
    expect(mock.api.planningTerminalOpen).toHaveBeenCalledTimes(1);
    xtermMock.writeLog.length = 0;

    const liveOutput = 'visible planning tmux output\n';
    await act(async () => {
      firePlanningOutput(liveOutput);
    });
    expect(xtermMock.writeLog.filter((entry) => entry === liveOutput)).toHaveLength(1);

    fireEvent.click(screen.getByRole('tab', { name: 'Chat' }));
    await waitFor(() => {
      expect(screen.queryByTestId('invoker-terminal-tmux-pane')).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('tab', { name: 'Tmux' }));
    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-tmux-pane')).toHaveAttribute('data-session-id', TERMINAL_SESSION_ID);
      expect(xtermMock.writeLog.filter((entry) => entry === liveOutput)).toHaveLength(2);
    });
    expect(mock.api.planningTerminalOpen).toHaveBeenCalledTimes(1);
  });
});
