import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

const PLANNING_SESSION_ID = 'saved-tmux';
const PLANNING_TERMINAL_SESSION_ID = `mock-planning-terminal-${PLANNING_SESSION_ID}`;

function planningTerminalOutput(data: string, planningSessionId: string | undefined = PLANNING_SESSION_ID) {
  return {
    sessionId: PLANNING_TERMINAL_SESSION_ID,
    taskId: `planning:${PLANNING_SESSION_ID}`,
    kind: 'planning' as const,
    planningSessionId,
    data,
  };
}

describe('Planning terminal tmux persistence', () => {
  let mock: MockInvoker;

  beforeEach(() => {
    xtermMock.reset();
    mock = createMockInvoker();
    mock.api.planningChatList = vi.fn(async () => ({
      ok: true,
      sessions: [
        makePlanningSessionSummary({
          id: PLANNING_SESSION_ID,
          title: 'Saved tmux chat',
          status: 'still_discussing',
          messages: [],
          draftPlanAvailable: false,
          terminalMode: 'chat',
        }),
      ],
    }));
    mock.api.planningTerminalList = vi.fn(async () => []);
    mock.install();
  });

  afterEach(() => {
    cleanup();
    mock.cleanup();
    vi.restoreAllMocks();
  });

  async function renderSavedPlanningChat(): Promise<void> {
    render(<App />);
    await waitFor(() => {
      expect(screen.getByTestId('planning-session-rail')).toHaveTextContent('Saved tmux chat');
    });
  }

  async function openPlanningTmux(): Promise<void> {
    fireEvent.click(screen.getByRole('tab', { name: 'Tmux' }));
    await waitFor(() => {
      expect(mock.api.planningTerminalOpen).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('invoker-terminal-tmux-pane')).toHaveAttribute(
        'data-session-id',
        PLANNING_TERMINAL_SESSION_ID,
      );
    });
  }

  it('restores planning tmux output when switching between chat and tmux tabs', async () => {
    await renderSavedPlanningChat();
    await openPlanningTmux();

    await act(async () => {
      mock.fireTerminalOutput(planningTerminalOutput('visible tmux output\n'));
    });

    expect(xtermMock.instances.at(-1)?.write).toHaveBeenCalledWith('visible tmux output\n');

    fireEvent.click(screen.getByRole('tab', { name: 'Chat' }));
    await waitFor(() => {
      expect(screen.queryByTestId('invoker-terminal-tmux-pane')).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('tab', { name: 'Tmux' }));

    await waitFor(() => {
      expect(mock.api.planningTerminalOpen).toHaveBeenCalledTimes(1);
      expect(xtermMock.instances.at(-1)?.write).toHaveBeenCalledWith(
        expect.stringContaining('visible tmux output\n'),
      );
    });
  });

  it('restores planning tmux output emitted while the terminal surface is hidden', async () => {
    await renderSavedPlanningChat();
    await openPlanningTmux();

    fireEvent.click(screen.getByTestId('sidebar-planning'));
    expect(await screen.findByRole('heading', { name: 'Plan graph' })).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByTestId('invoker-terminal-tmux-pane')).not.toBeInTheDocument();
    });

    await act(async () => {
      mock.fireTerminalOutput(planningTerminalOutput('hidden with planning id\n'));
      mock.fireTerminalOutput(planningTerminalOutput('hidden with terminal id fallback\n', undefined));
    });

    expect(xtermMock.writeLog).not.toContain('hidden with planning id\n');
    expect(xtermMock.writeLog).not.toContain('hidden with terminal id fallback\n');

    fireEvent.click(screen.getByTestId('sidebar-home'));

    await waitFor(() => {
      expect(mock.api.planningTerminalOpen).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('invoker-terminal-tmux-pane')).toHaveAttribute(
        'data-session-id',
        PLANNING_TERMINAL_SESSION_ID,
      );
      const latestTerminal = xtermMock.instances.at(-1);
      expect(latestTerminal?.write).toHaveBeenCalledWith(
        expect.stringContaining('hidden with planning id\nhidden with terminal id fallback\n'),
      );
    });
  });
});
