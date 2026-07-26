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

  async function openPlanningTmux(): Promise<string> {
    render(<App />);
    fireEvent.click(await screen.findByTestId('sidebar-home'));
    fireEvent.click(await screen.findByRole('tab', { name: 'Tmux' }));

    await waitFor(() => {
      expect(mock.api.planningTerminalOpen).toHaveBeenCalledTimes(1);
    });

    const pane = await screen.findByTestId('invoker-terminal-tmux-pane');
    const sessionId = pane.getAttribute('data-session-id');
    if (!sessionId) throw new Error('Expected planning tmux pane to expose a session id');

    await waitFor(() => {
      expect(xtermMock.instances).toHaveLength(1);
    });

    return sessionId;
  }

  it('restores planning tmux output emitted while the terminal surface is hidden', async () => {
    const sessionId = await openPlanningTmux();

    act(() => {
      mock.fireTerminalOutput({
        sessionId,
        taskId: 'planning:session-1',
        kind: 'planning',
        planningSessionId: 'session-1',
        data: 'visible before hide\n',
      });
    });

    await waitFor(() => {
      expect(xtermMock.writeLog).toEqual(['visible before hide\n']);
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
        data: 'hidden while away\n',
      });
    });

    act(() => {
      mock.fireTerminalOutput({
        sessionId,
        taskId: 'planning:session-1',
        kind: 'planning',
        data: 'hidden fallback match\n',
      });
      mock.fireTerminalOutput({
        sessionId,
        taskId: 'task-with-overlapping-session-id',
        kind: 'task',
        data: 'task output ignored\n',
      });
    });

    expect(xtermMock.writeLog).toEqual(['visible before hide\n']);

    fireEvent.click(screen.getByTestId('sidebar-home'));

    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-tmux-pane')).toHaveAttribute('data-session-id', sessionId);
      expect(xtermMock.instances).toHaveLength(2);
      expect(xtermMock.writeLog).toEqual([
        'visible before hide\n',
        'visible before hide\nhidden while away\nhidden fallback match\n',
      ]);
    });
    expect(mock.api.planningTerminalOpen).toHaveBeenCalledTimes(1);
  });
});
