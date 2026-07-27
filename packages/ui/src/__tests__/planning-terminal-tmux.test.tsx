import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMockInvoker, makePlanningSessionSummary, type MockInvoker } from './helpers/mock-invoker.js';
import type { TerminalSessionDescriptor } from '@invoker/contracts';

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

function makePlanningTerminalSession(
  planningSessionId: string,
  overrides: Partial<TerminalSessionDescriptor> = {},
): TerminalSessionDescriptor {
  return {
    sessionId: `mock-planning-terminal-${planningSessionId}`,
    taskId: `planning:${planningSessionId}`,
    kind: 'planning',
    planningSessionId,
    status: 'running',
    mode: 'spawn',
    attached: false,
    createdAt: '2026-07-07T00:00:00.000Z',
    ...overrides,
  };
}

describe('Planning terminal tmux history', () => {
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

  it('restores planning tmux output emitted while the planning terminal surface is hidden', async () => {
    const planningSessionId = 'saved-planning-tmux';
    const initialOutput = 'visible before hide\n';
    const visibleOutput = 'visible live before hide\n';
    const hiddenOutputByPlanningId = 'hidden tmux line by planning id\n';
    const hiddenOutputBySessionId = 'hidden tmux line by session id\n';
    const ignoredTaskOutput = 'task drawer line should not replay\n';
    const terminalSession = makePlanningTerminalSession(planningSessionId, {
      sessionId: 'planning-tmux-1',
      outputSnapshot: initialOutput,
    });

    mock.api.planningChatList = vi.fn(async () => ({
      ok: true,
      sessions: [
        makePlanningSessionSummary({
          id: planningSessionId,
          title: 'Planning tmux history',
          status: 'still_discussing',
          draftPlanAvailable: false,
          messages: [],
        }),
      ],
    }));
    mock.api.planningTerminalOpen = vi.fn(async () => ({
      opened: true,
      session: terminalSession,
    }));

    render(<App />);

    await waitFor(() => {
      expect(screen.getAllByText('Planning tmux history').length).toBeGreaterThan(0);
    });

    fireEvent.click(await screen.findByRole('tab', { name: 'Tmux' }));

    await waitFor(() => {
      expect(mock.api.planningTerminalOpen).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('invoker-terminal-tmux-pane')).toHaveAttribute('data-session-id', terminalSession.sessionId);
      expect(xtermMock.writeLog).toContain(initialOutput);
    });

    act(() => {
      mock.fireTerminalOutput({
        kind: 'planning',
        planningSessionId,
        sessionId: terminalSession.sessionId,
        taskId: terminalSession.taskId,
        data: visibleOutput,
      });
    });
    await waitFor(() => {
      expect(xtermMock.writeLog.filter((write) => write.includes(visibleOutput))).toHaveLength(1);
    });

    const writesBeforeHiddenOutput = xtermMock.writeLog.length;

    fireEvent.click(screen.getByTestId('sidebar-planning'));
    await waitFor(() => {
      expect(screen.queryByTestId('invoker-terminal-tmux-pane')).not.toBeInTheDocument();
    });

    act(() => {
      mock.fireTerminalOutput({
        kind: 'planning',
        planningSessionId,
        sessionId: terminalSession.sessionId,
        taskId: terminalSession.taskId,
        data: hiddenOutputByPlanningId,
      });
      mock.fireTerminalOutput({
        kind: 'planning',
        sessionId: terminalSession.sessionId,
        taskId: terminalSession.taskId,
        data: hiddenOutputBySessionId,
      });
      mock.fireTerminalOutput({
        kind: 'task',
        sessionId: terminalSession.sessionId,
        taskId: terminalSession.taskId,
        data: ignoredTaskOutput,
      });
    });
    expect(xtermMock.writeLog).toHaveLength(writesBeforeHiddenOutput);

    fireEvent.click(screen.getByTestId('sidebar-home'));

    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-tmux-pane')).toHaveAttribute('data-session-id', terminalSession.sessionId);
      const replayedWrites = xtermMock.writeLog.slice(writesBeforeHiddenOutput);
      expect(replayedWrites.some((write) => write.includes(hiddenOutputByPlanningId))).toBe(true);
      expect(replayedWrites.some((write) => write.includes(hiddenOutputBySessionId))).toBe(true);
      expect(replayedWrites.some((write) => write.includes(ignoredTaskOutput))).toBe(false);
    });
    expect(mock.api.planningTerminalOpen).toHaveBeenCalledTimes(1);
  });
});
