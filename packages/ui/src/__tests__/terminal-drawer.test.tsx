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
import { createMockInvoker, makeUITask, type MockInvoker } from './helpers/mock-invoker.js';
import type { WorkflowMeta } from '../types.js';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

// Mock xterm so we can observe seeding into the freshly opened terminal.
// jsdom can construct the real xterm Terminal but it pulls in canvas/DOM
// features we do not need for these tests, and we want a stable hook into
// `write()` so we can assert the replay snapshot is delivered.
interface XTermMockInstance {
  write: ReturnType<typeof vi.fn>;
  onData: ReturnType<typeof vi.fn>;
  loadAddon: ReturnType<typeof vi.fn>;
  open: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  cols: number;
  rows: number;
}
const xtermInstances: XTermMockInstance[] = [];

vi.mock('xterm', () => {
  class Terminal implements XTermMockInstance {
    cols = 80;
    rows = 24;
    write = vi.fn();
    onData = vi.fn(() => ({ dispose: vi.fn() }));
    loadAddon = vi.fn();
    open = vi.fn();
    focus = vi.fn();
    dispose = vi.fn();
    constructor() {
      xtermInstances.push(this);
    }
  }
  return { Terminal };
});

vi.mock('xterm-addon-fit', () => {
  class FitAddon {
    fit = vi.fn();
    activate = vi.fn();
    dispose = vi.fn();
  }
  return { FitAddon };
});

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
    xtermInstances.length = 0;
    mock = createMockInvoker();
    mock.install();
  });

  afterEach(() => {
    mock.cleanup();
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

  it('seeds xterm with the session replay snapshot and does not duplicate on re-render', async () => {
    const replaySnapshot = 'pre-subscribe banner output\r\n$ ';
    (mock.api.openTerminal as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      opened: true,
      session: {
        sessionId: 'mock-session-task-alpha',
        taskId: 'task-alpha',
        status: 'running',
        mode: 'spawn',
        attached: false,
        createdAt: new Date('2025-01-01T00:00:00Z').toISOString(),
        outputSnapshot: replaySnapshot,
      },
    });

    render(<App />);
    act(() => mock.setTasks([taskAlpha, taskBeta], workflows));
    await selectWorkflow();

    fireEvent.doubleClick(screen.getByTestId('rf__node-task-alpha'));

    await waitFor(() => {
      expect(screen.getByTestId('terminal-tab-task-alpha')).toBeInTheDocument();
    });

    // Exactly one xterm instance for the new alpha pane.
    expect(xtermInstances).toHaveLength(1);
    const term = xtermInstances[0]!;
    const writeMock = term.write as ReturnType<typeof vi.fn>;
    expect(writeMock).toHaveBeenCalledWith(replaySnapshot);
    expect(writeMock.mock.calls.filter((args) => args[0] === replaySnapshot)).toHaveLength(1);
    const seedingCallCount = writeMock.mock.calls.length;

    // Force a parent re-render that does not change session.sessionId: open a
    // second task. The alpha pane should not re-seed its snapshot.
    fireEvent.doubleClick(screen.getByTestId('rf__node-task-beta'));
    await waitFor(() => {
      expect(screen.getByTestId('terminal-tab-task-beta')).toBeInTheDocument();
    });

    expect(writeMock.mock.calls.filter((args) => args[0] === replaySnapshot)).toHaveLength(1);
    expect(writeMock.mock.calls.length).toBe(seedingCallCount);

    // Switch active tab back to alpha — still no re-seeding.
    fireEvent.click(screen.getByRole('tab', { name: /Alpha description/i }));
    expect(writeMock.mock.calls.filter((args) => args[0] === replaySnapshot)).toHaveLength(1);
  });

  it('mounts a terminal pane without seeding when the session has no replay snapshot', async () => {
    render(<App />);
    act(() => mock.setTasks([taskAlpha], workflows));
    await selectWorkflow();

    fireEvent.doubleClick(screen.getByTestId('rf__node-task-alpha'));

    await waitFor(() => {
      expect(screen.getByTestId('terminal-tab-task-alpha')).toBeInTheDocument();
    });

    expect(xtermInstances).toHaveLength(1);
    const writeMock = xtermInstances[0]!.write as ReturnType<typeof vi.fn>;
    expect(writeMock).not.toHaveBeenCalled();
  });
});
