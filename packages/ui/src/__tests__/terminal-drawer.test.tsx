/**
 * Component test: embedded terminal drawer wiring.
 *
 * Covers the renderer-side acceptance criteria for the
 * `implement-terminal-drawer-tabs` task:
 *   - the drawer has three explicit states: minimized, partial, maximized
 *   - opening a terminal puts the drawer in the partial state
 *   - the single cycling button advances minimized → partial → maximized → minimized
 *   - the same task id reuses a single tab
 *   - failures from openTerminal surface as an alert
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, waitFor, fireEvent } from '@testing-library/react';
import { createMockInvoker, makeUITask, type MockInvoker } from './helpers/mock-invoker.js';
import type { WorkflowMeta } from '../types.js';
import type { TerminalSessionDescriptor } from '@invoker/contracts';

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
    open = vi.fn();
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
    ...overrides,
  };
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

describe('Terminal drawer (component)', () => {
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

  it('starts minimized: header is shown but no terminal body', async () => {
    render(<App />);
    await waitFor(() => {
      // From minimized, the single button's next action is "Partial".
      expect(screen.getByRole('button', { name: 'Partial terminal drawer' })).toBeInTheDocument();
    });
    expect(screen.getByTestId('terminal-drawer')).toHaveAttribute('data-state', 'minimized');
    expect(screen.queryByTestId('terminal-drawer-body')).not.toBeInTheDocument();
  });

  it('opens the drawer in the partial state (not maximized) when opening a terminal via double-click', async () => {
    render(<App />);
    act(() => mock.setTasks([taskAlpha, taskBeta], workflows));
    await selectWorkflow();

    fireEvent.doubleClick(screen.getByTestId('rf__node-task-alpha'));

    await waitFor(() => {
      // Partial drawer's next action is "Maximize".
      expect(screen.getByRole('button', { name: 'Maximize terminal drawer' })).toBeInTheDocument();
      expect(screen.getByTestId('terminal-drawer-body')).toBeInTheDocument();
      expect(screen.getByTestId('terminal-tab-task-alpha')).toBeInTheDocument();
    });
    const drawer = screen.getByTestId('terminal-drawer');
    expect(drawer).toHaveAttribute('data-state', 'partial');
    expect(drawer).not.toHaveClass('fixed');
    // Partial keeps today's 280px body height.
    expect(screen.getByTestId('terminal-drawer-body')).toHaveStyle({ height: '280px' });
    expect(mock.api.openTerminal).toHaveBeenCalledWith('task-alpha');
  });

  it('cycles minimized → partial → maximized → minimized via the single button', async () => {
    render(<App />);
    act(() => mock.setTasks([taskAlpha], workflows));
    await selectWorkflow();

    const drawer = screen.getByTestId('terminal-drawer');
    expect(drawer).toHaveAttribute('data-state', 'minimized');

    // minimized → partial
    fireEvent.click(screen.getByRole('button', { name: 'Partial terminal drawer' }));
    expect(drawer).toHaveAttribute('data-state', 'partial');
    expect(screen.getByTestId('terminal-drawer-body')).toHaveStyle({ height: '280px' });

    // partial → maximized: body covers app content via fixed inset positioning.
    fireEvent.click(screen.getByRole('button', { name: 'Maximize terminal drawer' }));
    expect(drawer).toHaveAttribute('data-state', 'maximized');
    expect(drawer).toHaveClass('fixed');
    expect(screen.getByTestId('terminal-drawer-body')).toBeInTheDocument();

    // maximized → minimized: body flattens away.
    fireEvent.click(screen.getByRole('button', { name: 'Minimize terminal drawer' }));
    expect(drawer).toHaveAttribute('data-state', 'minimized');
    expect(screen.queryByTestId('terminal-drawer-body')).not.toBeInTheDocument();
  });

  it('reuses an existing tab when opening the same task twice', async () => {
    render(<App />);
    act(() => mock.setTasks([taskAlpha], workflows));
    await selectWorkflow();

    fireEvent.doubleClick(screen.getByTestId('rf__node-task-alpha'));
    await waitFor(() => {
      expect(screen.getByTestId('terminal-tab-task-alpha')).toBeInTheDocument();
    });

    // Minimize (cycle partial → maximized → minimized), then re-open —
    // should not duplicate the tab.
    fireEvent.click(screen.getByRole('button', { name: 'Maximize terminal drawer' }));
    fireEvent.click(screen.getByRole('button', { name: 'Minimize terminal drawer' }));
    expect(screen.getByTestId('terminal-drawer')).toHaveAttribute('data-state', 'minimized');

    fireEvent.doubleClick(screen.getByTestId('rf__node-task-alpha'));

    await waitFor(() => {
      expect(screen.getByTestId('terminal-drawer')).toHaveAttribute('data-state', 'partial');
    });
    const tabs = screen.getAllByTestId('terminal-tab-task-alpha');
    expect(tabs).toHaveLength(1);
  });

  it('renders distinct tabs for different tasks side by side', async () => {
    render(<App />);
    act(() => mock.setTasks([taskAlpha, taskBeta], workflows));
    await selectWorkflow();

    fireEvent.doubleClick(screen.getByTestId('rf__node-task-alpha'));
    await waitFor(() => expect(screen.getByTestId('terminal-tab-task-alpha')).toBeInTheDocument());

    fireEvent.doubleClick(screen.getByTestId('rf__node-task-beta'));
    await waitFor(() => expect(screen.getByTestId('terminal-tab-task-beta')).toBeInTheDocument());

    expect(screen.getByTestId('terminal-tab-task-alpha')).toBeInTheDocument();
    expect(screen.getByTestId('terminal-tab-task-beta')).toBeInTheDocument();
    // The beta tab should be the active one (last opened).
    expect(screen.getByTestId('terminal-tab-task-beta')).toHaveAttribute('data-active', 'true');
    expect(screen.getByTestId('terminal-tab-task-alpha')).toHaveAttribute('data-active', 'false');
  });

  it('keeps the minimize control reachable when many tabs are open', async () => {
    render(<App />);
    act(() => mock.setTasks([taskAlpha, taskBeta], workflows));
    await selectWorkflow();

    fireEvent.doubleClick(screen.getByTestId('rf__node-task-alpha'));
    await waitFor(() => expect(screen.getByTestId('terminal-tab-task-alpha')).toBeInTheDocument());
    fireEvent.doubleClick(screen.getByTestId('rf__node-task-beta'));
    await waitFor(() => expect(screen.getByTestId('terminal-tab-task-beta')).toBeInTheDocument());

    // Tab strip and cycle button live in the same flex row so the control stays visible.
    const tabStrip = screen.getByTestId('terminal-tab-strip');
    const toggle = screen.getByRole('button', { name: 'Maximize terminal drawer' });
    expect(tabStrip).toBeInTheDocument();
    expect(toggle).toBeInTheDocument();
    expect(tabStrip.compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('surfaces failure reason as an alert when openTerminal refuses', async () => {
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    (mock.api.openTerminal as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      opened: false,
      reason: 'Task is still running.',
    });

    render(<App />);
    act(() => mock.setTasks([taskAlpha], workflows));
    await selectWorkflow();

    fireEvent.doubleClick(screen.getByTestId('rf__node-task-alpha'));

    await waitFor(() => {
      expect(alertSpy).toHaveBeenCalledWith('Task is still running.');
    });
    expect(screen.queryByTestId('terminal-tab-task-alpha')).not.toBeInTheDocument();
  });

  it('opens the drawer when the context-menu Open Terminal action is used', async () => {
    render(<App />);
    act(() => mock.setTasks([taskAlpha], workflows));
    await selectWorkflow();

    fireEvent.contextMenu(screen.getByTestId('rf__node-task-alpha'));
    const openTerminalItem = await screen.findByRole('menuitem', { name: /Open Terminal/i });
    fireEvent.click(openTerminalItem);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Maximize terminal drawer' })).toBeInTheDocument();
      expect(screen.getByTestId('terminal-drawer')).toHaveAttribute('data-state', 'partial');
      expect(screen.getByTestId('terminal-tab-task-alpha')).toBeInTheDocument();
    });
    expect(mock.api.openTerminal).toHaveBeenCalledWith('task-alpha');
  });

  it('seeds the replay snapshot before live terminal output', async () => {
    const session = makeTerminalSession('task-alpha', {
      outputSnapshot: 'early line\n',
    });
    (mock.api.openTerminal as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      opened: true,
      session,
    });

    render(<App />);
    act(() => mock.setTasks([taskAlpha], workflows));
    await selectWorkflow();

    fireEvent.doubleClick(screen.getByTestId('rf__node-task-alpha'));

    await waitFor(() => {
      expect(xtermMock.writeLog).toEqual(['early line\n']);
    });

    act(() => {
      mock.fireTerminalOutput({
        sessionId: session.sessionId,
        taskId: session.taskId,
        data: 'live line\n',
      });
    });

    await waitFor(() => {
      expect(xtermMock.writeLog).toEqual(['early line\n', 'live line\n']);
    });
  });

  it('does not duplicate the replay snapshot when the same session re-renders', async () => {
    const session = makeTerminalSession('task-alpha', {
      outputSnapshot: 'replayed once\n',
    });
    (mock.api.openTerminal as ReturnType<typeof vi.fn>).mockResolvedValue({
      opened: true,
      session,
    });

    render(<App />);
    act(() => mock.setTasks([taskAlpha], workflows));
    await selectWorkflow();

    fireEvent.doubleClick(screen.getByTestId('rf__node-task-alpha'));
    await waitFor(() => {
      expect(xtermMock.writeLog).toEqual(['replayed once\n']);
    });

    fireEvent.doubleClick(screen.getByTestId('rf__node-task-alpha'));
    await waitFor(() => {
      expect(mock.api.openTerminal).toHaveBeenCalledTimes(2);
    });

    expect(xtermMock.writeLog).toEqual(['replayed once\n']);
  });

  it('keeps live output, input, resize, close, tab selection, and preview wiring intact', async () => {
    (mock.api.openTerminal as ReturnType<typeof vi.fn>).mockImplementation(async (taskId: string) => ({
      opened: true,
      session: makeTerminalSession(taskId, {
        command: 'sh',
        args: ['-lc', taskId],
      }),
    }));

    render(<App />);
    act(() => mock.setTasks([taskAlpha, taskBeta], workflows));
    await selectWorkflow();

    fireEvent.doubleClick(screen.getByTestId('rf__node-task-alpha'));
    await waitFor(() => expect(screen.getByTestId('terminal-tab-task-alpha')).toBeInTheDocument());
    await waitFor(() => {
      expect(mock.api.terminalResize).toHaveBeenCalledWith('mock-session-task-alpha', 80, 24);
    });

    fireEvent.doubleClick(screen.getByTestId('rf__node-task-beta'));
    await waitFor(() => expect(screen.getByTestId('terminal-tab-task-beta')).toBeInTheDocument());
    expect(screen.getByTestId('terminal-tab-task-beta')).toHaveAttribute('data-active', 'true');

    fireEvent.click(screen.getByRole('tab', { name: /Alpha description/i }));
    expect(screen.getByTestId('terminal-tab-task-alpha')).toHaveAttribute('data-active', 'true');

    act(() => {
      xtermMock.instances[0]?.emitData('pwd\n');
    });
    expect(mock.api.terminalWrite).toHaveBeenCalledWith('mock-session-task-alpha', 'pwd\n');

    act(() => {
      mock.fireTerminalOutput({
        sessionId: 'mock-session-task-alpha',
        taskId: 'task-alpha',
        data: 'alpha live output\n',
      });
    });
    await waitFor(() => {
      expect(xtermMock.writeLog).toContain('alpha live output\n');
      expect(screen.getByTestId('terminal-session-output-preview')).toHaveTextContent('alpha live output');
    });

    fireEvent.click(screen.getByRole('button', { name: 'Close terminal for Alpha description' }));
    await waitFor(() => {
      expect(mock.api.terminalClose).toHaveBeenCalledWith('mock-session-task-alpha');
    });
  });
});
