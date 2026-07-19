import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { useMemo, useState, type JSX } from 'react';
import { CommandPalette, COMMAND_PALETTE_MAX_ROWS } from '../components/CommandPalette.js';
import { LeftStatusColumn } from '../components/LeftStatusColumn.js';
import type { TaskState, WorkflowMeta } from '../types.js';
import * as workflowProgressSurfaces from '../lib/workflow-progress-surfaces.js';

function buildFixtures() {
  const workflows = new Map<string, WorkflowMeta>([
    ['wf-alpha', { id: 'wf-alpha', name: 'Alpha workflow', status: 'running' }],
    ['wf-beta', { id: 'wf-beta', name: 'Beta workflow', status: 'failed' }],
  ]);
  const tasks = new Map<string, TaskState>([
    ['t-1', {
      id: 't-1',
      description: 'Fix broken flag propagation',
      status: 'failed',
      config: { workflowId: 'wf-beta' } as unknown as TaskState['config'],
    } as TaskState],
    ['t-2', {
      id: 't-2',
      description: 'Run integration suite',
      status: 'running',
      config: { workflowId: 'wf-alpha' } as unknown as TaskState['config'],
    } as TaskState],
  ]);
  return { workflows, tasks };
}

function entriesFrom(workflows: Map<string, WorkflowMeta>, tasks: Map<string, TaskState>) {
  const workflowEntries = workflowProgressSurfaces.getSortedWorkflows(workflows, tasks);
  const attentionEntries = workflowProgressSurfaces.getAttentionTaskEntries(tasks, workflows);
  const runningEntries = workflowProgressSurfaces.getRunningTaskEntries(tasks, workflows, null);
  return {
    workflowEntries: workflowEntries.slice(0, COMMAND_PALETTE_MAX_ROWS),
    attentionEntries: attentionEntries.slice(0, COMMAND_PALETTE_MAX_ROWS),
    runningEntries: runningEntries.slice(0, COMMAND_PALETTE_MAX_ROWS),
    workflowCount: workflowEntries.length,
    attentionCount: attentionEntries.length,
  };
}

function buildLargeFixtures(workflowCount: number, taskCount: number) {
  const workflows = new Map<string, WorkflowMeta>();
  for (let i = 0; i < workflowCount; i += 1) {
    workflows.set(`w${i}`, {
      id: `w${i}`,
      name: `Workflow ${i}`,
      status: i % 5 === 0 ? 'failed' : i % 3 === 0 ? 'running' : 'completed',
      updatedAt: new Date(Date.now() - i * 1000).toISOString(),
      createdAt: new Date(Date.now() - i * 2000).toISOString(),
    });
  }
  const statuses: TaskState['status'][] = [
    'completed',
    'running',
    'failed',
    'blocked',
    'pending',
    'awaiting_approval',
    'review_ready',
    'fixing_with_ai',
  ];
  const tasks = new Map<string, TaskState>();
  for (let i = 0; i < taskCount; i += 1) {
    tasks.set(`t${i}`, {
      id: `t${i}`,
      description: `Task description number ${i}`,
      status: statuses[i % statuses.length],
      config: { workflowId: `w${i % workflowCount}` } as unknown as TaskState['config'],
    } as TaskState);
  }
  return { workflows, tasks };
}

function Harness({
  workflows,
  tasks,
  enabled = true,
  defaultOpen = false,
}: {
  workflows: Map<string, WorkflowMeta>;
  tasks: Map<string, TaskState>;
  enabled?: boolean;
  defaultOpen?: boolean;
}): JSX.Element {
  const [renderCount, setRenderCount] = useState(0);
  const workflowEntries = useMemo(
    () => workflowProgressSurfaces.getSortedWorkflows(workflows, tasks),
    [workflows, tasks],
  );
  const attentionEntries = useMemo(
    () => workflowProgressSurfaces.getAttentionTaskEntries(tasks, workflows),
    [tasks, workflows],
  );
  const runningEntries = useMemo(
    () => workflowProgressSurfaces.getRunningTaskEntries(tasks, workflows, null),
    [tasks, workflows],
  );

  return (
    <div>
      <button type="button" onClick={() => setRenderCount((n) => n + 1)}>
        bump-parent
      </button>
      <span data-testid="parent-render-count">{renderCount}</span>
      <LeftStatusColumn
        workflowCount={workflowEntries.length}
        attentionCount={attentionEntries.length}
        workerStatus={null}
        selectedSurface="home"
        collapsed={false}
        runningEntries={runningEntries}
        selectedTaskId={null}
        onSelectSurface={() => {}}
        onSelectTask={() => {}}
        onToggleCollapsed={() => {}}
        planningSessionCount={0}
        planningAttentionCount={0}
        onOpenSettings={() => {}}
        theme="dark"
        onToggleTheme={() => {}}
      />
      <CommandPalette
        enabled={enabled}
        defaultOpen={defaultOpen}
        workflowEntries={workflowEntries.slice(0, COMMAND_PALETTE_MAX_ROWS)}
        attentionEntries={attentionEntries.slice(0, COMMAND_PALETTE_MAX_ROWS)}
        runningEntries={runningEntries.slice(0, COMMAND_PALETTE_MAX_ROWS)}
        workflowCount={workflowEntries.length}
        attentionCount={attentionEntries.length}
        onSelectSurface={() => {}}
        onSelectWorkflow={() => {}}
        onSelectTask={() => {}}
        onOpenSettings={() => {}}
        planningSessionCount={0}
      />
    </div>
  );
}

