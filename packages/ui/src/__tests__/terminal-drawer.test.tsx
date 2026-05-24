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
import type { TerminalOutputEvent } from '@invoker/contracts';
import { createMockInvoker, makeUITask, type MockInvoker } from './helpers/mock-invoker.js';
import type { WorkflowMeta } from '../types.js';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

interface XTermInstanceRecord {
  writeCalls: string[];
  opened: boolean;
  disposed: boolean;
  inputCallbacks: Array<(data: string) => void>;
}

const xtermInstances: XTermInstanceRecord[] = [];

vi.mock('xterm', () => {
  class MockTerminal {
    cols = 80;
    rows = 24;
    private readonly record: XTermInstanceRecord;
    constructor() {
      this.record = { writeCalls: [], opened: false, disposed: false, inputCallbacks: [] };
      xtermInstances.push(this.record);
    }
    loadAddon(): void {
      /* no-op */
    }
    open(): void {
      this.record.opened = true;
    }
    write(data: string): void {
      this.record.writeCalls.push(data);
    }
    onData(cb: (data: string) => void): { dispose: () => void } {
      this.record.inputCallbacks.push(cb);
      return { dispose: () => {} };
    }
    focus(): void {
      /* no-op */
    }
    dispose(): void {
      this.record.disposed = true;
    }
  }
  return { Terminal: MockTerminal };
});

vi.mock('xterm-addon-fit', () => {
  class MockFitAddon {
    fit(): void {
      /* no-op */
    }
  }
  return { FitAddon: MockFitAddon };
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
    delete (window as { __INVOKER_TEST_ON_TERMINAL_OUTPUT__?: unknown }).__INVOKER_TEST_ON_TERMINAL_OUTPUT__;
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

  it('seeds xterm with the session output snapshot before live output, and only once', async () => {
    const sessionWithSnapshot = {
      sessionId: 'mock-session-task-alpha',
      taskId: 'task-alpha',
      status: 'running' as const,
      mode: 'spawn' as const,
      attached: false,
      createdAt: new Date('2025-01-01T00:00:00Z').toISOString(),
      outputSnapshot: 'replayed initial output\r\n',
    };
    (mock.api.openTerminal as ReturnType<typeof vi.fn>).mockResolvedValue({
      opened: true,
      session: sessionWithSnapshot,
    });

    let liveOutputCallback: ((event: TerminalOutputEvent) => void) | undefined;
    (window as {
      __INVOKER_TEST_ON_TERMINAL_OUTPUT__?: (cb: (event: TerminalOutputEvent) => void) => () => void;
    }).__INVOKER_TEST_ON_TERMINAL_OUTPUT__ = (cb) => {
      liveOutputCallback = cb;
      return () => {
        liveOutputCallback = undefined;
      };
    };

    render(<App />);
    act(() => mock.setTasks([taskAlpha], workflows));
    await selectWorkflow();

    fireEvent.doubleClick(screen.getByTestId('rf__node-task-alpha'));

    await waitFor(() => {
      expect(screen.getByTestId('terminal-tab-task-alpha')).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(xtermInstances).toHaveLength(1);
      expect(xtermInstances[0].opened).toBe(true);
    });
    await waitFor(() => {
      expect(xtermInstances[0].writeCalls).toEqual(['replayed initial output\r\n']);
    });

    // Live output after seeding lands in the same xterm as a separate write
    // following the snapshot, in order.
    act(() => {
      liveOutputCallback?.({
        sessionId: 'mock-session-task-alpha',
        taskId: 'task-alpha',
        data: 'live event payload\r\n',
      });
    });
    expect(xtermInstances[0].writeCalls).toEqual([
      'replayed initial output\r\n',
      'live event payload\r\n',
    ]);

    // Re-opening the same task re-renders the pane with a fresh session prop
    // (same sessionId) but must not re-seed the snapshot into the same xterm.
    fireEvent.doubleClick(screen.getByTestId('rf__node-task-alpha'));
    await waitFor(() => {
      expect(mock.api.openTerminal).toHaveBeenCalledTimes(2);
    });
    expect(xtermInstances).toHaveLength(1);
    const alphaSnapshotWrites = xtermInstances[0].writeCalls.filter(
      (data) => data === 'replayed initial output\r\n',
    );
    expect(alphaSnapshotWrites).toHaveLength(1);
  });

  it('skips snapshot seeding when the session has no outputSnapshot', async () => {
    // The default openTerminal mock returns a session without outputSnapshot.
    render(<App />);
    act(() => mock.setTasks([taskAlpha], workflows));
    await selectWorkflow();

    fireEvent.doubleClick(screen.getByTestId('rf__node-task-alpha'));

    await waitFor(() => {
      expect(xtermInstances).toHaveLength(1);
      expect(xtermInstances[0].opened).toBe(true);
    });
    expect(xtermInstances[0].writeCalls).toEqual([]);
  });
});
