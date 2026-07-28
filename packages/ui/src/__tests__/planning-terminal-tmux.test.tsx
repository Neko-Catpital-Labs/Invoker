import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
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

  it('restores planning tmux output emitted while the planning terminal surface is hidden', async () => {
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
          terminalMode: 'tmux',
          terminalSessionId: 'term-hidden-output',
          terminalStatus: 'running',
          terminalOutputSnapshot: 'VISIBLE_BEFORE_HIDE\n',
          updatedAt: '2026-07-28T00:00:00.000Z',
        }),
      ],
    })) as any;

    render(<App />);
    fireEvent.click(await screen.findByTestId('sidebar-home'));

    await waitFor(() => expect(mock.api.onTerminalOutput).toHaveBeenCalled());
    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-tmux-pane')).toHaveAttribute(
        'data-session-id',
        'term-hidden-output',
      );
      expect(xtermMock.writeLog).toContain('VISIBLE_BEFORE_HIDE\n');
    });

    fireEvent.click(screen.getByTestId('sidebar-planning'));
    await screen.findByRole('heading', { name: 'Plan graph' });
    await waitFor(() => {
      expect(screen.queryByTestId('invoker-terminal-tmux-pane')).not.toBeInTheDocument();
    });

    await act(async () => {
      mock.fireTerminalOutput({
        sessionId: 'rotated-terminal-id-from-event',
        taskId: 'planning:plan-hidden-output',
        kind: 'planning',
        planningSessionId: 'plan-hidden-output',
        data: 'HIDDEN_MATCHED_BY_PLANNING_ID\n',
      });
      mock.fireTerminalOutput({
        sessionId: 'term-hidden-output',
        taskId: 'planning:plan-hidden-output',
        kind: 'planning',
        data: 'HIDDEN_MATCHED_BY_TERMINAL_ID\n',
      });
    });
    expect(xtermMock.writeLog.some((entry) => entry.includes('HIDDEN_MATCHED_BY_PLANNING_ID'))).toBe(false);
    expect(xtermMock.writeLog.some((entry) => entry.includes('HIDDEN_MATCHED_BY_TERMINAL_ID'))).toBe(false);

    fireEvent.click(screen.getByTestId('sidebar-home'));

    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-tmux-pane')).toHaveAttribute(
        'data-session-id',
        'term-hidden-output',
      );
      expect(xtermMock.writeLog.some((entry) => entry.includes('HIDDEN_MATCHED_BY_PLANNING_ID\n'))).toBe(true);
      expect(xtermMock.writeLog.some((entry) => entry.includes('HIDDEN_MATCHED_BY_TERMINAL_ID\n'))).toBe(true);
    });
    expect(mock.api.planningTerminalOpen).not.toHaveBeenCalled();
  });
});