describe('CommandPalette', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders navigate section headings when open', () => {
    const { workflows, tasks } = buildFixtures();
    const entries = entriesFrom(workflows, tasks);
    render(
      <CommandPalette
        defaultOpen
        {...entries}
        onSelectSurface={() => {}}
        onSelectWorkflow={() => {}}
        onSelectTask={() => {}}
        onOpenSettings={() => {}}
        planningSessionCount={0}
      />,
    );
    expect(screen.getByText(/Navigate/i)).toBeInTheDocument();
    expect(screen.getByText(/Go home/i)).toBeInTheDocument();
    expect(screen.getAllByText(/Needs Attention/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Workflows/i).length).toBeGreaterThan(0);
  });

  it('lists workflows and calls onSelectWorkflow on click', async () => {
    const { workflows, tasks } = buildFixtures();
    const entries = entriesFrom(workflows, tasks);
    const onSelectWorkflow = vi.fn();
    render(
      <CommandPalette
        defaultOpen
        {...entries}
        onSelectSurface={() => {}}
        onSelectWorkflow={onSelectWorkflow}
        onSelectTask={() => {}}
        onOpenSettings={() => {}}
        planningSessionCount={0}
      />,
    );

    const betaItem = await screen.findByText('Beta workflow');
    fireEvent.click(betaItem);
    await waitFor(() => expect(onSelectWorkflow).toHaveBeenCalledWith('wf-beta'));
  });

  it('shows failed task under the needs-attention group', async () => {
    const { workflows, tasks } = buildFixtures();
    const entries = entriesFrom(workflows, tasks);
    render(
      <CommandPalette
        defaultOpen
        {...entries}
        onSelectSurface={() => {}}
        onSelectWorkflow={() => {}}
        onSelectTask={() => {}}
        onOpenSettings={() => {}}
        planningSessionCount={2}
      />,
    );
    expect(await screen.findByText('Fix broken flag propagation')).toBeInTheDocument();
    expect(screen.getAllByText('2').length).toBeGreaterThan(0);
  });

  it('toggles open on Cmd+K and ignores the shortcut when disabled', async () => {
    const { workflows, tasks } = buildFixtures();
    const { rerender } = render(<Harness workflows={workflows} tasks={tasks} enabled />);

    expect(screen.getByTestId('command-palette')).toHaveAttribute('data-state', 'closed');

    await act(async () => {
      fireEvent.keyDown(document, { key: 'k', metaKey: true });
    });
    expect(screen.getByTestId('command-palette')).toHaveAttribute('data-state', 'open');
    expect(screen.getByPlaceholderText(/Jump to workflow/i)).toBeVisible();

    await act(async () => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });
    await waitFor(() => {
      expect(screen.getByTestId('command-palette')).toHaveAttribute('data-state', 'closed');
    });

    rerender(<Harness workflows={workflows} tasks={tasks} enabled={false} />);
    await act(async () => {
      fireEvent.keyDown(document, { key: 'k', metaKey: true });
    });
    expect(screen.getByTestId('command-palette')).toHaveAttribute('data-state', 'closed');
  });

  it('does not rescan workflow/task maps when Cmd+K opens the palette', async () => {
    const { workflows, tasks } = buildFixtures();
    const sortedSpy = vi.spyOn(workflowProgressSurfaces, 'getSortedWorkflows');
    const attentionSpy = vi.spyOn(workflowProgressSurfaces, 'getAttentionTaskEntries');
    const runningSpy = vi.spyOn(workflowProgressSurfaces, 'getRunningTaskEntries');

    render(<Harness workflows={workflows} tasks={tasks} />);
    const sortedAfterMount = sortedSpy.mock.calls.length;
    const attentionAfterMount = attentionSpy.mock.calls.length;
    const runningAfterMount = runningSpy.mock.calls.length;
    expect(sortedAfterMount).toBeGreaterThan(0);

    await act(async () => {
      fireEvent.keyDown(document, { key: 'k', metaKey: true });
    });
    expect(await screen.findByPlaceholderText(/Jump to workflow/i)).toBeInTheDocument();

    expect(sortedSpy.mock.calls.length).toBe(sortedAfterMount);
    expect(attentionSpy.mock.calls.length).toBe(attentionAfterMount);
    expect(runningSpy.mock.calls.length).toBe(runningAfterMount);
  });

  it('opens the menu within 50ms for a large task graph', async () => {
    const { workflows, tasks } = buildLargeFixtures(500, 5000);
    const entries = entriesFrom(workflows, tasks);
    render(
      <CommandPalette
        {...entries}
        onSelectSurface={() => {}}
        onSelectWorkflow={() => {}}
        onSelectTask={() => {}}
        onOpenSettings={() => {}}
        planningSessionCount={0}
      />,
    );

    // Mount cost is paid up front; Cmd+K only toggles visibility.
    expect(screen.getByTestId('command-palette')).toHaveAttribute('data-state', 'closed');

    const started = performance.now();
    await act(async () => {
      fireEvent.keyDown(document, { key: 'k', metaKey: true });
    });
    expect(screen.getByTestId('command-palette')).toHaveAttribute('data-state', 'open');
    expect(screen.getByPlaceholderText(/Jump to workflow/i)).toBeVisible();
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(50);
    expect(screen.getAllByText(/Workflow \d+/).length).toBeLessThanOrEqual(COMMAND_PALETTE_MAX_ROWS);
  });
});
