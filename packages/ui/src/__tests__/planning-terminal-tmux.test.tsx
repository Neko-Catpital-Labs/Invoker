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

  it('restores planning tmux output emitted while the planning pane is unmounted', async () => {
    render(<App />);

    fireEvent.click(await screen.findByRole('tab', { name: 'Tmux' }));

    await waitFor(() => {
      expect(mock.api.planningTerminalOpen).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('invoker-terminal-tmux-pane')).toBeInTheDocument();
      expect(xtermMock.instances).toHaveLength(1);
    });

    fireEvent.click(screen.getByTestId('sidebar-planning'));
    await waitFor(() => {
      expect(screen.getByTestId('sidebar-planning')).toHaveAttribute('aria-current', 'page');
      expect(screen.queryByTestId('invoker-terminal-tmux-pane')).not.toBeInTheDocument();
    });

    await act(async () => {
      mock.fireTerminalOutput({
        sessionId: 'mock-planning-terminal-session-1',
        taskId: 'planning:session-1',
        kind: 'planning',
        planningSessionId: 'session-1',
        data: 'hidden planner output\n',
      });
      mock.fireTerminalOutput({
        sessionId: 'mock-planning-terminal-session-1',
        taskId: 'planning:session-1',
        kind: 'planning',
        data: 'fallback matched output\n',
      });
    });
    expect(xtermMock.writeLog.join('')).not.toContain('hidden planner output\n');
    expect(xtermMock.writeLog.join('')).not.toContain('fallback matched output\n');

    fireEvent.click(screen.getByTestId('sidebar-home'));

    await waitFor(() => {
      expect(screen.getByTestId('sidebar-home')).toHaveAttribute('aria-current', 'page');
      expect(screen.getByTestId('invoker-terminal-tmux-pane')).toBeInTheDocument();
      expect(xtermMock.instances).toHaveLength(2);
      expect(xtermMock.writeLog.join('')).toContain('hidden planner output\n');
      expect(xtermMock.writeLog.join('')).toContain('fallback matched output\n');
    });
    expect(mock.api.planningTerminalOpen).toHaveBeenCalledTimes(1);
  });
});
