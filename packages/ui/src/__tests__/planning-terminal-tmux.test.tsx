import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { createMockInvoker, makePlanningSessionSummary, type MockInvoker } from './helpers/mock-invoker.js';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

const xtermMock = vi.hoisted(() => {
  type DataHandler = (data: string) => void;

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
  }

  class MockFitAddon {
    fit = vi.fn();
  }

  return {
    Terminal: MockTerminal,
    FitAddon: MockFitAddon,
    writeLog,
    reset: () => {
      writeLog.length = 0;
    },
  };
});

vi.mock('xterm', () => ({ Terminal: xtermMock.Terminal }));
vi.mock('xterm-addon-fit', () => ({ FitAddon: xtermMock.FitAddon }));

const { App } = await import('../App.js');

describe('planning terminal tmux', () => {
  let mock: MockInvoker;

  beforeEach(() => {
    mock = createMockInvoker();
    mock.install();
  });

  afterEach(() => {
    mock.cleanup();
    xtermMock.reset();
  });

  it('restores planning tmux output emitted while the terminal surface is hidden', async () => {
    mock.api.planningChatList = vi.fn(async () => ({
      ok: true,
      sessions: [
        makePlanningSessionSummary({
          id: 'plan-hidden-output',
          title: 'Hidden output tmux session',
          status: 'still_discussing',
          draftPlanAvailable: false,
          draftPlanSummary: undefined,
          draftPlanText: undefined,
          terminalMode: 'chat',
          terminalSessionId: undefined,
          terminalOutputSnapshot: '',
        }),
      ],
    })) as any;
    mock.api.planningTerminalOpen = vi.fn(async (planningSessionId: string) => ({
      opened: true,
      session: {
        sessionId: 'term-hidden-output',
        taskId: `planning:${planningSessionId}`,
        kind: 'planning',
        planningSessionId,
        status: 'running',
        mode: 'spawn',
        attached: false,
        createdAt: '2026-07-28T00:00:00.000Z',
        outputSnapshot: '',
      },
    })) as any;

    render(<App />);
    await waitFor(() => {
      expect(screen.getAllByText('Hidden output tmux session').length).toBeGreaterThan(0);
    });

    fireEvent.click(screen.getByRole('tab', { name: 'Tmux' }));

    await waitFor(() => {
      expect(mock.api.planningTerminalOpen).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('invoker-terminal-tmux-pane')).toHaveAttribute(
        'data-session-id',
        'term-hidden-output',
      );
    });

    fireEvent.click(screen.getByTestId('sidebar-planning'));

    await waitFor(() => {
      expect(screen.queryByTestId('invoker-terminal-tmux-pane')).not.toBeInTheDocument();
    });

    await act(async () => {
      mock.fireTerminalOutput({
        sessionId: 'term-hidden-output',
        taskId: 'planning:plan-hidden-output',
        kind: 'planning',
        planningSessionId: 'plan-hidden-output',
        data: 'HIDDEN_TMUX_OUTPUT\n',
      });
    });

    expect(xtermMock.writeLog).not.toContain('HIDDEN_TMUX_OUTPUT\n');

    fireEvent.click(screen.getByTestId('sidebar-home'));

    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-tmux-pane')).toHaveAttribute(
        'data-session-id',
        'term-hidden-output',
      );
      expect(xtermMock.writeLog).toContain('HIDDEN_TMUX_OUTPUT\n');
      expect(mock.api.planningTerminalOpen).toHaveBeenCalledTimes(1);
    });
  });
});
