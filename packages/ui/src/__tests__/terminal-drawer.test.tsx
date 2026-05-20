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
  makeTerminalSession,
  makeUITask,
  type MockInvoker,
} from './helpers/mock-invoker.js';
import type { WorkflowMeta } from '../types.js';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

// xterm/xterm-addon-fit reach into real DOM APIs (canvas, ResizeObserver) that
// jsdom does not implement. The production code wraps construction in a
// try/catch so panes still render in jsdom, but replay seeding has to write
// into the terminal — we mock xterm so the constructor succeeds and tests can
// observe `term.write(...)` calls.
interface MockTerm {
  write: ReturnType<typeof vi.fn>;
  onData: ReturnType<typeof vi.fn>;
  loadAddon: ReturnType<typeof vi.fn>;
  open: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  cols: number;
  rows: number;
}

const xtermMocks = vi.hoisted(() => {
  const instances: Array<unknown> = [];
  return { instances };
});

vi.mock('xterm', () => ({
  Terminal: vi.fn(() => {
    const instance = {
      write: vi.fn(),
      onData: vi.fn(() => ({ dispose: vi.fn() })),
      loadAddon: vi.fn(),
      open: vi.fn(),
      focus: vi.fn(),
      dispose: vi.fn(),
      cols: 80,
      rows: 24,
    };
    xtermMocks.instances.push(instance);
    return instance;
  }),
}));

vi.mock('xterm-addon-fit', () => ({
  FitAddon: vi.fn(() => ({ fit: vi.fn() })),
}));

function latestTerm(): MockTerm {
  const term = xtermMocks.instances.at(-1) as MockTerm | undefined;
  if (!term) throw new Error('No xterm instance has been constructed yet.');
  return term;
}

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
    xtermMocks.instances.length = 0;
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

  it('seeds the xterm pane with the descriptor replay snapshot on mount', async () => {
    (mock.api.openTerminal as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      opened: true,
      session: makeTerminalSession({
        sessionId: 'session-replay-alpha',
        taskId: 'task-alpha',
        outputSnapshot: 'early replay output\r\n',
      }),
    });

    render(<App />);
    act(() => mock.setTasks([taskAlpha], workflows));
    await selectWorkflow();

    fireEvent.doubleClick(screen.getByTestId('rf__node-task-alpha'));
    await waitFor(() => {
      expect(screen.getByTestId('terminal-tab-task-alpha')).toBeInTheDocument();
    });

    const term = latestTerm();
    expect(term.write).toHaveBeenCalledWith('early replay output\r\n');
    expect(term.write).toHaveBeenCalledTimes(1);
  });

  it('does not seed when the descriptor has no replay snapshot', async () => {
    // Default mock openTerminal omits `outputSnapshot`.
    render(<App />);
    act(() => mock.setTasks([taskAlpha], workflows));
    await selectWorkflow();

    fireEvent.doubleClick(screen.getByTestId('rf__node-task-alpha'));
    await waitFor(() => {
      expect(screen.getByTestId('terminal-tab-task-alpha')).toBeInTheDocument();
    });

    const term = latestTerm();
    expect(term.write).not.toHaveBeenCalled();
  });

  it('does not duplicate the snapshot write when the pane re-renders', async () => {
    (mock.api.openTerminal as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        opened: true,
        session: makeTerminalSession({
          sessionId: 'session-replay-alpha',
          taskId: 'task-alpha',
          outputSnapshot: 'snapshot-A\r\n',
        }),
      })
      .mockResolvedValueOnce({
        opened: true,
        session: makeTerminalSession({
          sessionId: 'session-replay-beta',
          taskId: 'task-beta',
          outputSnapshot: 'snapshot-B\r\n',
        }),
      });

    render(<App />);
    act(() => mock.setTasks([taskAlpha, taskBeta], workflows));
    await selectWorkflow();

    fireEvent.doubleClick(screen.getByTestId('rf__node-task-alpha'));
    await waitFor(() => {
      expect(screen.getByTestId('terminal-tab-task-alpha')).toBeInTheDocument();
    });
    const termAlpha = latestTerm();
    expect(termAlpha.write).toHaveBeenCalledWith('snapshot-A\r\n');
    expect(termAlpha.write).toHaveBeenCalledTimes(1);

    // Opening a second terminal forces TerminalDrawer to re-render; the alpha
    // pane stays mounted and its xterm must not receive another snapshot write.
    fireEvent.doubleClick(screen.getByTestId('rf__node-task-beta'));
    await waitFor(() => {
      expect(screen.getByTestId('terminal-tab-task-beta')).toBeInTheDocument();
    });

    expect(termAlpha.write).toHaveBeenCalledTimes(1);
    // Beta got its own freshly-constructed xterm with its own snapshot write.
    const termBeta = latestTerm();
    expect(termBeta).not.toBe(termAlpha);
    expect(termBeta.write).toHaveBeenCalledWith('snapshot-B\r\n');
    expect(termBeta.write).toHaveBeenCalledTimes(1);
  });
});
