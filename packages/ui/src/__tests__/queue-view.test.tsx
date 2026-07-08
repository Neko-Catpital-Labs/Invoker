import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { QueueView } from '../components/QueueView.js';
import { createMockInvoker, makeUITask, type MockInvoker } from './helpers/mock-invoker.js';
import type { TaskState, WorkerActionSummary, WorkerStatusEntry, WorkerStatusSnapshot } from '../types.js';

describe('QueueView', () => {
  const onTaskClick = vi.fn();
  const onStartWorker = vi.fn();
  const onStopWorker = vi.fn();
  const onSelectWorker = vi.fn();

  let mock: MockInvoker;

  const EMPTY_WORKER_STATUS: WorkerStatusSnapshot = {
    generatedAt: '2026-01-01T00:00:00.000Z',
    workers: [],
  };

  function makeWorkerAction(overrides: Partial<WorkerActionSummary> = {}): WorkerActionSummary {
    return {
      id: 'action-1',
      workerKind: 'autofix',
      actionType: 'fix-with-agent',
      workflowId: 'wf-1',
      taskId: 'wf-1/fix-target',
      subjectType: 'task',
      subjectId: 'wf-1/fix-target',
      externalKey: 'wf-1/fix-target',
      status: 'running',
      attemptCount: 1,
      summary: 'Fix running',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      ...overrides,
    };
  }

  function makeWorker(overrides: Partial<WorkerStatusEntry> = {}): WorkerStatusEntry {
    return {
      kind: 'autofix',
      note: 'Auto-fixes failed tasks.',
      lifecycle: 'running',
      policy: 'enabled',
      autoStarts: true,
      startable: false,
      stoppable: true,
      recentActions: [],
      ...overrides,
    };
  }

  function makeWorkerStatus(workers: WorkerStatusSnapshot['workers']): WorkerStatusSnapshot {
    return {
      generatedAt: '2026-01-01T00:00:00.000Z',
      workers,
    };
  }

  interface RenderOptions {
    workerStatus?: WorkerStatusSnapshot;
    selectedTaskId?: string | null;
    readOnly?: boolean;
    selectedWorkerKind?: string | null;
    historyPageSize?: number;
  }

  function renderQueueView(tasks: Map<string, TaskState>, options: RenderOptions = {}) {
    const {
      workerStatus = EMPTY_WORKER_STATUS,
      selectedTaskId = null,
      readOnly = false,
      selectedWorkerKind = null,
      historyPageSize,
    } = options;
    render(
      <QueueView
        tasks={tasks}
        workerStatus={workerStatus}
        readOnly={readOnly}
        onStartWorker={onStartWorker}
        onStopWorker={onStopWorker}
        onTaskClick={onTaskClick}
        selectedTaskId={selectedTaskId}
        selectedWorkerKind={selectedWorkerKind}
        onSelectWorker={onSelectWorker}
        historyPageSize={historyPageSize}
      />,
    );
  }

  beforeEach(() => {
    onTaskClick.mockReset();
    onStartWorker.mockReset();
    onStopWorker.mockReset();
    onSelectWorker.mockReset();
    vi.stubGlobal('confirm', vi.fn(() => true));
    mock = createMockInvoker();
    mock.install();
  });

  afterEach(() => {
    mock.cleanup();
    vi.unstubAllGlobals();
  });

  it('shows the selected worker durable history with agent-triggered rows', async () => {
    const target = makeUITask({ id: 'wf-1/fix-target', status: 'completed', description: 'needs fix' });
    mock.setWorkerActionHistory('autofix', [
      makeWorkerAction({ id: 'a-claude', agentName: 'claude', status: 'completed', taskId: target.id, subjectId: target.id }),
      makeWorkerAction({ id: 'a-codex', agentName: 'codex', status: 'completed', taskId: 'wf-1/other', subjectId: 'wf-1/other' }),
    ]);
    renderQueueView(new Map([[target.id, target]]), {
      workerStatus: makeWorkerStatus([makeWorker({ kind: 'autofix' })]),
      selectedWorkerKind: 'autofix',
    });

    expect(await screen.findByText('Fix with Claude')).toBeInTheDocument();
    expect(screen.getByText('Fix with Codex')).toBeInTheDocument();
    expect(screen.getByText('Recorded actions for Autofix, newest first.')).toBeInTheDocument();
    expect(screen.getByTestId('worker-history-title')).toHaveTextContent('History (2)');
    // No cross-worker "active work only" framing anymore.
    expect(screen.queryByText('Only work started by a worker process appears here.')).not.toBeInTheDocument();
  });

  it('swaps the left pane to the newly selected worker history', async () => {
    mock.setWorkerActionHistory('pr-status', []);
    mock.setWorkerActionHistory('autofix', [
      makeWorkerAction({ id: 'a-claude', agentName: 'claude', status: 'completed' }),
    ]);
    const workerStatus = makeWorkerStatus([
      makeWorker({ kind: 'pr-status', note: 'Checks pull request status.' }),
      makeWorker({ kind: 'autofix' }),
    ]);
    const { rerender } = render(
      <QueueView
        tasks={new Map()}
        workerStatus={workerStatus}
        readOnly={false}
        onStartWorker={onStartWorker}
        onStopWorker={onStopWorker}
        onTaskClick={onTaskClick}
        selectedTaskId={null}
        selectedWorkerKind="pr-status"
        onSelectWorker={onSelectWorker}
      />,
    );

    expect(
      await screen.findByText('No persisted PR status actions. This worker updates review gates directly.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Fix with Claude')).not.toBeInTheDocument();

    // Selecting Autofix (App flips selectedWorkerKind) swaps the pane to Autofix history.
    rerender(
      <QueueView
        tasks={new Map()}
        workerStatus={workerStatus}
        readOnly={false}
        onStartWorker={onStartWorker}
        onStopWorker={onStopWorker}
        onTaskClick={onTaskClick}
        selectedTaskId={null}
        selectedWorkerKind="autofix"
        onSelectWorker={onSelectWorker}
      />,
    );

    expect(await screen.findByText('Fix with Claude')).toBeInTheDocument();
    expect(screen.getByText('Recorded actions for Autofix, newest first.')).toBeInTheDocument();
    expect(
      screen.queryByText('No persisted PR status actions. This worker updates review gates directly.'),
    ).not.toBeInTheDocument();
  });

  it('opens the affected task from a history row', async () => {
    const task = makeUITask({ id: 'wf-1/fix-target', status: 'failed', description: 'needs fix' });
    mock.setWorkerActionHistory('autofix', [makeWorkerAction({ agentName: 'claude', taskId: task.id, subjectId: task.id })]);
    renderQueueView(new Map([[task.id, task]]), {
      workerStatus: makeWorkerStatus([makeWorker()]),
      selectedWorkerKind: 'autofix',
    });

    fireEvent.click(await screen.findByText('Fix with Claude'));
    expect(onTaskClick).toHaveBeenCalledWith(expect.objectContaining({ id: task.id }));
  });

  it('loads older actions without replacing the first page', async () => {
    mock.setWorkerActionHistory('autofix', [
      makeWorkerAction({ id: 'a1', agentName: 'claude', summary: 'first page a1' }),
      makeWorkerAction({ id: 'a2', agentName: 'claude', summary: 'first page a2' }),
      makeWorkerAction({ id: 'a3', agentName: 'codex', summary: 'second page a3' }),
    ]);
    renderQueueView(new Map(), {
      workerStatus: makeWorkerStatus([makeWorker()]),
      selectedWorkerKind: 'autofix',
      historyPageSize: 2,
    });

    expect(await screen.findByText('first page a1')).toBeInTheDocument();
    expect(screen.getByText('first page a2')).toBeInTheDocument();
    expect(screen.queryByText('second page a3')).not.toBeInTheDocument();
    expect(screen.getByTestId('worker-history-title')).toHaveTextContent('History (2)');

    fireEvent.click(screen.getByTestId('worker-history-load-more'));

    // Older page appends; the first page is still there.
    expect(await screen.findByText('second page a3')).toBeInTheDocument();
    expect(screen.getByText('first page a1')).toBeInTheDocument();
    expect(screen.getByText('first page a2')).toBeInTheDocument();
    expect(screen.getByTestId('worker-history-title')).toHaveTextContent('History (3)');
    // No further pages -> load-more control gone.
    expect(screen.queryByTestId('worker-history-load-more')).not.toBeInTheDocument();
  });

  it('keeps history and worker processes in independent scroll panes', async () => {
    mock.setWorkerActionHistory('autofix', [makeWorkerAction({ agentName: 'claude' })]);
    renderQueueView(new Map(), {
      workerStatus: makeWorkerStatus([makeWorker({ kind: 'autofix' })]),
      selectedWorkerKind: 'autofix',
    });

    const actionSection = screen.getByTestId('action-queue-section');
    const actionList = screen.getByTestId('worker-action-list');
    const workersSection = screen.getByTestId('worker-processes-section');

    expect(actionSection.compareDocumentPosition(workersSection) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(actionSection.className).toContain('overflow-hidden');
    expect(actionList.className).toContain('overflow-y-auto');
    expect(workersSection.className).toContain('overflow-hidden');
    expect(within(workersSection).getByText('Worker processes (1)')).toBeInTheDocument();
    expect(within(workersSection).getByTestId('worker-row-autofix')).toBeInTheDocument();
    expect(within(actionSection).queryByTestId('worker-row-autofix')).not.toBeInTheDocument();
    expect(await within(actionSection).findByText('Fix with Claude')).toBeInTheDocument();
  });

  it('shows no unrelated scheduler tasks in the history pane', async () => {
    const unrelated = makeUITask({ id: 'wf-1/random', status: 'running', description: 'normal scheduler work' });
    mock.setWorkerActionHistory('autofix', [makeWorkerAction({ agentName: 'claude', taskId: 'wf-1/fix', subjectId: 'wf-1/fix' })]);
    renderQueueView(new Map([[unrelated.id, unrelated]]), {
      workerStatus: makeWorkerStatus([makeWorker()]),
      selectedWorkerKind: 'autofix',
    });

    expect(await screen.findByText('Fix with Claude')).toBeInTheDocument();
    expect(screen.queryByText('normal scheduler work')).not.toBeInTheDocument();
  });

  it('renders missing history targets without linking a random task', async () => {
    mock.setWorkerActionHistory('autofix', [
      makeWorkerAction({ agentName: 'claude', taskId: 'wf-1/missing-target', subjectId: 'wf-1/missing-target' }),
    ]);
    renderQueueView(new Map(), {
      workerStatus: makeWorkerStatus([makeWorker()]),
      selectedWorkerKind: 'autofix',
    });

    expect(await screen.findByText('Fix with Claude')).toBeInTheDocument();
    expect(screen.getByText('Target task is not loaded.')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Fix with Claude'));
    expect(onTaskClick).not.toHaveBeenCalled();
  });

  it('falls back to a generic label when a fix-with-agent action has no agent name', async () => {
    mock.setWorkerActionHistory('ci-failure', [makeWorkerAction({ workerKind: 'ci-failure', agentName: undefined })]);
    renderQueueView(new Map(), {
      workerStatus: makeWorkerStatus([makeWorker({ kind: 'ci-failure' })]),
      selectedWorkerKind: 'ci-failure',
    });

    expect(await screen.findByText('Fix with agent')).toBeInTheDocument();
  });

  it('keeps pr-status empty-state guidance instead of pretending it owns queue tasks', async () => {
    const unrelated = makeUITask({ id: 'wf-1/random', status: 'running', description: 'not worker owned' });
    mock.setWorkerActionHistory('pr-status', []);
    renderQueueView(new Map([[unrelated.id, unrelated]]), {
      workerStatus: makeWorkerStatus([makeWorker({ kind: 'pr-status', note: 'Checks pull request status.' })]),
      selectedWorkerKind: 'pr-status',
    });

    expect(
      await screen.findByText('No persisted PR status actions. This worker updates review gates directly.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('not worker owned')).not.toBeInTheDocument();
    // Process-list row still names the worker.
    expect(screen.getByText('PR status')).toBeInTheDocument();
  });

  it('prompts to select a worker when none is selected', () => {
    renderQueueView(new Map(), { workerStatus: EMPTY_WORKER_STATUS, selectedWorkerKind: null });

    expect(screen.getByText('Select a worker process to see its recorded history.')).toBeInTheDocument();
    expect(screen.getByTestId('worker-history-title')).toHaveTextContent('History (0)');
  });

  it('shows all registered workers in snapshot order', () => {
    renderQueueView(new Map(), {
      workerStatus: makeWorkerStatus([
        makeWorker({ kind: 'autofix', lifecycle: 'stopped', autoStarts: false, startable: true, stoppable: false }),
        makeWorker({ kind: 'pr-status', lifecycle: 'running', autoStarts: true, startable: false, stoppable: true }),
        makeWorker({ kind: 'ci-failure', lifecycle: 'running', autoStarts: true, startable: false, stoppable: true }),
      ]),
    });

    const rows = screen.getAllByTestId(/^worker-row-/);
    expect(rows.map((row) => row.getAttribute('data-testid'))).toEqual([
      'worker-row-autofix',
      'worker-row-pr-status',
      'worker-row-ci-failure',
    ]);
    expect(screen.getByText('Worker processes (3)')).toBeInTheDocument();
    expect(screen.getByText('Autofix')).toBeInTheDocument();
    expect(screen.getByText('PR status')).toBeInTheDocument();
    expect(screen.getByText('CI failure repair')).toBeInTheDocument();
  });

  it('shows disabled Autofix and CI rows when policy is disabled', () => {
    renderQueueView(new Map(), {
      workerStatus: makeWorkerStatus([
        makeWorker({
          kind: 'autofix',
          lifecycle: 'stopped',
          policy: 'disabled',
          policyReason: 'autoFixRetries=0',
          controlDisabledReason: 'autoFixRetries=0',
          autoStarts: false,
          startable: false,
          stoppable: false,
        }),
        makeWorker({
          kind: 'ci-failure',
          lifecycle: 'stopped',
          policy: 'disabled',
          policyReason: 'autoFixRetries=0',
          controlDisabledReason: 'autoFixRetries=0',
          autoStarts: true,
          startable: false,
          stoppable: false,
        }),
      ]),
    });

    expect(within(screen.getByTestId('worker-row-autofix')).getByText('Disabled · autoFixRetries=0')).toBeInTheDocument();
    expect(within(screen.getByTestId('worker-row-ci-failure')).getByText('Disabled · autoFixRetries=0')).toBeInTheDocument();
    expect(within(screen.getByTestId('worker-row-ci-failure')).getByText('Auto-starts')).toBeInTheDocument();
  });

  it('calls start worker for a stopped row', () => {
    renderQueueView(new Map(), {
      workerStatus: makeWorkerStatus([makeWorker({ lifecycle: 'stopped', autoStarts: false, startable: true, stoppable: false })]),
    });

    fireEvent.click(within(screen.getByTestId('worker-row-autofix')).getByRole('button', { name: 'Start process' }));
    expect(onStartWorker).toHaveBeenCalledWith('autofix');
  });

  it('calls stop worker for a running row', () => {
    renderQueueView(new Map(), {
      workerStatus: makeWorkerStatus([makeWorker({ kind: 'ci-failure', autoStarts: true, startable: false, stoppable: true })]),
    });

    fireEvent.click(within(screen.getByTestId('worker-row-ci-failure')).getByRole('button', { name: 'Stop process' }));
    expect(onStopWorker).toHaveBeenCalledWith('ci-failure');
  });

  it('disables worker controls in read-only mode', () => {
    renderQueueView(new Map(), {
      workerStatus: makeWorkerStatus([makeWorker({ lifecycle: 'stopped', autoStarts: false, startable: true, stoppable: false })]),
      readOnly: true,
    });

    const start = within(screen.getByTestId('worker-row-autofix')).getByRole('button', { name: 'Start process' });
    expect(start).toBeDisabled();
    expect(start).toHaveAttribute('title', 'Read-only window');
  });

  it('selects worker rows from the process list, separate from history rows', async () => {
    mock.setWorkerActionHistory('ci-failure', [makeWorkerAction({ workerKind: 'ci-failure', agentName: 'codex' })]);
    renderQueueView(new Map(), {
      workerStatus: makeWorkerStatus([makeWorker({ kind: 'ci-failure' })]),
      selectedWorkerKind: 'ci-failure',
    });

    const row = screen.getByTestId('worker-row-ci-failure');
    expect(row.className).toContain('ring-cyan');
    // History rows live in the other section, never inside a process-list row.
    expect(within(row).queryByText('Fix with Codex')).not.toBeInTheDocument();
    expect(await within(screen.getByTestId('action-queue-section')).findByText('Fix with Codex')).toBeInTheDocument();

    fireEvent.click(row);
    expect(onSelectWorker).toHaveBeenCalledWith('ci-failure');
  });

  it('expands relationships only for the affected history task', async () => {
    const buildTask = makeUITask({ id: 'wf-1/build', status: 'running', description: 'Build the project', dependencies: [] });
    const deployTask = makeUITask({ id: 'wf-1/deploy', status: 'blocked', description: 'Deploy after build', dependencies: ['wf-1/build'] });
    const tasks = new Map<string, TaskState>([
      [buildTask.id, buildTask],
      [deployTask.id, deployTask],
    ]);
    mock.setWorkerActionHistory('autofix', [makeWorkerAction({ agentName: 'claude', taskId: buildTask.id, subjectId: buildTask.id })]);
    renderQueueView(tasks, {
      workerStatus: makeWorkerStatus([makeWorker()]),
      selectedWorkerKind: 'autofix',
    });

    await screen.findByText('Fix with Claude');
    expect(screen.getByTestId('queue-rels-toggle-action-wf-1/build')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Expand relationships'));

    const relsSection = screen.getByTestId('rels-wf-1/build');
    expect(relsSection.textContent).toContain('downstream:');
    expect(relsSection.textContent).toContain('deploy');

    const deployChip = relsSection.querySelector('button');
    expect(deployChip).not.toBeNull();
    fireEvent.click(deployChip!);
    expect(onTaskClick).toHaveBeenCalledWith(expect.objectContaining({ id: deployTask.id }));
  });

  it('keeps the selection highlight on an expanded history row', async () => {
    const buildTask = makeUITask({ id: 'wf-1/build', status: 'running', description: 'Build the project', dependencies: [] });
    const deployTask = makeUITask({ id: 'wf-1/deploy', status: 'blocked', description: 'Deploy after build', dependencies: ['wf-1/build'] });
    const tasks = new Map<string, TaskState>([
      [buildTask.id, buildTask],
      [deployTask.id, deployTask],
    ]);
    mock.setWorkerActionHistory('autofix', [makeWorkerAction({ agentName: 'claude', taskId: buildTask.id, subjectId: buildTask.id })]);
    renderQueueView(tasks, {
      workerStatus: makeWorkerStatus([makeWorker()]),
      selectedTaskId: buildTask.id,
      selectedWorkerKind: 'autofix',
    });

    const selectedRow = (await screen.findByText('Fix with Claude')).closest('[data-row-id]');
    expect(selectedRow?.className).toContain('bg-cyan-950/30');

    fireEvent.click(screen.getByLabelText('Expand relationships'));

    expect(selectedRow?.className).toContain('bg-cyan-950/30');
    expect(screen.getByTestId('rels-wf-1/build')).toBeInTheDocument();
  });
});
