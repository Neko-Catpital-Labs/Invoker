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
import {
  createMockInvoker,
  makeTerminalSessionDescriptor,
  makeUITask,
  type MockInvoker,
} from './helpers/mock-invoker.js';
import type { TerminalOutputEvent } from '@invoker/contracts';
import type { WorkflowMeta } from '../types.js';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

const xtermMock = vi.hoisted(() => {
  type Instance = {
    writes: string[];
    disposed: boolean;
    onDataCb: ((data: string) => void) | null;
  };
  const instances: Instance[] = [];
  return { instances };
});

vi.mock('xterm', () => {
  class Terminal {
    cols = 80;
    rows = 24;
    writes: string[] = [];
    disposed = false;
    onDataCb: ((data: string) => void) | null = null;
    constructor(_options?: unknown) {
      xtermMock.instances.push(this as unknown as (typeof xtermMock.instances)[number]);
    }
    loadAddon(_addon: unknown): void {}
    open(_host: HTMLElement): void {}
    onData(cb: (data: string) => void): { dispose: () => void } {
      this.onDataCb = cb;
      return {
        dispose: () => {
          this.onDataCb = null;
        },
      };
    }
    write(data: string): void {
      this.writes.push(data);
    }
    focus(): void {}
    dispose(): void {
      this.disposed = true;
    }
  }
  return { Terminal };
});

vi.mock('xterm-addon-fit', () => {
  class FitAddon {
    fit(): void {}
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
    mock = createMockInvoker();
    mock.install();
    xtermMock.instances.length = 0;
  });

  afterEach(() => {
    mock.cleanup();
    delete (window as unknown as { __INVOKER_TEST_ON_TERMINAL_OUTPUT__?: unknown })
      .__INVOKER_TEST_ON_TERMINAL_OUTPUT__;
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

  it('seeds the xterm instance with the session output snapshot before live output', async () => {
    const snapshot = 'replayed-stdout\r\n$ ';
    (mock.api.openTerminal as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      opened: true,
      session: makeTerminalSessionDescriptor({
        sessionId: 'session-with-snapshot',
        taskId: 'task-alpha',
        outputSnapshot: snapshot,
      }),
    });

    let emitOutput: ((event: TerminalOutputEvent) => void) | null = null;
    (window as unknown as {
      __INVOKER_TEST_ON_TERMINAL_OUTPUT__?: (cb: (event: TerminalOutputEvent) => void) => () => void;
    }).__INVOKER_TEST_ON_TERMINAL_OUTPUT__ = (cb) => {
      emitOutput = cb;
      return () => {
        emitOutput = null;
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
      expect(xtermMock.instances.length).toBeGreaterThan(0);
    });

    const instance = xtermMock.instances[0];
    expect(instance.writes[0]).toBe(snapshot);

    act(() => {
      emitOutput?.({ sessionId: 'session-with-snapshot', taskId: 'task-alpha', data: 'live-data' });
    });

    expect(instance.writes).toEqual([snapshot, 'live-data']);
  });

  it('does not duplicate the snapshot write when the parent re-renders the session', async () => {
    const snapshot = 'one-time-snapshot';
    (mock.api.openTerminal as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      opened: true,
      session: makeTerminalSessionDescriptor({
        sessionId: 'session-rerender',
        taskId: 'task-alpha',
        outputSnapshot: snapshot,
      }),
    });

    render(<App />);
    act(() => mock.setTasks([taskAlpha, taskBeta], workflows));
    await selectWorkflow();

    fireEvent.doubleClick(screen.getByTestId('rf__node-task-alpha'));
    await waitFor(() => {
      expect(screen.getByTestId('terminal-tab-task-alpha')).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(xtermMock.instances.length).toBeGreaterThan(0);
    });
    const initialWriteCount = xtermMock.instances[0].writes.filter((entry) => entry === snapshot).length;
    expect(initialWriteCount).toBe(1);

    // Trigger a parent re-render (collapse + re-expand should not re-seed
    // the existing terminal because the session id is unchanged).
    fireEvent.click(screen.getByRole('button', { name: 'Collapse terminal drawer' }));
    fireEvent.click(screen.getByRole('button', { name: 'Expand terminal drawer' }));

    await waitFor(() => {
      expect(screen.getByTestId('terminal-drawer-body')).toBeInTheDocument();
    });

    // Only the original instance should carry the seeded snapshot; even if a
    // new xterm was constructed on remount, each instance must contain the
    // snapshot at most once (no duplicates per terminal).
    for (const instance of xtermMock.instances) {
      const snapshotWrites = instance.writes.filter((entry) => entry === snapshot).length;
      expect(snapshotWrites).toBeLessThanOrEqual(1);
    }
    const totalSnapshotWrites = xtermMock.instances.reduce(
      (count, instance) => count + instance.writes.filter((entry) => entry === snapshot).length,
      0,
    );
    expect(totalSnapshotWrites).toBeGreaterThanOrEqual(1);
  });

  it('seeds panes opened from a terminalList reload with their snapshot', async () => {
    const snapshot = 'reload-replay';
    (mock.api.terminalList as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      makeTerminalSessionDescriptor({
        sessionId: 'reloaded-session',
        taskId: 'task-alpha',
        outputSnapshot: snapshot,
      }),
    ]);

    render(<App />);
    act(() => mock.setTasks([taskAlpha], workflows));

    await waitFor(() => {
      expect(screen.getByTestId('terminal-tab-task-alpha')).toBeInTheDocument();
    });

    // Pane (and therefore xterm) only mounts when the drawer body is visible.
    fireEvent.click(screen.getByRole('button', { name: 'Expand terminal drawer' }));

    await waitFor(() => {
      expect(xtermMock.instances.length).toBeGreaterThan(0);
    });

    const seeded = xtermMock.instances.find((instance) => instance.writes.includes(snapshot));
    expect(seeded).toBeDefined();
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
