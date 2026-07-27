import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
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

async function openPlanningTmux(mock: MockInvoker): Promise<string> {
  render(<App />);
  fireEvent.click(await screen.findByTestId('sidebar-home'));
  fireEvent.click(await screen.findByRole('tab', { name: 'Tmux' }));

  await waitFor(() => {
    expect(mock.api.planningTerminalOpen).toHaveBeenCalledTimes(1);
  });
  const pane = await screen.findByTestId('invoker-terminal-tmux-pane');
  await waitFor(() => {
    expect(xtermMock.instances).toHaveLength(1);
  });
  const sessionId = pane.dataset.sessionId;
  if (!sessionId) throw new Error('Planning tmux pane did not expose a session id.');
  return sessionId;
}

describe('Planning terminal tmux', () => {
  let mock: MockInvoker;

  beforeEach(() => {
    xtermMock.reset();
    mock = createMockInvoker();
    mock.install();
  });

  afterEach(() => {
    mock.cleanup();
    vi.restoreAllMocks();
  });

  it('reuses the planning tmux session across chat and tmux tab switches', async () => {
    const sessionId = await openPlanningTmux(mock);

    fireEvent.click(screen.getByRole('tab', { name: 'Chat' }));
    await waitFor(() => {
      expect(screen.queryByTestId('invoker-terminal-tmux-pane')).not.toBeInTheDocument();
    });

    act(() => {
      mock.fireTerminalOutput({
        sessionId,
        taskId: 'planning:session-1',
        kind: 'planning',
        planningSessionId: 'session-1',
        data: 'output while chat tab is active\n',
      });
    });
    expect(xtermMock.writeLog).toEqual([]);

    fireEvent.click(screen.getByRole('tab', { name: 'Tmux' }));

    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-tmux-pane')).toHaveAttribute('data-session-id', sessionId);
      expect(xtermMock.writeLog).toContain('output while chat tab is active\n');
    });
    expect(mock.api.planningTerminalOpen).toHaveBeenCalledTimes(1);
  });

  it('restores planning tmux output emitted while the planning terminal surface is hidden', async () => {
    const sessionId = await openPlanningTmux(mock);

    act(() => {
      mock.fireTerminalOutput({
        sessionId,
        taskId: 'planning:session-1',
        kind: 'planning',
        planningSessionId: 'session-1',
        data: 'visible planning output\n',
      });
    });

    await waitFor(() => {
      expect(xtermMock.writeLog).toEqual(['visible planning output\n']);
    });

    fireEvent.click(screen.getByTestId('sidebar-planning'));
    await waitFor(() => {
      expect(screen.queryByTestId('invoker-terminal-tmux-pane')).not.toBeInTheDocument();
    });

    act(() => {
      mock.fireTerminalOutput({
        sessionId,
        taskId: 'planning:session-1',
        kind: 'planning',
        planningSessionId: 'session-1',
        data: 'hidden planning output\n',
      });
    });
    expect(xtermMock.writeLog).toEqual(['visible planning output\n']);

    fireEvent.click(screen.getByTestId('sidebar-home'));

    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-tmux-pane')).toHaveAttribute('data-session-id', sessionId);
      expect(xtermMock.writeLog.at(-1)).toBe('visible planning output\nhidden planning output\n');
    });
    expect(mock.api.planningTerminalOpen).toHaveBeenCalledTimes(1);
  });
});
