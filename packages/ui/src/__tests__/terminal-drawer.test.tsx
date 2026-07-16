/**
 * Component test: embedded terminal drawer wiring.
 *
 * Covers the renderer-side acceptance criteria for the
 * `implement-terminal-drawer-tabs` task:
 *   - the drawer has three explicit states: minimized, partial, maximized
 *   - opening a terminal puts the drawer in the partial state
 *   - the single cycling button advances minimized → partial → maximized → minimized
 *   - the same task id reuses and focuses a single tab without another IPC call
 *   - failures from openTerminal surface as an alert
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, waitFor, fireEvent } from '@testing-library/react';
import { useState } from 'react';
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

const COMPONENT_TERMINAL_INTERACTION_BUDGET_MS = 50;

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

function perfPayloads(metric: string): Array<Record<string, any>> {
  return vi.mocked(window.invoker.reportUiPerf).mock.calls
    .filter(([name]) => name === metric)
    .map(([, data]) => data as Record<string, any>);
}

function lastPerfPayload(metric: string): Record<string, any> {
  const payload = perfPayloads(metric).at(-1);
  if (!payload) throw new Error(`Missing ${metric} perf payload`);
  return payload;
}

describe('Terminal drawer (component)', () => {
  let mock: MockInvoker;

  beforeEach(() => {
    xtermMock.reset();
    mock = createMockInvoker();
    mock.api.terminalResize = vi.fn(async () => ({ ok: true }));
    mock.api.terminalWrite = vi.fn(async () => ({ ok: true }));
    mock.api.terminalClose = vi.fn(async () => ({ ok: true }));
    mock.api.terminalList = vi.fn(async () => []);
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

  it('restores persisted terminal sessions from startup terminalList', async () => {
    const restored = makeTerminalSession('task-alpha', {
      outputSnapshot: 'restored before restart\n',
    });
    vi.mocked(mock.api.terminalList).mockResolvedValue([restored]);

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId('terminal-drawer')).toHaveAttribute('data-state', 'partial');
      expect(screen.getByTestId('terminal-tab-task-alpha')).toHaveAttribute('data-active', 'true');
      expect(xtermMock.writeLog).toContain('restored before restart\n');
    });
    await expectPaneReady('task-alpha');
    await waitFor(() => {
      expect(xtermMock.fitInstances[0]?.fit).toHaveBeenCalled();
      expect(xtermMock.instances[0]?.refresh).toHaveBeenCalledWith(0, 23);
      expect(mock.api.terminalResize).toHaveBeenCalledWith(restored.sessionId, 80, 24);
    });
  });

  it('refits the active pane across partial and maximized drawer states', async () => {
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
    await waitFor(() => {
      expect(xtermMock.fitInstances[0]?.fit).toHaveBeenCalled();
      expect(xtermMock.instances[0]?.refresh).toHaveBeenCalledWith(0, 23);
    });
    const partialFitCalls = xtermMock.fitInstances[0].fit.mock.calls.length;
    const partialRefreshCalls = xtermMock.instances[0].refresh.mock.calls.length;

    rerender(<TerminalDrawer state="maximized" {...props} />);
    expect(screen.getByTestId('terminal-drawer')).toHaveAttribute('data-state', 'maximized');
    expect(screen.getByTestId('terminal-drawer')).toHaveClass('fixed');
    expect(screen.getByTestId('terminal-drawer-body')).toHaveClass('min-h-0', 'flex-1', 'overflow-hidden');
    await expectPaneReady('task-alpha');
    await waitFor(() => {
      expect(xtermMock.fitInstances[0].fit.mock.calls.length).toBeGreaterThan(partialFitCalls);
      expect(xtermMock.instances[0].refresh.mock.calls.length).toBeGreaterThan(partialRefreshCalls);
      expect(xtermMock.instances[0]?.focus).toHaveBeenCalled();
    });
  });

  it('refits the newly active pane when terminal tabs switch', async () => {
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
    await expectPaneReady('task-alpha');
    const betaPane = screen.getByTestId('terminal-pane-task-beta');
    expect(betaPane).not.toBeVisible();
    expect(betaPane).toHaveStyle({ display: 'none' });
    await waitFor(() => {
      expect(betaPane.querySelector('.xterm')).not.toBeNull();
      expect(xtermMock.fitInstances).toHaveLength(2);
    });
    const betaHiddenFitCalls = xtermMock.fitInstances[1].fit.mock.calls.length;
    const betaHiddenRefreshCalls = xtermMock.instances[1].refresh.mock.calls.length;

    rerender(<TerminalDrawer {...props} activeSessionId={beta.sessionId} />);
    await expectPaneReady('task-beta');
    expect(screen.getByTestId('terminal-tab-task-alpha')).toHaveAttribute('data-active', 'false');
    expect(screen.getByTestId('terminal-tab-task-beta')).toHaveAttribute('data-active', 'true');
    await waitFor(() => {
      expect(xtermMock.fitInstances[1].fit.mock.calls.length).toBeGreaterThan(betaHiddenFitCalls);
      expect(xtermMock.instances[1].refresh.mock.calls.length).toBeGreaterThan(betaHiddenRefreshCalls);
    });
  });

  it('opens the drawer in the partial state (not maximized) when opening a terminal via double-click', async () => {
    render(<App />);
    act(() => mock.setTasks([taskAlpha, taskBeta], workflows));
    await selectWorkflow();

    fireEvent.doubleClick(screen.getByTestId('rf__node-task-alpha'));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Maximize terminal drawer' })).toBeInTheDocument();
      expect(screen.getByTestId('terminal-drawer-body')).toBeInTheDocument();
      expect(screen.getByTestId('terminal-tab-task-alpha')).toBeInTheDocument();
    });
    const drawer = screen.getByTestId('terminal-drawer');
    expect(drawer).toHaveAttribute('data-state', 'partial');
    expect(drawer).not.toHaveClass('fixed');
    expect(screen.getByTestId('terminal-drawer-body')).toHaveStyle({ height: '280px' });
    expect(mock.api.openTerminal).toHaveBeenCalledWith('task-alpha');
    await waitFor(() => {
      expect(mock.api.reportUiPerf).toHaveBeenCalledWith(
        'embedded_terminal_open_request',
        expect.objectContaining({
          taskId: 'task-alpha',
          result: 'opened',
          sessionId: 'mock-session-task-alpha',
          status: 'running',
        }),
      );
    });
    expect(lastPerfPayload('embedded_terminal_open_request').durationMs).toBeLessThanOrEqual(COMPONENT_TERMINAL_INTERACTION_BUDGET_MS);
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
    expect(lastPerfPayload('embedded_terminal_drawer_cycle')).toEqual(expect.objectContaining({
      previousState: 'minimized',
      nextState: 'partial',
    }));

    // partial → maximized: body covers app content via fixed inset positioning.
    fireEvent.click(screen.getByRole('button', { name: 'Maximize terminal drawer' }));
    expect(drawer).toHaveAttribute('data-state', 'maximized');
    expect(drawer).toHaveClass('fixed');
    expect(screen.getByTestId('terminal-drawer-body')).toBeInTheDocument();
    expect(lastPerfPayload('embedded_terminal_drawer_cycle')).toEqual(expect.objectContaining({
      previousState: 'partial',
      nextState: 'maximized',
    }));

    // maximized → minimized: body flattens away.
    fireEvent.click(screen.getByRole('button', { name: 'Minimize terminal drawer' }));
    expect(drawer).toHaveAttribute('data-state', 'minimized');
    expect(screen.queryByTestId('terminal-drawer-body')).not.toBeInTheDocument();
    const cyclePayload = lastPerfPayload('embedded_terminal_drawer_cycle');
    expect(cyclePayload).toEqual(expect.objectContaining({
      previousState: 'maximized',
      nextState: 'minimized',
    }));
    expect(cyclePayload.durationMs).toBeLessThanOrEqual(COMPONENT_TERMINAL_INTERACTION_BUDGET_MS);
  });

  it('bounds the maximized terminal body so xterm owns scrollback', () => {
    const session = makeTerminalSession('task-alpha', {
      command: 'sh',
      args: ['-lc', 'seq 1 200'],
    });

    render(
      <TerminalDrawer
        state="maximized"
        onCycle={vi.fn()}
        sessions={[session]}
        activeSessionId={session.sessionId}
        onSelectSession={vi.fn()}
        onCloseSession={vi.fn()}
      />,
    );

    expect(screen.getByTestId('terminal-drawer')).toHaveClass('min-h-0', 'overflow-hidden');
    expect(screen.getByTestId('terminal-drawer-body')).toHaveClass('min-h-0', 'flex-1', 'overflow-hidden');
    expect(screen.getByTestId('terminal-pane-task-alpha')).toHaveClass('overflow-hidden');
  });

  it('focuses an existing running tab when double-clicking the same task again', async () => {
    render(<App />);
    act(() => mock.setTasks([taskAlpha, taskBeta], workflows));
    await selectWorkflow();

    fireEvent.doubleClick(screen.getByTestId('rf__node-task-alpha'));
    await waitFor(() => {
      expect(screen.getByTestId('terminal-tab-task-alpha')).toBeInTheDocument();
    });

    fireEvent.doubleClick(screen.getByTestId('rf__node-task-beta'));
    await waitFor(() => {
      expect(screen.getByTestId('terminal-tab-task-beta')).toHaveAttribute('data-active', 'true');
    });
    expect(mock.api.openTerminal).toHaveBeenCalledTimes(2);

    // Minimize (cycle partial → maximized → minimized), then re-open alpha.
    // The existing alpha tab should be selected without another open-terminal IPC call.
    fireEvent.click(screen.getByRole('button', { name: 'Maximize terminal drawer' }));
    fireEvent.click(screen.getByRole('button', { name: 'Minimize terminal drawer' }));
    expect(screen.getByTestId('terminal-drawer')).toHaveAttribute('data-state', 'minimized');

    fireEvent.doubleClick(screen.getByTestId('rf__node-task-alpha'));

    await waitFor(() => {
      expect(screen.getByTestId('terminal-drawer')).toHaveAttribute('data-state', 'partial');
      expect(screen.getByTestId('terminal-tab-task-alpha')).toHaveAttribute('data-active', 'true');
    });
    const tabs = screen.getAllByTestId('terminal-tab-task-alpha');
    expect(tabs).toHaveLength(1);
    expect(screen.getByTestId('terminal-tab-task-beta')).toHaveAttribute('data-active', 'false');
    expect(mock.api.openTerminal).toHaveBeenCalledTimes(2);
    expect((mock.api.openTerminal as ReturnType<typeof vi.fn>).mock.calls.map(([taskId]) => taskId)).toEqual([
      'task-alpha',
      'task-beta',
    ]);
    expect(lastPerfPayload('embedded_terminal_existing_tab_reuse')).toEqual(expect.objectContaining({
      taskId: 'task-alpha',
      sessionId: 'mock-session-task-alpha',
      previousActiveSessionId: 'mock-session-task-beta',
      sessionCount: 2,
    }));
    expect(lastPerfPayload('embedded_terminal_existing_tab_reuse').durationMs).toBeLessThanOrEqual(COMPONENT_TERMINAL_INTERACTION_BUDGET_MS);
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
    const openPayload = lastPerfPayload('embedded_terminal_open_request');
    expect(openPayload).toEqual(expect.objectContaining({
      taskId: 'task-alpha',
      result: 'rejected',
      reason: 'Task is still running.',
    }));
    expect(openPayload.durationMs).toBeLessThanOrEqual(COMPONENT_TERMINAL_INTERACTION_BUDGET_MS);
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

  it('keeps the context-menu Open Terminal action routed through open-terminal IPC', async () => {
    render(<App />);
    act(() => mock.setTasks([taskAlpha], workflows));
    await selectWorkflow();

    fireEvent.doubleClick(screen.getByTestId('rf__node-task-alpha'));
    await waitFor(() => {
      expect(screen.getByTestId('terminal-tab-task-alpha')).toBeInTheDocument();
    });

    fireEvent.contextMenu(screen.getByTestId('rf__node-task-alpha'));
    const openTerminalItem = await screen.findByRole('menuitem', { name: /Open Terminal/i });
    fireEvent.click(openTerminalItem);

    await waitFor(() => {
      expect(mock.api.openTerminal).toHaveBeenCalledTimes(2);
    });
    expect((mock.api.openTerminal as ReturnType<typeof vi.fn>).mock.calls.map(([taskId]) => taskId)).toEqual([
      'task-alpha',
      'task-alpha',
    ]);
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

  it('reports embedded terminal attach, snapshot, input, and output perf markers', async () => {
    const session = makeTerminalSession('task-alpha', {
      outputSnapshot: 'early line\n',
      command: 'sh',
      args: ['-lc', 'printf ready'],
    });

    render(
      <TerminalDrawer
        state="partial"
        onCycle={vi.fn()}
        sessions={[session]}
        activeSessionId={session.sessionId}
        onSelectSession={vi.fn()}
        onCloseSession={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(mock.api.reportUiPerf).toHaveBeenCalledWith(
        'embedded_terminal_attach',
        expect.objectContaining({
          sessionId: session.sessionId,
          taskId: session.taskId,
          active: true,
          hasSnapshot: true,
        }),
      );
    });
    expect(mock.api.reportUiPerf).toHaveBeenCalledWith(
      'embedded_terminal_snapshot_write',
      expect.objectContaining({
        source: 'attach',
        sessionId: session.sessionId,
        taskId: session.taskId,
        bytes: 'early line\n'.length,
      }),
    );

    vi.mocked(mock.api.reportUiPerf).mockClear();
    act(() => {
      xtermMock.instances[0]?.emitData('pwd\n');
    });
    expect(mock.api.reportUiPerf).toHaveBeenCalledWith(
      'embedded_terminal_input',
      expect.objectContaining({
        sessionId: session.sessionId,
        taskId: session.taskId,
        bytes: 'pwd\n'.length,
        active: true,
      }),
    );

    act(() => {
      mock.fireTerminalOutput({
        sessionId: session.sessionId,
        taskId: session.taskId,
        data: 'live line\n',
      });
    });
    await waitFor(() => {
      expect(mock.api.reportUiPerf).toHaveBeenCalledWith(
        'embedded_terminal_output_write',
        expect.objectContaining({
          sessionId: session.sessionId,
          taskId: session.taskId,
          bytes: 'live line\n'.length,
          active: true,
        }),
      );
    });

    vi.mocked(mock.api.reportUiPerf).mockClear();
    fireEvent.wheel(screen.getByTestId(`terminal-pane-${session.taskId}`), { deltaY: -800 });
    expect(mock.api.reportUiPerf).toHaveBeenCalledWith(
      'embedded_terminal_scroll',
      expect.objectContaining({
        sessionId: session.sessionId,
        taskId: session.taskId,
        deltaY: -800,
        active: true,
      }),
    );
  });

  it('keeps live output, input, and tab switching responsive under terminal pressure', async () => {
    const alpha = makeTerminalSession('task-alpha', {
      command: 'sh',
      args: ['-lc', 'alpha'],
    });
    const beta = makeTerminalSession('task-beta', {
      command: 'sh',
      args: ['-lc', 'beta'],
    });

    function Harness(): JSX.Element {
      const [activeSessionId, setActiveSessionId] = useState(alpha.sessionId);
      return (
        <TerminalDrawer
          state="partial"
          onCycle={vi.fn()}
          sessions={[alpha, beta]}
          activeSessionId={activeSessionId}
          onSelectSession={setActiveSessionId}
          onCloseSession={vi.fn()}
          taskLabels={new Map([
            [alpha.taskId, 'Alpha description'],
            [beta.taskId, 'Beta description'],
          ])}
        />
      );
    }

    render(<Harness />);
    await waitFor(() => expect(xtermMock.instances).toHaveLength(2));
    const initialWriteCount = xtermMock.writeLog.length;
    vi.mocked(mock.api.reportUiPerf).mockClear();

    act(() => {
      for (let index = 0; index < 80; index += 1) {
        mock.fireTerminalOutput({
          sessionId: alpha.sessionId,
          taskId: alpha.taskId,
          data: `alpha pressure output ${index}\n`,
        });
      }
    });

    await waitFor(() => expect(xtermMock.writeLog).toHaveLength(initialWriteCount + 80));
    expect(screen.getByTestId('terminal-tab-task-alpha')).toHaveAttribute('data-active', 'true');

    fireEvent.click(screen.getByRole('tab', { name: /Beta description/i }));
    await waitFor(() => {
      expect(screen.getByTestId('terminal-tab-task-beta')).toHaveAttribute('data-active', 'true');
    });

    act(() => {
      xtermMock.instances[1]?.emitData('printf beta\n');
    });
    expect(mock.api.terminalWrite).toHaveBeenCalledWith(beta.sessionId, 'printf beta\n');

    const outputPayloads = vi.mocked(mock.api.reportUiPerf).mock.calls
      .filter(([metric]) => metric === 'embedded_terminal_output_write')
      .map(([, data]) => data as Record<string, any>);
    expect(outputPayloads).toHaveLength(80);
    expect(Math.max(...outputPayloads.map((payload) => payload.durationMs))).toBeLessThanOrEqual(COMPONENT_TERMINAL_INTERACTION_BUDGET_MS);
    expect(outputPayloads.every((payload) => payload.active === true)).toBe(true);

    const inputPayload = vi.mocked(mock.api.reportUiPerf).mock.calls
      .filter(([metric]) => metric === 'embedded_terminal_input')
      .map(([, data]) => data as Record<string, any>)
      .at(-1);
    expect(inputPayload).toEqual(expect.objectContaining({
      sessionId: beta.sessionId,
      taskId: beta.taskId,
      active: true,
    }));
    expect(inputPayload?.durationMs).toBeLessThanOrEqual(COMPONENT_TERMINAL_INTERACTION_BUDGET_MS);

    await waitFor(() => {
      expect(mock.api.reportUiPerf).toHaveBeenCalledWith(
        'embedded_terminal_resize',
        expect.objectContaining({
          source: 'active_session',
          sessionId: beta.sessionId,
          taskId: beta.taskId,
          active: true,
        }),
      );
    });
  });

  it('does not duplicate the replay snapshot when a live mounted session receives an updated descriptor', async () => {
    const session = makeTerminalSession('task-alpha', {
      outputSnapshot: 'replayed once\n',
    });

    const { rerender } = render(
      <TerminalDrawer
        state="partial"
        onCycle={vi.fn()}
        sessions={[session]}
        activeSessionId={session.sessionId}
        onSelectSession={vi.fn()}
        onCloseSession={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(xtermMock.writeLog).toEqual(['replayed once\n']);
    });

    act(() => {
      mock.fireTerminalOutput({
        sessionId: session.sessionId,
        taskId: session.taskId,
        data: 'live line\n',
      });
    });
    await waitFor(() => {
      expect(xtermMock.writeLog).toEqual(['replayed once\n', 'live line\n']);
    });

    rerender(
      <TerminalDrawer
        state="partial"
        onCycle={vi.fn()}
        sessions={[{ ...session, outputSnapshot: 'replayed once\nlive line\n' }]}
        activeSessionId={session.sessionId}
        onSelectSession={vi.fn()}
        onCloseSession={vi.fn()}
      />,
    );

    expect(xtermMock.writeLog).toEqual(['replayed once\n', 'live line\n']);

    const newSession = makeTerminalSession('task-alpha', {
      sessionId: 'mock-session-task-alpha-restarted',
      outputSnapshot: 'new session replay\n',
    });
    rerender(
      <TerminalDrawer
        state="partial"
        onCycle={vi.fn()}
        sessions={[newSession]}
        activeSessionId={newSession.sessionId}
        onSelectSession={vi.fn()}
        onCloseSession={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(xtermMock.writeLog).toEqual(['replayed once\n', 'live line\n', 'new session replay\n']);
    });
  });

  it('keeps live output, input, resize, close, and tab selection intact without a preview row', async () => {
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
    expect(lastPerfPayload('embedded_terminal_tab_select')).toEqual(expect.objectContaining({
      sessionId: 'mock-session-task-alpha',
      taskId: 'task-alpha',
      previousActiveSessionId: 'mock-session-task-beta',
      sessionCount: 2,
      drawerState: 'partial',
    }));
    expect(lastPerfPayload('embedded_terminal_tab_select').durationMs).toBeLessThanOrEqual(COMPONENT_TERMINAL_INTERACTION_BUDGET_MS);

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
    });
    // The duplicate preview row is gone; live output only reaches the xterm pane.
    expect(screen.queryByTestId('terminal-session-output-preview')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Close terminal for Alpha description' }));
    await waitFor(() => {
      expect(mock.api.terminalClose).toHaveBeenCalledWith('mock-session-task-alpha');
    });
  });
});
