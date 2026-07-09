import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  TerminalDrawer,
  type TerminalDrawerState,
  type TerminalSessionDescriptor,
} from '../components/TerminalDrawer.js';

const xtermMock = vi.hoisted(() => {
  type DataHandler = (data: string) => void;

  const instances: MockTerminal[] = [];
  const fitInstances: MockFitAddon[] = [];
  const writeLog: Array<{ taskId: string | null; data: string }> = [];

  class MockTerminal {
    cols = 80;
    rows = 24;
    host: HTMLElement | null = null;
    dataHandler: DataHandler | null = null;
    loadAddon = vi.fn();
    open = vi.fn((host: HTMLElement) => {
      this.host = host;
      host.setAttribute('data-xterm-open', 'true');
    });
    write = vi.fn((data: string) => {
      writeLog.push({
        taskId: this.host?.getAttribute('data-testid')?.replace('terminal-pane-', '') ?? null,
        data,
      });
      const line = document.createElement('span');
      line.textContent = data;
      this.host?.append(line);
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

    emitData(data: string) {
      this.dataHandler?.(data);
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

type TerminalTestWindow = typeof window & {
  __INVOKER_TEST_XTERM__?: {
    Terminal: typeof xtermMock.Terminal;
    FitAddon: typeof xtermMock.FitAddon;
  };
};

const nextDrawerState: Record<TerminalDrawerState, TerminalDrawerState> = {
  minimized: 'partial',
  partial: 'maximized',
  maximized: 'minimized',
};

function makeSession(
  taskId: string,
  overrides: Partial<TerminalSessionDescriptor> = {},
): TerminalSessionDescriptor {
  return {
    sessionId: `session-${taskId}`,
    taskId,
    status: 'running',
    outputSnapshot: `${taskId} ready\n`,
    ...overrides,
  };
}

function TerminalDrawerHarness({
  initialState,
  sessions,
  initialActiveSessionId = sessions[0]?.sessionId ?? null,
}: {
  initialState: TerminalDrawerState;
  sessions: TerminalSessionDescriptor[];
  initialActiveSessionId?: string | null;
}) {
  const [state, setState] = useState<TerminalDrawerState>(initialState);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(initialActiveSessionId);
  const labels = new Map(sessions.map((session) => [session.taskId, `${session.taskId} label`]));

  return (
    <TerminalDrawer
      state={state}
      onCycle={() => setState((current) => nextDrawerState[current])}
      sessions={sessions}
      activeSessionId={activeSessionId}
      onSelectSession={setActiveSessionId}
      onCloseSession={vi.fn()}
      taskLabels={labels}
    />
  );
}

function expectActivePane(taskId: string, text: string) {
  const tab = screen.getByTestId(`terminal-tab-${taskId}`);
  const pane = screen.getByTestId(`terminal-pane-${taskId}`);
  expect(tab).toHaveAttribute('data-active', 'true');
  expect(pane).toHaveStyle({ display: 'block' });
  expect(pane).toBeVisible();
  expect(pane).toHaveTextContent(text);
  expect(pane).toHaveAttribute('data-xterm-open', 'true');
}

function expectInactivePane(taskId: string) {
  const tab = screen.getByTestId(`terminal-tab-${taskId}`);
  const pane = screen.getByTestId(`terminal-pane-${taskId}`);
  expect(tab).toHaveAttribute('data-active', 'false');
  expect(pane).toHaveStyle({ display: 'none' });
  expect(pane).not.toBeVisible();
}

describe('TerminalDrawer active pane regressions', () => {
  beforeEach(() => {
    xtermMock.reset();
    (window as TerminalTestWindow).__INVOKER_TEST_XTERM__ = {
      Terminal: xtermMock.Terminal,
      FitAddon: xtermMock.FitAddon,
    };
  });

  afterEach(() => {
    cleanup();
    delete (window as TerminalTestWindow).__INVOKER_TEST_XTERM__;
    vi.clearAllMocks();
  });

  it('keeps the active pane visible and nonblank across minimized -> partial -> maximized', async () => {
    const session = makeSession('task-alpha', { outputSnapshot: 'alpha terminal output\n' });
    render(<TerminalDrawerHarness initialState="minimized" sessions={[session]} />);

    expect(screen.getByTestId('terminal-drawer')).toHaveAttribute('data-state', 'minimized');
    expect(screen.queryByTestId('terminal-drawer-body')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Partial terminal drawer' }));
    expect(screen.getByTestId('terminal-drawer')).toHaveAttribute('data-state', 'partial');
    expect(screen.getByTestId('terminal-drawer-body')).toBeVisible();
    await waitFor(() => expectActivePane('task-alpha', 'alpha terminal output'));

    const mountedTerminal = xtermMock.instances[0];
    fireEvent.click(screen.getByRole('button', { name: 'Maximize terminal drawer' }));

    expect(screen.getByTestId('terminal-drawer')).toHaveAttribute('data-state', 'maximized');
    expect(screen.getByTestId('terminal-drawer')).toHaveClass('fixed');
    expect(screen.getByTestId('terminal-drawer-body')).toBeVisible();
    expectActivePane('task-alpha', 'alpha terminal output');
    expect(xtermMock.instances).toHaveLength(1);
    expect(mountedTerminal.dispose).not.toHaveBeenCalled();
  });

  it('shows only the newly active pane when switching tabs while inactive panes are display:none', async () => {
    const alpha = makeSession('task-alpha', { outputSnapshot: 'alpha terminal output\n' });
    const beta = makeSession('task-beta', { outputSnapshot: 'beta terminal output\n' });
    render(<TerminalDrawerHarness initialState="partial" sessions={[alpha, beta]} />);

    await waitFor(() => expectActivePane('task-alpha', 'alpha terminal output'));
    expectInactivePane('task-beta');

    fireEvent.click(screen.getByRole('tab', { name: /task-beta label/i }));

    expectInactivePane('task-alpha');
    await waitFor(() => expectActivePane('task-beta', 'beta terminal output'));
    await waitFor(() => {
      expect(xtermMock.instances[1].focus).toHaveBeenCalledTimes(1);
      expect(xtermMock.fitInstances[1].fit).toHaveBeenCalled();
    });
  });

  it('restores an already-open terminal tab without leaving its pane hidden or blank', async () => {
    const alpha = makeSession('task-alpha', { outputSnapshot: 'alpha persisted output\n' });
    const beta = makeSession('task-beta', { outputSnapshot: 'beta persisted output\n' });
    render(<TerminalDrawerHarness initialState="partial" sessions={[alpha, beta]} />);

    await waitFor(() => expectActivePane('task-alpha', 'alpha persisted output'));
    fireEvent.click(screen.getByRole('tab', { name: /task-beta label/i }));
    await waitFor(() => expectActivePane('task-beta', 'beta persisted output'));
    expectInactivePane('task-alpha');

    fireEvent.click(screen.getByRole('tab', { name: /task-alpha label/i }));

    await waitFor(() => expectActivePane('task-alpha', 'alpha persisted output'));
    expectInactivePane('task-beta');
    expect(xtermMock.instances).toHaveLength(2);
    expect(xtermMock.instances[0].open).toHaveBeenCalledTimes(1);
    expect(xtermMock.instances[0].dispose).not.toHaveBeenCalled();
    expect(xtermMock.writeLog.filter((entry) => entry.taskId === 'task-alpha')).toEqual([
      { taskId: 'task-alpha', data: 'alpha persisted output\n' },
    ]);
  });
});
