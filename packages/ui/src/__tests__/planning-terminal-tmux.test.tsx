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

describe('Planning terminal tmux history sync', () => {
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

  it('restores planning tmux output received while the terminal surface is hidden', async () => {
    render(<App />);

    fireEvent.click(await screen.findByTestId('sidebar-home'));
    fireEvent.click(await screen.findByRole('tab', { name: 'Tmux' }));

    await waitFor(() => {
      expect(mock.api.planningTerminalOpen).toHaveBeenCalledTimes(1);
    });
    const initialPane = await screen.findByTestId('invoker-terminal-tmux-pane');
    const sessionId = initialPane.getAttribute('data-session-id');
    expect(sessionId).toBe('mock-planning-terminal-session-1');
    expect(xtermMock.writeLog).toEqual([]);

    act(() => {
      mock.fireTerminalOutput({
        sessionId: sessionId!,
        taskId: 'planning:session-1',
        kind: 'planning',
        planningSessionId: 'session-1',
        data: 'visible before hiding\n',
      });
    });
    await waitFor(() => {
      expect(xtermMock.writeLog).toEqual(['visible before hiding\n']);
    });

    fireEvent.click(screen.getByTestId('sidebar-planning'));
    await waitFor(() => {
      expect(screen.queryByTestId('invoker-terminal-tmux-pane')).not.toBeInTheDocument();
    });

    act(() => {
      mock.fireTerminalOutput({
        sessionId: sessionId!,
        taskId: 'planning:session-1',
        kind: 'planning',
        planningSessionId: 'session-1',
        data: 'hidden via planning id\n',
      });
      mock.fireTerminalOutput({
        sessionId: sessionId!,
        taskId: 'planning:session-1',
        kind: 'planning',
        data: 'hidden via session id\n',
      });
      mock.fireTerminalOutput({
        sessionId: 'mock-session-task-alpha',
        taskId: 'task-alpha',
        kind: 'task',
        data: 'task drawer output must stay separate\n',
      });
    });
    expect(xtermMock.writeLog).toEqual(['visible before hiding\n']);

    fireEvent.click(screen.getByTestId('sidebar-home'));

    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-tmux-pane')).toHaveAttribute('data-session-id', sessionId);
      expect(xtermMock.writeLog).toContain('visible before hiding\nhidden via planning id\nhidden via session id\n');
    });
    expect(xtermMock.writeLog.join('')).not.toContain('task drawer output');
    expect(mock.api.planningTerminalOpen).toHaveBeenCalledTimes(1);
  });
});
