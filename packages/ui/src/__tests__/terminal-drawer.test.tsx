import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { createMockInvoker, makeUITask, type MockInvoker } from './helpers/mock-invoker.js';
import type { WorkflowMeta } from '../types.js';
import type { TerminalSessionDescriptor } from '../components/TerminalDrawer.js';

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

vi.mock('xterm', () => ({ Terminal: xtermMock.Terminal }));
vi.mock('xterm-addon-fit', () => ({ FitAddon: xtermMock.FitAddon }));

const { App } = await import('../App.js');
const { TerminalDrawer } = await import('../components/TerminalDrawer.js');

const workflows: WorkflowMeta[] = [{ id: 'wf-a', name: 'Workflow A', status: 'completed' }];
const taskAlpha = makeUITask({
  id: 'task-alpha',
  description: 'Alpha description',
  status: 'completed',
  workflowId: 'wf-a',
});
const taskBeta = makeUITask({
  id: 'task-beta',
  description: 'Beta description',
  status: 'completed',
  workflowId: 'wf-a',
  dependencies: ['task-alpha'],
});

function makeTerminalSession(
  taskId: string,
  overrides: Partial<TerminalSessionDescriptor> = {},
): TerminalSessionDescriptor {
  return {
    sessionId: `mock-session-${taskId}`,
    taskId,
    status: 'running',
    mode: 'spawn',
    attached: false,
    createdAt: new Date('2025-01-01T00:00:00Z').toISOString(),
    outputSnapshot: `${taskId} ready\n`,
    ...overrides,
  };
}

async function expectPaneReady(taskId: string) {
  const pane = screen.getByTestId(`terminal-pane-${taskId}`);
  expect(pane).toBeVisible();
  await waitFor(() => {
    expect(pane.querySelector('.xterm')).not.toBeNull();
  });
  return pane;
}

async function selectWorkflow(): Promise<void> {
  await waitFor(() => {
    expect(screen.getByTestId('workflow-node-wf-a')).toBeInTheDocument();
  });
  fireEvent.click(screen.getByTestId('rf__node-wf-a'));
  await waitFor(() => {
    expect(screen.getByTestId('rf__node-task-alpha')).toBeInTheDocument();
  });
}

function installTerminalMocks(mock: MockInvoker): void {
  const terminalApi = mock.api as unknown as {
    terminalResize: ReturnType<typeof vi.fn>;
    terminalWrite: ReturnType<typeof vi.fn>;
    terminalClose: ReturnType<typeof vi.fn>;
    terminalList: ReturnType<typeof vi.fn>;
    onTerminalOutput: ReturnType<typeof vi.fn>;
  };
  terminalApi.terminalResize = vi.fn(async () => ({ ok: true }));
  terminalApi.terminalWrite = vi.fn(async () => ({ ok: true }));
  terminalApi.terminalClose = vi.fn(async () => ({ ok: true }));
  terminalApi.terminalList = vi.fn(async () => []);
  terminalApi.onTerminalOutput = vi.fn(() => () => {});
}

function installXtermMocks(): void {
  window.__INVOKER_TEST_TERMINAL_CONSTRUCTORS__ = {
    Terminal: xtermMock.Terminal,
    FitAddon: xtermMock.FitAddon,
  };
}

