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

async function openPlanningTmux(mock: MockInvoker): Promise<void> {
  fireEvent.click(await screen.findByTestId('sidebar-home'));
  fireEvent.click(await screen.findByRole('tab', { name: 'Tmux' }));

  await waitFor(() => {
    expect(mock.api.planningTerminalOpen).toHaveBeenCalledWith('session-1');
  });
  await waitFor(() => {
    expect(screen.getByTestId('invoker-terminal-tmux-pane')).toHaveAttribute(
      'data-session-id',
      'mock-planning-terminal-session-1',
    );
  });
}

function firePlanningOutput(mock: MockInvoker, data: string, overrides: { planningSessionId?: string } = {}): void {
  mock.fireTerminalOutput({
    sessionId: 'mock-planning-terminal-session-1',
    taskId: 'planning:session-1',
    kind: 'planning',
    planningSessionId: overrides.planningSessionId ?? 'session-1',
    data,
  });
}

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

  it('replays the planning tmux snapshot when switching between Chat and Tmux tabs', async () => {
    render(<App />);
    await openPlanningTmux(mock);

    await act(async () => {
      firePlanningOutput(mock, 'visible tmux output\n');
    });

    await waitFor(() => {
      expect(xtermMock.writeLog).toEqual(['visible tmux output\n']);
    });
    expect(mock.api.planningTerminalOpen).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('tab', { name: 'Chat' }));
    await waitFor(() => {
      expect(screen.queryByTestId('invoker-terminal-tmux-pane')).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('tab', { name: 'Tmux' }));

    await waitFor(() => {
      expect(xtermMock.writeLog).toEqual(['visible tmux output\n', 'visible tmux output\n']);
    });
    expect(mock.api.planningTerminalOpen).toHaveBeenCalledTimes(1);
  });

  it('restores planning tmux output produced while the planning terminal surface is hidden', async () => {
    render(<App />);
    await openPlanningTmux(mock);
    expect(mock.api.planningTerminalOpen).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('sidebar-planning'));
    await waitFor(() => {
      expect(screen.queryByTestId('invoker-terminal-tmux-pane')).not.toBeInTheDocument();
    });
    expect(xtermMock.writeLog).toEqual([]);

    await act(async () => {
      firePlanningOutput(mock, 'hidden tmux output\n');
    });
    expect(xtermMock.writeLog).toEqual([]);

    fireEvent.click(screen.getByTestId('sidebar-home'));

    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-tmux-pane')).toHaveAttribute(
        'data-session-id',
        'mock-planning-terminal-session-1',
      );
      expect(xtermMock.writeLog).toContain('hidden tmux output\n');
    });
    expect(mock.api.planningTerminalOpen).toHaveBeenCalledTimes(1);
  });
});
