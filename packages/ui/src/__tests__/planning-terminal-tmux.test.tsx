import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
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
      terminalElement.textContent = 'mock planning terminal';
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

describe('Planning terminal tmux persistence', () => {
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

  async function openPlanningTmux(): Promise<{ planningSessionId: string; terminalSessionId: string }> {
    fireEvent.click(await screen.findByTestId('sidebar-home'));
    fireEvent.click(await screen.findByRole('tab', { name: 'Tmux' }));

    await waitFor(() => {
      expect(mock.api.planningTerminalOpen).toHaveBeenCalledTimes(1);
    });
    const planningSessionId = vi.mocked(mock.api.planningTerminalOpen).mock.calls[0][0] as string;
    const terminalSessionId = `mock-planning-terminal-${planningSessionId}`;

    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-tmux-pane')).toHaveAttribute('data-session-id', terminalSessionId);
      expect(xtermMock.instances).toHaveLength(1);
    });

    return { planningSessionId, terminalSessionId };
  }

  it('restores planning tmux output captured while the terminal surface is hidden by the sidebar', async () => {
    render(<App />);
    const session = await openPlanningTmux();

    act(() => {
      mock.fireTerminalOutput({
        sessionId: session.terminalSessionId,
        taskId: `planning:${session.planningSessionId}`,
        kind: 'planning',
        planningSessionId: session.planningSessionId,
        data: 'shown before hide\n',
      });
    });

    await waitFor(() => {
      expect(xtermMock.writeLog).toEqual(['shown before hide\n']);
    });

    fireEvent.click(screen.getByTestId('sidebar-planning'));
    await waitFor(() => {
      expect(screen.queryByTestId('invoker-terminal-tmux-pane')).not.toBeInTheDocument();
    });

    act(() => {
      mock.fireTerminalOutput({
        sessionId: session.terminalSessionId,
        taskId: `planning:${session.planningSessionId}`,
        kind: 'planning',
        planningSessionId: session.planningSessionId,
        data: 'hidden while graph\n',
      });
    });

    expect(xtermMock.writeLog).toEqual(['shown before hide\n']);

    fireEvent.click(screen.getByTestId('sidebar-home'));

    await waitFor(() => {
      expect(xtermMock.instances).toHaveLength(2);
      expect(screen.getByTestId('invoker-terminal-tmux-pane')).toHaveAttribute('data-session-id', session.terminalSessionId);
      expect(xtermMock.writeLog).toContain('shown before hide\nhidden while graph\n');
    });
    expect(mock.api.planningTerminalOpen).toHaveBeenCalledTimes(1);
  });

  it('restores planning tmux output captured while the Chat tab hides tmux', async () => {
    render(<App />);
    const session = await openPlanningTmux();

    fireEvent.click(screen.getByRole('tab', { name: 'Chat' }));
    await waitFor(() => {
      expect(screen.queryByTestId('invoker-terminal-tmux-pane')).not.toBeInTheDocument();
    });

    act(() => {
      mock.fireTerminalOutput({
        sessionId: session.terminalSessionId,
        taskId: `planning:${session.planningSessionId}`,
        kind: 'planning',
        data: 'hidden behind chat\n',
      });
    });

    fireEvent.click(screen.getByRole('tab', { name: 'Tmux' }));

    await waitFor(() => {
      expect(xtermMock.instances).toHaveLength(2);
      expect(screen.getByTestId('invoker-terminal-tmux-pane')).toHaveAttribute('data-session-id', session.terminalSessionId);
      expect(xtermMock.writeLog).toContain('hidden behind chat\n');
    });
    expect(mock.api.planningTerminalOpen).toHaveBeenCalledTimes(1);
  });
});