describe('Terminal drawer rendering regressions', () => {
  let mock: MockInvoker;

  beforeEach(() => {
    xtermMock.reset();
    installXtermMocks();
    mock = createMockInvoker();
    installTerminalMocks(mock);
    mock.install();
  });

  afterEach(() => {
    delete window.__INVOKER_TEST_TERMINAL_CONSTRUCTORS__;
    mock.cleanup();
    vi.restoreAllMocks();
  });

  it('keeps the active pane visible through minimized -> partial -> maximized transitions', async () => {
    const session = makeTerminalSession('task-alpha');
    const props = {
      onCycle: vi.fn(),
      sessions: [session],
      activeSessionId: session.sessionId,
      onSelectSession: vi.fn(),
      onCloseSession: vi.fn(),
    };

    const { rerender } = render(<TerminalDrawer state="minimized" {...props} />);
    expect(screen.getByTestId('terminal-drawer')).toHaveAttribute('data-state', 'minimized');
    expect(screen.queryByTestId('terminal-drawer-body')).not.toBeInTheDocument();

    rerender(<TerminalDrawer state="partial" {...props} />);
    expect(screen.getByTestId('terminal-drawer')).toHaveAttribute('data-state', 'partial');
    expect(screen.getByTestId('terminal-drawer-body')).toHaveStyle({ height: '280px' });
    expect(screen.getByTestId('terminal-tab-task-alpha')).toHaveAttribute('data-active', 'true');
    await expectPaneReady('task-alpha');

    rerender(<TerminalDrawer state="maximized" {...props} />);
    expect(screen.getByTestId('terminal-drawer')).toHaveAttribute('data-state', 'maximized');
    expect(screen.getByTestId('terminal-drawer')).toHaveClass('fixed');
    expect(screen.getByTestId('terminal-drawer-body')).toHaveClass('min-h-0', 'flex-1', 'overflow-hidden');
    expect(screen.getByTestId('terminal-tab-task-alpha')).toHaveAttribute('data-active', 'true');
    await expectPaneReady('task-alpha');

    await waitFor(() => {
      expect(xtermMock.fitInstances[0]?.fit).toHaveBeenCalled();
      expect(xtermMock.instances[0]?.focus).toHaveBeenCalled();
    });
  });

  it('renders only the active terminal pane visible while inactive panes remain display:none', async () => {
    const alpha = makeTerminalSession('task-alpha');
    const beta = makeTerminalSession('task-beta');
    const props = {
      state: 'partial' as const,
      onCycle: vi.fn(),
      sessions: [alpha, beta],
      onSelectSession: vi.fn(),
      onCloseSession: vi.fn(),
    };

    const { rerender } = render(<TerminalDrawer {...props} activeSessionId={alpha.sessionId} />);
    const alphaPane = await expectPaneReady('task-alpha');
    const betaPane = screen.getByTestId('terminal-pane-task-beta');
    expect(betaPane).not.toBeVisible();
    expect(betaPane).toHaveStyle({ display: 'none' });
    expect(screen.getByTestId('terminal-tab-task-alpha')).toHaveAttribute('data-active', 'true');
    expect(screen.getByTestId('terminal-tab-task-beta')).toHaveAttribute('data-active', 'false');

    rerender(<TerminalDrawer {...props} activeSessionId={beta.sessionId} />);
    expect(alphaPane).not.toBeVisible();
    expect(alphaPane).toHaveStyle({ display: 'none' });
    await expectPaneReady('task-beta');
    expect(screen.getByTestId('terminal-tab-task-alpha')).toHaveAttribute('data-active', 'false');
    expect(screen.getByTestId('terminal-tab-task-beta')).toHaveAttribute('data-active', 'true');
  });

  it('returns to an already-open terminal tab with the correct active pane', async () => {
    (mock.api.openTerminal as ReturnType<typeof vi.fn>).mockImplementation(async (taskId: string) => ({
      opened: true,
      session: makeTerminalSession(taskId),
    }));

    render(<App />);
    act(() => mock.setTasks([taskAlpha, taskBeta], workflows));
    await selectWorkflow();

    fireEvent.doubleClick(screen.getByTestId('rf__node-task-alpha'));
    await waitFor(() => {
      expect(screen.getByTestId('terminal-tab-task-alpha')).toHaveAttribute('data-active', 'true');
    });
    await expectPaneReady('task-alpha');

    fireEvent.doubleClick(screen.getByTestId('rf__node-task-beta'));
    await waitFor(() => {
      expect(screen.getByTestId('terminal-tab-task-beta')).toHaveAttribute('data-active', 'true');
      expect(screen.getByTestId('terminal-pane-task-alpha')).toHaveStyle({ display: 'none' });
    });
    await expectPaneReady('task-beta');

    fireEvent.click(screen.getByRole('tab', { name: 'Alpha description' }));
    await waitFor(() => {
      expect(screen.getByTestId('terminal-tab-task-alpha')).toHaveAttribute('data-active', 'true');
      expect(screen.getByTestId('terminal-pane-task-beta')).toHaveStyle({ display: 'none' });
    });
    await expectPaneReady('task-alpha');

    fireEvent.doubleClick(screen.getByTestId('rf__node-task-alpha'));
    await waitFor(() => {
      expect(screen.getAllByTestId('terminal-tab-task-alpha')).toHaveLength(1);
      expect(screen.getByTestId('terminal-tab-task-alpha')).toHaveAttribute('data-active', 'true');
    });
    await expectPaneReady('task-alpha');
    expect(mock.api.openTerminal).toHaveBeenCalledTimes(2);
  });
});
