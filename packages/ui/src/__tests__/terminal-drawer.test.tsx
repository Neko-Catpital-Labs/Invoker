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
import {
  getMockTerminals,
  resetMockTerminals,
} from './helpers/mock-xterm.js';
import type { TerminalSessionDescriptor } from '@invoker/contracts';
import type { WorkflowMeta } from '../types.js';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

vi.mock('xterm', async () => {
  const { createXtermMock } = await import('./helpers/mock-xterm.js');
  return createXtermMock();
});

vi.mock('xterm-addon-fit', async () => {
  const { createXtermAddonFitMock } = await import('./helpers/mock-xterm.js');
  return createXtermAddonFitMock();
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
    mock = createMockInvoker();
    mock.install();
    resetMockTerminals();
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

  it('seeds xterm with the session replay snapshot when a terminal opens', async () => {
    render(<App />);
    act(() => mock.setTasks([taskAlpha], workflows));
    await selectWorkflow();

    fireEvent.doubleClick(screen.getByTestId('rf__node-task-alpha'));
    await waitFor(() => {
      expect(screen.getByTestId('terminal-tab-task-alpha')).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(getMockTerminals().length).toBeGreaterThan(0);
    });
    const term = getMockTerminals().at(-1)!;
    expect(term.write).toHaveBeenCalledWith('mock-replay[task-alpha]');
  });
});

describe('TerminalDrawer replay seeding (unit)', () => {
  let mock: MockInvoker;

  beforeEach(() => {
    mock = createMockInvoker();
    mock.install();
    resetMockTerminals();
  });

  afterEach(() => {
    mock.cleanup();
    vi.restoreAllMocks();
  });

  function makeSession(overrides: Partial<TerminalSessionDescriptor> = {}): TerminalSessionDescriptor {
    return {
      sessionId: 'session-1',
      taskId: 'task-x',
      status: 'running',
      mode: 'spawn',
      attached: false,
      createdAt: new Date('2025-01-01T00:00:00Z').toISOString(),
      outputSnapshot: 'replay-prefix',
      ...overrides,
    };
  }

  it('writes the snapshot once before live output and not again on re-render of the same session', () => {
    const session = makeSession();
    const { rerender } = render(
      <TerminalDrawer
        collapsed={false}
        onToggle={() => {}}
        sessions={[session]}
        activeSessionId={session.sessionId}
        onSelectSession={() => {}}
        onCloseSession={() => {}}
      />,
    );

    const terms = getMockTerminals();
    expect(terms).toHaveLength(1);
    const term = terms[0];
    expect(term.write).toHaveBeenCalledTimes(1);
    expect(term.write).toHaveBeenCalledWith('replay-prefix');

    // Re-render with a new session object reference but the same sessionId
    // (e.g. status flipped to 'exited'). The pane must not re-seed.
    rerender(
      <TerminalDrawer
        collapsed={false}
        onToggle={() => {}}
        sessions={[{ ...session, status: 'exited', exitCode: 0 }]}
        activeSessionId={session.sessionId}
        onSelectSession={() => {}}
        onCloseSession={() => {}}
      />,
    );

    expect(getMockTerminals()).toHaveLength(1);
    expect(term.write).toHaveBeenCalledTimes(1);
  });

  it('does not seed when the descriptor has no outputSnapshot', () => {
    const session = makeSession({ outputSnapshot: undefined });
    render(
      <TerminalDrawer
        collapsed={false}
        onToggle={() => {}}
        sessions={[session]}
        activeSessionId={session.sessionId}
        onSelectSession={() => {}}
        onCloseSession={() => {}}
      />,
    );

    const term = getMockTerminals().at(-1)!;
    expect(term.write).not.toHaveBeenCalled();
  });
});
