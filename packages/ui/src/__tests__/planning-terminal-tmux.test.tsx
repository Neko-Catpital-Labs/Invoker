import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMockInvoker, makePlanningSessionSummary, type MockInvoker } from './helpers/mock-invoker.js';

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

  it('restores planning tmux output emitted while the terminal surface is hidden without reopening tmux', async () => {
    mock.api.planningChatList = vi.fn(async () => ({
      ok: true,
      sessions: [
        makePlanningSessionSummary({
          id: 'planning-hidden-output',
          title: 'Hidden output chat',
          status: 'still_discussing',
          messages: [],
          draftPlanAvailable: false,
          draftPlanSummary: undefined,
          draftPlanText: undefined,
          terminalMode: 'chat',
          terminalOutputSnapshot: '',
        }),
      ],
    })) as any;
    mock.api.planningTerminalOpen = vi.fn(async (planningSessionId: string) => ({
      opened: true,
      session: {
        sessionId: 'terminal-hidden-output',
        taskId: `planning:${planningSessionId}`,
        kind: 'planning',
        planningSessionId,
        status: 'running',
        mode: 'spawn',
        attached: false,
        createdAt: '2026-07-28T00:00:00.000Z',
        outputSnapshot: 'visible before hide\n',
      },
    })) as any;

    render(<App />);
    fireEvent.click(await screen.findByTestId('sidebar-home'));
    await waitFor(() => {
      expect(screen.getByTestId('planning-session-rail')).toHaveTextContent('Hidden output chat');
    });

    fireEvent.click(screen.getByRole('tab', { name: 'Tmux' }));
    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-tmux-pane')).toHaveAttribute(
        'data-session-id',
        'terminal-hidden-output',
      );
      expect(xtermMock.writeLog).toContain('visible before hide\n');
    });
    expect(mock.api.planningTerminalOpen).toHaveBeenCalledTimes(1);
    vi.mocked(mock.api.planningTerminalOpen).mockClear();

    fireEvent.click(screen.getByTestId('sidebar-planning'));
    await waitFor(() => {
      expect(screen.queryByTestId('invoker-terminal-tmux-pane')).not.toBeInTheDocument();
    });
    const hiddenWriteStartCount = xtermMock.writeLog.length;

    await act(async () => {
      mock.fireTerminalOutput({
        sessionId: 'terminal-hidden-output',
        taskId: 'planning:planning-hidden-output',
        kind: 'planning',
        data: 'output while hidden\n',
        planningSessionId: 'planning-hidden-output',
      });
      mock.fireTerminalOutput({
        sessionId: 'terminal-hidden-output',
        taskId: 'planning:planning-hidden-output',
        kind: 'planning',
        data: 'fallback output while hidden\n',
      });
    });
    expect(xtermMock.writeLog).toHaveLength(hiddenWriteStartCount);

    fireEvent.click(screen.getByTestId('sidebar-home'));
    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-tmux-pane')).toHaveAttribute(
        'data-session-id',
        'terminal-hidden-output',
      );
      expect(xtermMock.writeLog).toContain([
        'visible before hide',
        'output while hidden',
        'fallback output while hidden',
        '',
      ].join('\n'));
    });
    expect(mock.api.planningTerminalOpen).not.toHaveBeenCalled();
  });
});
