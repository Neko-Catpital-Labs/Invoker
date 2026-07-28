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

describe('planning terminal tmux history', () => {
  let mock: MockInvoker;

  beforeEach(() => {
    mock = createMockInvoker();
    mock.install();
  });

  afterEach(() => {
    mock.cleanup();
    xtermMock.reset();
  });

  async function openPlanningTmux(): Promise<string> {
    fireEvent.click(await screen.findByTestId('sidebar-home'));
    fireEvent.click(await screen.findByRole('tab', { name: 'Tmux' }));

    await waitFor(() => {
      expect(mock.api.planningTerminalOpen).toHaveBeenCalledTimes(1);
    });

    const terminalSessionId = 'mock-planning-terminal-session-1';
    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-tmux-pane')).toHaveAttribute('data-session-id', terminalSessionId);
    });
    return terminalSessionId;
  }

  it('restores planning tmux output received while the pane is unmounted during a surface round trip', async () => {
    render(<App />);
    const terminalSessionId = await openPlanningTmux();
    const hiddenOutput = 'TMUX_OUTPUT_WHILE_GRAPH_VISIBLE\n';

    // Home is the planning-chat surface in the current navigation; Plan graph
    // unmounts the planning terminal pane and reproduces the history-loss path.
    fireEvent.click(screen.getByTestId('sidebar-planning'));
    await screen.findByRole('heading', { name: 'Plan graph' });
    await waitFor(() => {
      expect(screen.queryByTestId('invoker-terminal-tmux-pane')).not.toBeInTheDocument();
    });

    const writeCountBeforeHiddenOutput = xtermMock.writeLog.length;
    await act(async () => {
      mock.fireTerminalOutput({
        sessionId: terminalSessionId,
        taskId: 'planning:session-1',
        kind: 'planning',
        planningSessionId: 'session-1',
        data: hiddenOutput,
      });
    });
    expect(xtermMock.writeLog).toHaveLength(writeCountBeforeHiddenOutput);

    fireEvent.click(screen.getByTestId('sidebar-home'));
    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-tmux-pane')).toHaveAttribute('data-session-id', terminalSessionId);
      expect(xtermMock.writeLog.filter((entry) => entry === hiddenOutput)).toHaveLength(1);
    });
    expect(mock.api.planningTerminalOpen).toHaveBeenCalledTimes(1);
  });
});
