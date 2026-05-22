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

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

// Capture xterm.js writes so seeding can be asserted under jsdom. The real
// xterm depends on Canvas APIs which jsdom does not implement, so a minimal
// stub keeps the component code path realistic while remaining inspectable.
const xtermState = vi.hoisted(() => ({
  instances: [] as Array<{
    writes: string[];
    disposed: boolean;
    inputCallbacks: Array<(data: string) => void>;
    sessionContainerId?: string;
  }>,
  reset() {
    this.instances.length = 0;
  },
}));

vi.mock('xterm', () => {
  class MockTerminal {
    cols = 80;
    rows = 24;
    writes: string[] = [];
    disposed = false;
    inputCallbacks: Array<(data: string) => void> = [];
    sessionContainerId?: string;
    constructor(_opts?: unknown) {
      xtermState.instances.push(this);
    }
    open(host: HTMLElement) {
      this.sessionContainerId = host.getAttribute('data-session-id') ?? undefined;
    }
    loadAddon(_addon: unknown) {}
    write(data: string) {
      this.writes.push(data);
    }
    onData(cb: (data: string) => void) {
      this.inputCallbacks.push(cb);
      return {
        dispose: () => {
          this.inputCallbacks = this.inputCallbacks.filter((existing) => existing !== cb);
        },
      };
    }
    focus() {}
    dispose() {
      this.disposed = true;
    }
  }
  return { Terminal: MockTerminal };
});

vi.mock('xterm-addon-fit', () => {
  class MockFitAddon {
    fit() {}
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
    xtermState.reset();
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

  it('seeds xterm with the replay snapshot returned from openTerminal', async () => {
    const snapshot = 'first PTY line\r\n$ pwd\r\n/tmp/work\r\n';
    (mock.api.openTerminal as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      opened: true,
      session: makeTerminalSession({ taskId: 'task-alpha', outputSnapshot: snapshot }),
    });

    render(<App />);
    act(() => mock.setTasks([taskAlpha], workflows));
    await selectWorkflow();

    fireEvent.doubleClick(screen.getByTestId('rf__node-task-alpha'));
    await waitFor(() => {
      expect(screen.getByTestId('terminal-tab-task-alpha')).toBeInTheDocument();
    });

    await waitFor(() => {
      const instance = xtermState.instances.find(
        (term) => term.sessionContainerId === 'mock-session-task-alpha',
      );
      expect(instance?.writes).toEqual([snapshot]);
    });
  });

  it('does not duplicate the snapshot when the session pane re-renders', async () => {
    const snapshot = 'replay buffer contents\r\n';
    (mock.api.openTerminal as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      opened: true,
      session: makeTerminalSession({ taskId: 'task-alpha', outputSnapshot: snapshot }),
    });

    render(<App />);
    act(() => mock.setTasks([taskAlpha], workflows));
    await selectWorkflow();

    fireEvent.doubleClick(screen.getByTestId('rf__node-task-alpha'));
    await waitFor(() => {
      const instance = xtermState.instances.find(
        (term) => term.sessionContainerId === 'mock-session-task-alpha',
      );
      expect(instance?.writes).toEqual([snapshot]);
    });

    // Provoke re-renders that share the same session id.
    act(() => mock.fireDelta({
      type: 'updated',
      taskId: 'task-alpha',
      changes: { description: 'Alpha description (updated)' },
      taskStateVersion: 2,
      previousTaskStateVersion: 1,
    }));
    fireEvent.doubleClick(screen.getByTestId('rf__node-task-alpha'));

    await waitFor(() => {
      expect(mock.api.openTerminal).toHaveBeenCalledTimes(2);
    });

    const instance = xtermState.instances.find(
      (term) => term.sessionContainerId === 'mock-session-task-alpha',
    );
    expect(instance?.writes).toEqual([snapshot]);
    expect(instance?.disposed).toBe(false);
  });

  it('seeds xterm with the snapshot reported by terminalList on app mount', async () => {
    const snapshot = 'live session caught up\r\n';
    mock.setTerminalListSeed([
      makeTerminalSession({ taskId: 'task-alpha', outputSnapshot: snapshot }),
    ]);

    render(<App />);
    act(() => mock.setTasks([taskAlpha], workflows));

    await waitFor(() => {
      expect(screen.getByTestId('terminal-tab-task-alpha')).toBeInTheDocument();
    });

    // The drawer starts collapsed after terminalList seeds sessions; expand it
    // to mount the pane so the snapshot is written into xterm.
    fireEvent.click(screen.getByRole('button', { name: 'Expand terminal drawer' }));

    await waitFor(() => {
      const instance = xtermState.instances.find(
        (term) => term.sessionContainerId === 'mock-session-task-alpha',
      );
      expect(instance?.writes).toEqual([snapshot]);
    });
  });

  it('routes live output writes to xterm after the snapshot seed', async () => {
    const snapshot = 'pre-subscribe output\r\n';
    const liveListeners: Array<(event: { sessionId: string; taskId: string; data: string }) => void> = [];
    (window as unknown as { __INVOKER_TEST_ON_TERMINAL_OUTPUT__: (cb: (event: { sessionId: string; taskId: string; data: string }) => void) => () => void }).__INVOKER_TEST_ON_TERMINAL_OUTPUT__ = (cb) => {
      liveListeners.push(cb);
      return () => {
        const index = liveListeners.indexOf(cb);
        if (index >= 0) liveListeners.splice(index, 1);
      };
    };

    (mock.api.openTerminal as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      opened: true,
      session: makeTerminalSession({ taskId: 'task-alpha', outputSnapshot: snapshot }),
    });

    render(<App />);
    act(() => mock.setTasks([taskAlpha], workflows));
    await selectWorkflow();
    fireEvent.doubleClick(screen.getByTestId('rf__node-task-alpha'));

    await waitFor(() => {
      const instance = xtermState.instances.find(
        (term) => term.sessionContainerId === 'mock-session-task-alpha',
      );
      expect(instance?.writes).toEqual([snapshot]);
    });

    act(() => {
      for (const cb of liveListeners) {
        cb({ sessionId: 'mock-session-task-alpha', taskId: 'task-alpha', data: 'live append\r\n' });
      }
    });

    const instance = xtermState.instances.find(
      (term) => term.sessionContainerId === 'mock-session-task-alpha',
    );
    expect(instance?.writes).toEqual([snapshot, 'live append\r\n']);

    delete (window as unknown as { __INVOKER_TEST_ON_TERMINAL_OUTPUT__?: unknown }).__INVOKER_TEST_ON_TERMINAL_OUTPUT__;
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
});
