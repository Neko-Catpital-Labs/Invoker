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

// Replace xterm with a tracking stub so jsdom doesn't try to use a real
// canvas-backed renderer and so tests can assert what was written to each
// terminal instance (used to verify replay-snapshot seeding).
vi.mock('xterm', () => {
  const instances: Array<{ writes: string[] }> = [];
  class Terminal {
    cols = 80;
    rows = 24;
    private readonly _record: { writes: string[] };
    constructor(_opts?: unknown) {
      this._record = { writes: [] };
      instances.push(this._record);
    }
    loadAddon(_addon: unknown): void {}
    open(_host: HTMLElement): void {}
    onData(_cb: (data: string) => void): { dispose: () => void } {
      return { dispose: () => {} };
    }
    write(data: string): void {
      this._record.writes.push(data);
    }
    focus(): void {}
    dispose(): void {}
  }
  return {
    Terminal,
    __xtermInstances__: instances,
    __resetXtermInstances__: () => { instances.length = 0; },
  };
});

vi.mock('xterm-addon-fit', () => {
  class FitAddon {
    fit(): void {}
  }
  return { FitAddon };
});

interface XTermMockModule {
  __xtermInstances__: Array<{ writes: string[] }>;
  __resetXtermInstances__: () => void;
}

const xtermMock = (await import('xterm')) as unknown as XTermMockModule;

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
    xtermMock.__resetXtermInstances__();
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

  it('writes the session replay snapshot into xterm when the pane mounts', async () => {
    const snapshot = '[32mwelcome[0m\r\n$ echo seeded\r\nseeded\r\n';
    (mock.api.openTerminal as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      opened: true,
      session: {
        sessionId: 'mock-session-task-alpha',
        taskId: 'task-alpha',
        status: 'running',
        mode: 'spawn',
        attached: false,
        createdAt: new Date('2025-01-01T00:00:00Z').toISOString(),
        command: 'bash',
        outputSnapshot: snapshot,
      },
    });

    render(<App />);
    act(() => mock.setTasks([taskAlpha], workflows));
    await selectWorkflow();

    fireEvent.doubleClick(screen.getByTestId('rf__node-task-alpha'));

    await waitFor(() => {
      expect(screen.getByTestId('terminal-tab-task-alpha')).toBeInTheDocument();
    });

    await waitFor(() => {
      const allWrites = xtermMock.__xtermInstances__.flatMap((instance) => instance.writes);
      expect(allWrites).toContain(snapshot);
    });

    // The snapshot's last non-empty line should also flow through onOutput so
    // the drawer's output preview reflects pre-mount output.
    await waitFor(() => {
      expect(screen.getByTestId('terminal-session-output-preview')).toHaveTextContent('seeded');
    });
  });

  it('does not duplicate the replay snapshot on parent re-renders', async () => {
    const snapshot = 'initial replay\r\n';
    (mock.api.openTerminal as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      opened: true,
      session: {
        sessionId: 'mock-session-task-alpha',
        taskId: 'task-alpha',
        status: 'running',
        mode: 'spawn',
        attached: false,
        createdAt: new Date('2025-01-01T00:00:00Z').toISOString(),
        outputSnapshot: snapshot,
      },
    });

    render(<App />);
    act(() => mock.setTasks([taskAlpha], workflows));
    await selectWorkflow();

    fireEvent.doubleClick(screen.getByTestId('rf__node-task-alpha'));

    await waitFor(() => {
      expect(screen.getByTestId('terminal-tab-task-alpha')).toBeInTheDocument();
    });

    // Force several parent re-renders by firing task deltas. The pane's
    // useEffect deps are stable (sessionId + stable callback), so it must
    // not re-seed the snapshot on each re-render.
    act(() => {
      mock.fireDelta({ type: 'updated', task: { ...taskAlpha, status: 'running' } });
      mock.fireDelta({ type: 'updated', task: { ...taskAlpha, status: 'completed' } });
    });

    await waitFor(() => {
      expect(screen.getByTestId('terminal-tab-task-alpha')).toBeInTheDocument();
    });

    const seededInstance = xtermMock.__xtermInstances__
      .find((instance) => instance.writes.some((data) => data === snapshot));
    expect(seededInstance).toBeDefined();
    const snapshotWrites = seededInstance!.writes.filter((data) => data === snapshot);
    expect(snapshotWrites).toHaveLength(1);
  });

  it('skips replay seeding when the session has no snapshot', async () => {
    (mock.api.openTerminal as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      opened: true,
      session: {
        sessionId: 'mock-session-task-alpha',
        taskId: 'task-alpha',
        status: 'running',
        mode: 'spawn',
        attached: false,
        createdAt: new Date('2025-01-01T00:00:00Z').toISOString(),
        // No outputSnapshot field at all.
      },
    });

    render(<App />);
    act(() => mock.setTasks([taskAlpha], workflows));
    await selectWorkflow();

    fireEvent.doubleClick(screen.getByTestId('rf__node-task-alpha'));

    await waitFor(() => {
      expect(screen.getByTestId('terminal-tab-task-alpha')).toBeInTheDocument();
    });

    const totalWrites = xtermMock.__xtermInstances__.reduce(
      (sum, instance) => sum + instance.writes.length,
      0,
    );
    expect(totalWrites).toBe(0);
    expect(screen.queryByTestId('terminal-session-output-preview')).not.toBeInTheDocument();
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
