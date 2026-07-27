import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMockInvoker, type MockInvoker } from './helpers/mock-invoker.js';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

const xtermMock = vi.hoisted(() => {
  type DataHandler = (data: string) => void;

  const instances: MockTerminal[] = [];
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
  }

  return {
    Terminal: MockTerminal,
    FitAddon: MockFitAddon,
    instances,
    writeLog,
    reset: () => {
      instances.length = 0;
      writeLog.length = 0;
    },
  };
});

vi.mock('xterm', () => ({ Terminal: xtermMock.Terminal }));
vi.mock('xterm-addon-fit', () => ({ FitAddon: xtermMock.FitAddon }));

const { App } = await import('../App.js');

const PLANNING_SESSION_ID = 'session-1';
const TERMINAL_SESSION_ID = `mock-planning-terminal-${PLANNING_SESSION_ID}`;

describe('Planning terminal tmux history', () => {
  let mock: MockInvoker;

  beforeEach(() => {
    xtermMock.reset();
    mock = createMockInvoker();
    mock.install();
  });

  afterEach(() => {
    mock.cleanup();
  });

  async function openPlanningTmux(): Promise<void> {
    render(<App />);

    fireEvent.click(await screen.findByRole('tab', { name: 'Tmux' }));

    await waitFor(() => {
      expect(mock.api.planningTerminalOpen).toHaveBeenCalledWith(PLANNING_SESSION_ID);
      expect(screen.getByTestId('invoker-terminal-tmux-pane')).toHaveAttribute('data-session-id', TERMINAL_SESSION_ID);
    });
  }

  function emitPlanningOutput(data: string): void {
    act(() => {
      mock.fireTerminalOutput({
        sessionId: TERMINAL_SESSION_ID,
        taskId: `planning:${PLANNING_SESSION_ID}`,
        kind: 'planning',
        planningSessionId: PLANNING_SESSION_ID,
        data,
      });
    });
  }

  it('restores planning tmux output emitted while the planning terminal surface is hidden', async () => {
    await openPlanningTmux();
    expect(mock.api.planningTerminalOpen).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('sidebar-planning'));
    await waitFor(() => {
      expect(screen.queryByTestId('invoker-terminal-tmux-pane')).not.toBeInTheDocument();
      expect(screen.getByTestId('sidebar-planning')).toHaveAttribute('aria-current', 'page');
    });

    emitPlanningOutput('hidden tmux output\n');
    act(() => {
      mock.fireTerminalOutput({
        sessionId: 'task-terminal-1',
        taskId: 'task-1',
        kind: 'task',
        data: 'task drawer output\n',
      });
    });
    expect(xtermMock.writeLog).toEqual([]);

    fireEvent.click(screen.getByTestId('sidebar-home'));

    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-tmux-pane')).toHaveAttribute('data-session-id', TERMINAL_SESSION_ID);
      expect(xtermMock.writeLog.at(-1)).toBe('hidden tmux output\n');
    });
    expect(xtermMock.writeLog.join('')).not.toContain('task drawer output');
    expect(mock.api.planningTerminalOpen).toHaveBeenCalledTimes(1);
  });

  it('preserves planning tmux output across chat/tmux tab switches without replaying into the mounted pane', async () => {
    await openPlanningTmux();

    emitPlanningOutput('visible tmux output\n');
    await waitFor(() => {
      expect(xtermMock.writeLog).toEqual(['visible tmux output\n']);
    });

    fireEvent.click(screen.getByRole('tab', { name: 'Chat' }));
    await waitFor(() => {
      expect(screen.queryByTestId('invoker-terminal-tmux-pane')).not.toBeInTheDocument();
    });

    emitPlanningOutput('chat-hidden tmux output\n');

    fireEvent.click(screen.getByRole('tab', { name: 'Tmux' }));

    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-tmux-pane')).toHaveAttribute('data-session-id', TERMINAL_SESSION_ID);
      expect(xtermMock.writeLog.at(-1)).toBe('visible tmux output\nchat-hidden tmux output\n');
    });
    expect(mock.api.planningTerminalOpen).toHaveBeenCalledTimes(1);
  });
});
