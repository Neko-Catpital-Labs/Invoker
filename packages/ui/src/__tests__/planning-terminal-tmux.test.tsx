import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { TerminalSessionDescriptor } from '@invoker/contracts';
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
    xtermMock.reset();
    mock = createMockInvoker();
    mock.install();
  });

  afterEach(() => {
    mock.cleanup();
  });

  async function openPlanningHome() {
    fireEvent.click(await screen.findByTestId('sidebar-home'));
    const expandPlanningChats = screen.queryByRole('button', { name: 'Expand planning chats' });
    if (expandPlanningChats) fireEvent.click(expandPlanningChats);
    await screen.findByRole('heading', { name: 'Planning chat' });
  }

  it('restores planning tmux output emitted while the planning surface is hidden without reopening tmux', async () => {
    const planningSessionId = 'planning-hidden-1';
    const terminalSession: TerminalSessionDescriptor = {
      sessionId: 'planning-tmux-hidden-1',
      taskId: `planning:${planningSessionId}`,
      kind: 'planning',
      planningSessionId,
      status: 'running',
      mode: 'spawn',
      attached: false,
      createdAt: '2026-07-24T00:00:00.000Z',
      outputSnapshot: '',
    };

    mock.api.planningChatCreate = vi.fn(async () => ({
      ok: true,
      session: makePlanningSessionSummary({
        id: planningSessionId,
        title: 'Hidden tmux history',
        status: 'still_discussing',
        messages: [],
        draftPlanAvailable: false,
        draftPlanSummary: undefined,
      }),
    })) as any;
    mock.api.planningTerminalOpen = vi.fn(async () => ({
      opened: true,
      session: terminalSession,
    })) as any;

    render(<App />);
    await openPlanningHome();

    fireEvent.click(screen.getByRole('tab', { name: 'Tmux' }));
    await waitFor(() => {
      expect(mock.api.planningTerminalOpen).toHaveBeenCalledWith(planningSessionId);
      expect(screen.getByTestId('invoker-terminal-tmux-pane')).toHaveAttribute('data-session-id', terminalSession.sessionId);
      expect(xtermMock.instances).toHaveLength(1);
    });

    await act(async () => {
      mock.fireTerminalOutput({
        sessionId: terminalSession.sessionId,
        taskId: terminalSession.taskId,
        kind: 'planning',
        planningSessionId,
        data: 'visible line\n',
      });
    });

    expect(xtermMock.writeLog).toEqual(['visible line\n']);

    fireEvent.click(screen.getByTestId('sidebar-planning'));
    await waitFor(() => {
      expect(screen.queryByTestId('invoker-terminal-tmux-pane')).not.toBeInTheDocument();
    });

    await act(async () => {
      mock.fireTerminalOutput({
        sessionId: terminalSession.sessionId,
        taskId: terminalSession.taskId,
        kind: 'planning',
        planningSessionId,
        data: 'hidden by planning id\n',
      });
      mock.fireTerminalOutput({
        sessionId: terminalSession.sessionId,
        taskId: terminalSession.taskId,
        kind: 'planning',
        data: 'hidden by session id\n',
      });
      mock.fireTerminalOutput({
        sessionId: terminalSession.sessionId,
        taskId: 'task-alpha',
        kind: 'task',
        data: 'task drawer noise\n',
      });
    });

    expect(xtermMock.writeLog).toEqual(['visible line\n']);

    fireEvent.click(screen.getByTestId('sidebar-home'));

    await waitFor(() => {
      expect(screen.getByTestId('invoker-terminal-tmux-pane')).toHaveAttribute('data-session-id', terminalSession.sessionId);
      expect(xtermMock.instances).toHaveLength(2);
      expect(xtermMock.writeLog.at(-1)).toBe('visible line\nhidden by planning id\nhidden by session id\n');
    });
    expect(xtermMock.writeLog.join('')).not.toContain('task drawer noise');
    expect(mock.api.planningTerminalOpen).toHaveBeenCalledTimes(1);
  });
});
