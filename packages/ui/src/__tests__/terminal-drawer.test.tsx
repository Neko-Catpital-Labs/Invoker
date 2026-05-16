/**
 * Component tests for the embedded terminal drawer.
 *
 * Asserts that opening a task terminal expands the drawer, that the same
 * task id maps to a single tab, and that the tab strip and minimize button
 * stay laid out side-by-side (no overlap).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMockInvoker, makeUITask, type MockInvoker } from './helpers/mock-invoker.js';
import type { WorkflowMeta } from '../types.js';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

// xterm-addon-fit reads layout off the DOM; jsdom doesn't compute layout, so
// stub the addon to keep the renderer happy while preserving the same shape.
vi.mock('xterm-addon-fit', () => {
  class FitAddon {
    activate(): void {}
    dispose(): void {}
    fit(): void {}
    proposeDimensions(): { cols: number; rows: number } | undefined {
      return undefined;
    }
  }
  return { FitAddon };
});

const { App } = await import('../App.js');

const workflows: WorkflowMeta[] = [{ id: 'wf-a', name: 'Workflow A', status: 'running' }];
const alpha = makeUITask({
  id: 'task-alpha',
  description: 'Alpha task',
  status: 'completed',
  workflowId: 'wf-a',
  command: 'echo hello',
});
const beta = makeUITask({
  id: 'task-beta',
  description: 'Beta task',
  status: 'completed',
  workflowId: 'wf-a',
  command: 'echo world',
  dependencies: ['task-alpha'],
});

async function loadAppWithTasks(mock: MockInvoker) {
  render(<App />);
  act(() => mock.setTasks([alpha, beta], workflows));
  await waitFor(() => {
    expect(screen.getByTestId('workflow-node-wf-a')).toBeInTheDocument();
  });
  fireEvent.click(screen.getByTestId('rf__node-wf-a'));
  await waitFor(() => {
    expect(screen.getByTestId('rf__node-task-alpha')).toBeInTheDocument();
    expect(screen.getByTestId('rf__node-task-beta')).toBeInTheDocument();
  });
}

describe('TerminalDrawer — embedded sessions', () => {
  let mock: MockInvoker;

  beforeEach(() => {
    mock = createMockInvoker();
    mock.install();
  });

  afterEach(() => {
    mock.cleanup();
  });

  it('starts collapsed when there are no sessions', async () => {
    render(<App />);
    await waitFor(() => {
      expect(screen.getByTestId('terminal-drawer')).toBeInTheDocument();
    });
    const drawer = screen.getByTestId('terminal-drawer');
    expect(drawer).toHaveAttribute('data-collapsed', 'true');
    expect(screen.queryByTestId('terminal-drawer-body')).not.toBeInTheDocument();
  });

  it('expands the drawer and adds a tab when a task is double-clicked', async () => {
    await loadAppWithTasks(mock);

    fireEvent.doubleClick(screen.getByTestId('rf__node-task-alpha'));

    await waitFor(() => {
      expect(mock.api.terminalOpen).toHaveBeenCalledWith('task-alpha');
    });
    await waitFor(() => {
      expect(screen.getByTestId('terminal-drawer')).toHaveAttribute('data-collapsed', 'false');
      expect(screen.getByTestId('terminal-tab-task-alpha')).toBeInTheDocument();
    });
    expect(screen.getByTestId('terminal-tab-task-alpha')).toHaveAttribute('data-active', 'true');
    expect(screen.getByTestId('terminal-drawer-body')).toBeInTheDocument();
  });

  it('reuses a single tab when the same task is opened twice', async () => {
    await loadAppWithTasks(mock);

    fireEvent.doubleClick(screen.getByTestId('rf__node-task-alpha'));
    await waitFor(() => {
      expect(screen.getByTestId('terminal-tab-task-alpha')).toBeInTheDocument();
    });

    // Minimize the drawer to verify the next open re-expands it.
    fireEvent.click(screen.getByTestId('terminal-drawer-toggle'));
    expect(screen.getByTestId('terminal-drawer')).toHaveAttribute('data-collapsed', 'true');

    fireEvent.doubleClick(screen.getByTestId('rf__node-task-alpha'));

    await waitFor(() => {
      expect(mock.api.terminalOpen).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(screen.getByTestId('terminal-drawer')).toHaveAttribute('data-collapsed', 'false');
    });

    expect(screen.getAllByTestId('terminal-tab-task-alpha')).toHaveLength(1);
    expect(screen.queryAllByTestId(/^terminal-tab-task-/)).toHaveLength(1);
  });

  it('keeps separate tabs for distinct tasks and switches the active pane on click', async () => {
    await loadAppWithTasks(mock);

    fireEvent.doubleClick(screen.getByTestId('rf__node-task-alpha'));
    await waitFor(() => {
      expect(screen.getByTestId('terminal-tab-task-alpha')).toBeInTheDocument();
    });

    fireEvent.doubleClick(screen.getByTestId('rf__node-task-beta'));
    await waitFor(() => {
      expect(screen.getByTestId('terminal-tab-task-beta')).toBeInTheDocument();
    });

    expect(screen.getByTestId('terminal-tab-task-alpha')).toHaveAttribute('data-active', 'false');
    expect(screen.getByTestId('terminal-tab-task-beta')).toHaveAttribute('data-active', 'true');

    fireEvent.click(screen.getByTestId('terminal-tab-task-alpha'));
    await waitFor(() => {
      expect(mock.api.terminalSelect).toHaveBeenCalledWith('session-task-alpha');
    });
    expect(screen.getByTestId('terminal-tab-task-alpha')).toHaveAttribute('data-active', 'true');
    expect(screen.getByTestId('terminal-tab-task-beta')).toHaveAttribute('data-active', 'false');
  });

  it('closes a tab and drops the session via the close button', async () => {
    await loadAppWithTasks(mock);

    fireEvent.doubleClick(screen.getByTestId('rf__node-task-alpha'));
    await waitFor(() => {
      expect(screen.getByTestId('terminal-tab-task-alpha')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('terminal-tab-close-task-alpha'));

    await waitFor(() => {
      expect(screen.queryByTestId('terminal-tab-task-alpha')).not.toBeInTheDocument();
    });
    expect(mock.api.terminalClose).toHaveBeenCalledWith('session-task-alpha');
    expect(screen.getByTestId('terminal-drawer-empty')).toBeInTheDocument();
  });

  it('surfaces a failure reason from the backend without expanding into a phantom tab', async () => {
    (mock.api.terminalOpen as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      opened: false,
      reason: 'Task is still running — view output here instead.',
    });
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    await loadAppWithTasks(mock);

    fireEvent.doubleClick(screen.getByTestId('rf__node-task-alpha'));

    await waitFor(() => {
      expect(alertSpy).toHaveBeenCalledWith('Task is still running — view output here instead.');
    });
    // Drawer still expanded — empty-state message visible, no tab created.
    expect(screen.getByTestId('terminal-drawer')).toHaveAttribute('data-collapsed', 'false');
    expect(screen.queryByTestId('terminal-tab-task-alpha')).not.toBeInTheDocument();
    expect(screen.getByTestId('terminal-drawer-empty')).toBeInTheDocument();
    alertSpy.mockRestore();
  });

  it('marks a session as exited when the main process emits a terminal-exit event', async () => {
    await loadAppWithTasks(mock);

    fireEvent.doubleClick(screen.getByTestId('rf__node-task-alpha'));
    await waitFor(() => {
      expect(screen.getByTestId('terminal-tab-task-alpha')).toBeInTheDocument();
    });

    act(() => {
      mock.fireTerminalExit({
        sessionId: 'session-task-alpha',
        taskId: 'task-alpha',
        exitCode: 0,
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('terminal-tab-task-alpha')).toHaveAttribute('data-status', 'exited');
    });
    expect(screen.getByTestId('terminal-pane-banner-task-alpha')).toHaveTextContent(
      'Session exited (exit 0).',
    );
  });

  it('lays the tab strip out beside the minimize control without overlap', async () => {
    await loadAppWithTasks(mock);
    fireEvent.doubleClick(screen.getByTestId('rf__node-task-alpha'));
    await waitFor(() => {
      expect(screen.getByTestId('terminal-tab-task-alpha')).toBeInTheDocument();
    });

    const drawer = screen.getByTestId('terminal-drawer');
    const tabs = screen.getByTestId('terminal-drawer-tabs');
    const toggle = screen.getByTestId('terminal-drawer-toggle');

    // Tabs are a direct child of the drawer header (alongside, not nested in,
    // the toggle button). Without separate flex containers the close × hit
    // area would overlap the minimize button.
    expect(tabs).not.toContainElement(toggle);
    expect(toggle).not.toContainElement(tabs);
    expect(drawer).toContainElement(tabs);
    expect(drawer).toContainElement(toggle);

    // The tab strip flexes; the toggle button stays fixed-size on the right.
    expect(tabs.className).toMatch(/flex-1/);
    expect(toggle.className).toMatch(/shrink-0/);
  });
});
