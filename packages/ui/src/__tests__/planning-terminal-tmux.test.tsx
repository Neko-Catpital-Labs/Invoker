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

  async function openPlanningTmux(): Promise<void> {
    fireEvent.click(await screen.findByTestId('sidebar-home'));
    fireEvent.click(screen.getByRole('tab', { name: 'Tmux' }));

    const pane = await screen.findByTestId('invoker-terminal-tmux-pane');
    await waitFor(() => {
      expect(pane.querySelector('.xterm')).not.toBeNull();
    });
  }

  it('restores planning tmux output emitted while the pane is unmounted by sidebar navigation', async () => {
    render(<App />);

    await openPlanningTmux();
    expect(mock.api.planningTerminalOpen).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('sidebar-planning'));
    await waitFor(() => {
      expect(screen.queryByTestId('invoker-terminal-tmux-pane')).not.toBeInTheDocument();
    });

    await act(async () => {
      mock.fireTerminalOutput({
        sessionId: 'mock-planning-terminal-session-1',
        taskId: 'planning:session-1',
        kind: 'planning',
        planningSessionId: 'session-1',
        data: 'hidden tmux output\n',
      });
      mock.fireTerminalOutput({
        sessionId: 'mock-planning-terminal-session-1',
        taskId: 'planning:session-1',
        kind: 'planning',
        data: 'fallback hidden output\n',
      });
    });

    expect(xtermMock.writeLog).not.toContain('hidden tmux output\n');

    fireEvent.click(screen.getByTestId('sidebar-home'));

    const restoredPane = await screen.findByTestId('invoker-terminal-tmux-pane');
    await waitFor(() => {
      expect(restoredPane.querySelector('.xterm')).not.toBeNull();
      expect(xtermMock.writeLog.join('')).toContain('hidden tmux output\nfallback hidden output\n');
    });

    expect(mock.api.planningTerminalOpen).toHaveBeenCalledTimes(1);
    expect(xtermMock.writeLog).toEqual(['hidden tmux output\nfallback hidden output\n']);
  });

  it('does not replay visible planning tmux output when the renderer snapshot updates', async () => {
    render(<App />);

    await openPlanningTmux();

    await act(async () => {
      mock.fireTerminalOutput({
        sessionId: 'mock-planning-terminal-session-1',
        taskId: 'planning:session-1',
        kind: 'planning',
        planningSessionId: 'session-1',
        data: 'visible tmux output\n',
      });
    });

    expect(xtermMock.writeLog).toEqual(['visible tmux output\n']);
  });
});
