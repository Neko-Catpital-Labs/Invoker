/**
 * Component test: embedded terminal drawer wiring.
 *
 * Covers the renderer-side acceptance criteria for the
 * `implement-terminal-drawer-tabs` task:
 *   - opening a terminal expands the drawer
 *   - the same task id reuses a single tab
 *   - failures from openTerminal surface as an alert
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, waitFor, fireEvent } from '@testing-library/react';
import { createMockInvoker, makeTerminalSession, makeUITask, type MockInvoker } from './helpers/mock-invoker.js';
import type { WorkflowMeta } from '../types.js';
import type { TerminalOutputEvent } from '@invoker/contracts';

const xtermMock = vi.hoisted(() => {
  type DataHandler = (data: string) => void;
  type TerminalInstance = {
    cols: number;
    rows: number;
    writes: string[];
    dataHandlers: DataHandler[];
    loadAddon: ReturnType<typeof vi.fn>;
    open: ReturnType<typeof vi.fn>;
    write: ReturnType<typeof vi.fn>;
    onData: ReturnType<typeof vi.fn>;
    focus: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  };
  return {
    instances: [] as TerminalInstance[],
  };
});

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

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
    xtermMock.instances.length = 0;
    mock = createMockInvoker();
    mock.install();
    window.__INVOKER_TEST_CREATE_TERMINAL__ = () => {
      const instance = {
        cols: 80,
        rows: 24,
        writes: [] as string[],
        dataHandlers: [] as Array<(data: string) => void>,
        loadAddon: vi.fn(),
        open: vi.fn(),
        write: vi.fn((data: string) => {
          instance.writes.push(data);
        }),
        onData: vi.fn((handler: (data: string) => void) => {
          instance.dataHandlers.push(handler);
          return { dispose: vi.fn() };
        }),
        focus: vi.fn(),
        dispose: vi.fn(),
      };
      xtermMock.instances.push(instance);
      return {
        terminal: instance,
        fitAddon: { fit: vi.fn() },
      };
    };
  });

  afterEach(() => {
    mock.cleanup();
    delete window.__INVOKER_TEST_ON_TERMINAL_OUTPUT__;
    delete window.__INVOKER_TEST_CREATE_TERMINAL__;
    xtermMock.instances.length = 0;
    vi.restoreAllMocks();
  });

  it('starts collapsed with no terminal pane visible', async () => {
    render(<App />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Expand terminal drawer' })).toBeInTheDocument();
    });
    expect(screen.queryByTestId('terminal-drawer-body')).not.toBeInTheDocument();
  });

  it('expands the drawer and adds a tab when opening a terminal via double-click', async () => {
    render(<App />);
    act(() => mock.setTasks([taskAlpha, taskBeta], workflows));
    await selectWorkflow();

    fireEvent.doubleClick(screen.getByTestId('rf__node-task-alpha'));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Collapse terminal drawer' })).toBeInTheDocument();
      expect(screen.getByTestId('terminal-drawer-body')).toBeInTheDocument();
      expect(screen.getByTestId('terminal-tab-task-alpha')).toBeInTheDocument();
    });
    expect(mock.api.openTerminal).toHaveBeenCalledWith('task-alpha');
  });

  it('reuses an existing tab when opening the same task twice', async () => {
    render(<App />);
    act(() => mock.setTasks([taskAlpha], workflows));
    await selectWorkflow();

    fireEvent.doubleClick(screen.getByTestId('rf__node-task-alpha'));
    await waitFor(() => {
      expect(screen.getByTestId('terminal-tab-task-alpha')).toBeInTheDocument();
    });

    // Collapse, then re-open — should not duplicate the tab.
    fireEvent.click(screen.getByRole('button', { name: 'Collapse terminal drawer' }));
    fireEvent.doubleClick(screen.getByTestId('rf__node-task-alpha'));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Collapse terminal drawer' })).toBeInTheDocument();
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

    // Tab strip and toggle live in the same flex row so the toggle stays visible.
    const tabStrip = screen.getByTestId('terminal-tab-strip');
    const toggle = screen.getByRole('button', { name: 'Collapse terminal drawer' });
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
      expect(screen.getByRole('button', { name: 'Collapse terminal drawer' })).toBeInTheDocument();
      expect(screen.getByTestId('terminal-tab-task-alpha')).toBeInTheDocument();
    });
    expect(mock.api.openTerminal).toHaveBeenCalledWith('task-alpha');
  });

  it('writes a restored session output snapshot before live terminal output', async () => {
    const session = makeTerminalSession({
      taskId: 'task-alpha',
      outputSnapshot: 'early output\n',
    });
    (mock.api.terminalList as ReturnType<typeof vi.fn>).mockResolvedValueOnce([session]);
    let emitTerminalOutput: ((event: TerminalOutputEvent) => void) | null = null;
    window.__INVOKER_TEST_ON_TERMINAL_OUTPUT__ = vi.fn((cb) => {
      emitTerminalOutput = cb;
      return () => { emitTerminalOutput = null; };
    });

    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Expand terminal drawer' }));
    await waitFor(() => {
      expect(xtermMock.instances).toHaveLength(1);
      expect(emitTerminalOutput).not.toBeNull();
    });

    act(() => {
      emitTerminalOutput?.({
        sessionId: session.sessionId,
        taskId: session.taskId,
        data: 'live output\n',
      });
    });

    expect(xtermMock.instances[0].writes).toEqual(['early output\n', 'live output\n']);
  });

  it('does not duplicate the output snapshot when the same pane re-renders', async () => {
    const session = makeTerminalSession({
      taskId: 'task-alpha',
      outputSnapshot: 'seed once\n',
    });
    const noop = vi.fn();
    const props = {
      collapsed: false,
      onToggle: noop,
      sessions: [session],
      activeSessionId: session.sessionId,
      onSelectSession: noop,
      onCloseSession: noop,
    };

    const { rerender } = render(<TerminalDrawer {...props} />);
    await waitFor(() => {
      expect(xtermMock.instances).toHaveLength(1);
      expect(xtermMock.instances[0].writes).toEqual(['seed once\n']);
    });

    rerender(<TerminalDrawer {...props} taskLabels={new Map([[session.taskId, 'Alpha description']])} />);

    expect(xtermMock.instances).toHaveLength(1);
    expect(xtermMock.instances[0].writes).toEqual(['seed once\n']);
  });
});
