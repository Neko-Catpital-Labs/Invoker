import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { QueueView } from '../components/QueueView.js';
import { makeUITask } from './helpers/mock-invoker.js';
import type { TaskState, WorkerActionSummary, WorkerStatusEntry, WorkerStatusSnapshot, WorkflowMeta } from '../types.js';

describe('QueueView', () => {
  const onTaskClick = vi.fn();
  const onStartWorker = vi.fn();
  const onStopWorker = vi.fn();
  const onSelectWorker = vi.fn();

  const EMPTY_WORKER_STATUS: WorkerStatusSnapshot = {
    generatedAt: '2026-01-01T00:00:00.000Z',
    workers: [],
  };

  const DEFAULT_WORKFLOWS = new Map<string, WorkflowMeta>([
    ['wf-1', { id: 'wf-1', name: 'My Workflow', status: 'running' }],
  ]);

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
      source: 'built-in',
      availability: 'available',
      running: true,
      lifecycle: 'running',
      policy: 'enabled',
      autoStarts: true,
      startable: false,
      stoppable: true,
      recentActions: [],
      recentLogs: [],
      ...overrides,
    };
  }

  function makeWorkerStatus(workers: WorkerStatusSnapshot['workers']): WorkerStatusSnapshot {
    return {
      generatedAt: '2026-01-01T00:00:00.000Z',
      workers,
    };
  }

  function renderQueueView(
    tasks: Map<string, TaskState>,
    workerStatus: WorkerStatusSnapshot = EMPTY_WORKER_STATUS,
    selectedTaskId: string | null = null,
    readOnly = false,
    selectedWorkerKind: string | null = null,
    workflows: Map<string, WorkflowMeta> = DEFAULT_WORKFLOWS,
  ) {
    render(
      <QueueView
        tasks={tasks}
        workflows={workflows}
        workerStatus={workerStatus}
        readOnly={readOnly}
        onStartWorker={onStartWorker}
        onStopWorker={onStopWorker}
        onTaskClick={onTaskClick}
        selectedTaskId={selectedTaskId}
        selectedWorkerKind={selectedWorkerKind}
        onSelectWorker={onSelectWorker}
      />,
    );
  }

  beforeEach(() => {
    onTaskClick.mockReset();
    onStartWorker.mockReset();
    onStopWorker.mockReset();
    onSelectWorker.mockReset();
    vi.stubGlobal('confirm', vi.fn(() => true));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows only active work recorded by worker processes', () => {
    const targetTask = makeUITask({
      id: 'wf-1/fix-target',
      status: 'fixing_with_ai',
      description: 'needs fix',
    });
    const randomRunningTask = makeUITask({
      id: 'wf-1/random-runner',
      status: 'running',
      description: 'normal scheduler work',
    });
    const mergeGateTask = makeUITask({
      id: '__merge__wf-1',
      status: 'blocked',
      description: 'Workflow gate for queued merge',
    });
    const tasks = new Map<string, TaskState>([
      [targetTask.id, targetTask],
      [randomRunningTask.id, randomRunningTask],
      [mergeGateTask.id, mergeGateTask],
    ]);

    renderQueueView(
      tasks,
      makeWorkerStatus([
        makeWorker({
          recentActions: [
            makeWorkerAction({ taskId: targetTask.id, subjectId: targetTask.id, externalKey: targetTask.id }),
            makeWorkerAction({ id: 'completed-action', status: 'completed', taskId: randomRunningTask.id }),
          ],
        }),
      ]),
    );

    expect(screen.getByText('Worker Actions (1)')).toBeInTheDocument();
    expect(screen.getByText('Only work started by a worker process appears here.')).toBeInTheDocument();
    expect(screen.getByText('needs fix')).toBeInTheDocument();
    expect(screen.getByText('Autofix · Fix With Agent · My Workflow')).toBeInTheDocument();
    expect(screen.queryByText('normal scheduler work')).not.toBeInTheDocument();
    expect(screen.queryByText('Workflow gate for queued merge')).not.toBeInTheDocument();
    expect(screen.queryByText(/Backlog/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Action Queue/)).not.toBeInTheDocument();
  });

  it('opens the affected task from a worker action row', () => {
    const task = makeUITask({ id: 'wf-1/fix-target', status: 'failed', description: 'needs fix' });
    renderQueueView(
      new Map([[task.id, task]]),
      makeWorkerStatus([
        makeWorker({ recentActions: [makeWorkerAction({ taskId: task.id, subjectId: task.id })] }),
      ]),
    );

    fireEvent.click(screen.getByText('needs fix'));

    expect(onTaskClick).toHaveBeenCalledWith(expect.objectContaining({ id: task.id }));
  });

  it('distinguishes CI failure repair rows by target task title', () => {
    const taskA = makeUITask({ id: 'wf-1/gate-a', status: 'failed', description: 'Review gate A' });
    const taskB = makeUITask({ id: 'wf-1/gate-b', status: 'failed', description: 'Review gate B' });
    renderQueueView(
      new Map([[taskA.id, taskA], [taskB.id, taskB]]),
      makeWorkerStatus([
        makeWorker({
          kind: 'ci-failure',
          recentActions: [
            makeWorkerAction({
              id: 'ci-a',
              workerKind: 'ci-failure',
              actionType: 'fix-ci-failure',
              taskId: taskA.id,
              subjectId: taskA.id,
            }),
            makeWorkerAction({
              id: 'ci-b',
              workerKind: 'ci-failure',
              actionType: 'fix-ci-failure',
              taskId: taskB.id,
              subjectId: taskB.id,
            }),
          ],
        }),
      ]),
    );

    expect(screen.getByText('Review gate A')).toBeInTheDocument();
    expect(screen.getByText('Review gate B')).toBeInTheDocument();
    expect(screen.getAllByText('CI failure repair · Fix Ci Failure · My Workflow')).toHaveLength(2);
  });

  it('keeps worker actions and worker processes in independent scroll panes', () => {
    const task = makeUITask({ id: 'wf-1/action-task', status: 'running', description: 'running task' });
    renderQueueView(
      new Map([[task.id, task]]),
      makeWorkerStatus([
        makeWorker({
          kind: 'autofix',
          recentActions: [makeWorkerAction({ taskId: task.id, subjectId: task.id })],
        }),
      ]),
    );

    const actionSection = screen.getByTestId('action-queue-section');
    const actionList = screen.getByTestId('worker-action-list');
    const workersSection = screen.getByTestId('worker-processes-section');
    const workersScroll = screen.getByTestId('worker-process-scroll');

    expect(actionSection.parentElement).toHaveClass('grid-rows-[minmax(0,1fr)]');
    expect(actionSection.compareDocumentPosition(workersSection) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(actionSection.className).toContain('overflow-hidden');
    expect(actionList.className).toContain('overflow-y-auto');
    expect(workersSection.className).toContain('overflow-hidden');
    expect(workersScroll).toHaveClass('min-h-0', 'flex-1', 'overflow-y-auto');
    expect(within(actionSection).getByText('Worker Actions (1)')).toBeInTheDocument();
    expect(within(workersSection).queryByText('Worker processes (1)')).not.toBeInTheDocument();
    expect(within(workersSection).getByTestId('worker-row-autofix')).toBeInTheDocument();
    expect(within(actionSection).queryByTestId('worker-row-autofix')).not.toBeInTheDocument();
  });

  it('keeps tall worker-process rows inside the middle pane scroll owner', () => {
    const workers = Array.from({ length: 24 }, (_, index) =>
      makeWorker({
        kind: `worker-${index}`,
        note: `Worker ${index}`,
        lifecycle: index % 2 === 0 ? 'running' : 'stopped',
        autoStarts: false,
        startable: true,
        stoppable: false,
      }),
    );

    renderQueueView(new Map(), makeWorkerStatus(workers));

    const workersScroll = screen.getByTestId('worker-process-scroll');
    const workerCard = screen.getByTestId('worker-activity-card');
    const processList = screen.getByTestId('worker-process-list');
    const firstRow = screen.getByTestId('worker-row-worker-0');
    const lastRow = screen.getByTestId('worker-row-worker-23');

    expect(workersScroll).toHaveClass('min-h-0', 'flex-1', 'overflow-y-auto');
    expect(workerCard).toHaveClass('flex', 'min-h-0', 'flex-col');
    expect(processList).toHaveClass('min-h-0');
    expect(processList.closest('.overflow-y-auto')).toBe(workersScroll);
    expect(firstRow.closest('[data-testid="worker-process-scroll"]')).toBe(workersScroll);
    expect(lastRow.closest('[data-testid="worker-process-scroll"]')).toBe(workersScroll);
    expect(lastRow.closest('[data-testid="worker-action-list"]')).toBeNull();
    expect(screen.getAllByTestId(/^worker-row-/)).toHaveLength(24);
  });

  it('shows an empty worker-action state without showing unrelated tasks', () => {
    const unrelatedTask = makeUITask({ id: 'wf-1/random-task', status: 'running', description: 'not worker owned' });
    renderQueueView(
      new Map([[unrelatedTask.id, unrelatedTask]]),
      makeWorkerStatus([
        makeWorker({ kind: 'pr-status', note: 'Checks pull request status.', recentActions: [] }),
      ]),
    );

    expect(screen.getByText('Worker Actions (0)')).toBeInTheDocument();
    expect(screen.getByText('No worker action is running.')).toBeInTheDocument();
    expect(screen.queryByText('not worker owned')).not.toBeInTheDocument();
    expect(screen.getByText('PR status')).toBeInTheDocument();
  });

  it('renders missing worker action targets without linking a random task', () => {
    renderQueueView(
      new Map(),
      makeWorkerStatus([
        makeWorker({
          recentActions: [makeWorkerAction({ taskId: 'wf-1/missing-target', subjectId: 'wf-1/missing-target' })],
        }),
      ]),
    );

    expect(screen.getByText('missing-target')).toBeInTheDocument();
    expect(screen.getByText('Autofix · Fix With Agent · My Workflow')).toBeInTheDocument();
    expect(screen.getByText('Target task is not loaded.')).toBeInTheDocument();
    fireEvent.click(screen.getByText('missing-target'));
    expect(onTaskClick).not.toHaveBeenCalled();
  });

  it('shows all built-in workers in snapshot order', () => {
    renderQueueView(
      new Map(),
      makeWorkerStatus([
        makeWorker({
          kind: 'autofix',
          note: 'Auto-fixes failed tasks.',
          lifecycle: 'stopped',
          autoStarts: false,
          startable: true,
          stoppable: false,
        }),
        makeWorker({
          kind: 'pr-status',
          note: 'Checks pull request status.',
          lifecycle: 'running',
          autoStarts: true,
          startable: false,
          stoppable: true,
        }),
        makeWorker({
          kind: 'ci-failure',
          note: 'Repairs failed CI.',
          lifecycle: 'running',
          autoStarts: true,
          startable: false,
          stoppable: true,
        }),
        makeWorker({
          kind: 'review-gate-merge-conflict',
          note: 'Queues workflow rebase-recreate when a review-gate PR reports merge conflicts.',
          lifecycle: 'running',
          autoStarts: true,
          startable: false,
          stoppable: true,
        }),
        makeWorker({
          kind: 'coderabbit-address',
          note: 'Addresses CodeRabbit review comments.',
          lifecycle: 'running',
          autoStarts: true,
          startable: false,
          stoppable: true,
        }),
      ]),
    );

    const rows = screen.getAllByTestId(/^worker-row-/);
    expect(rows.map((row) => row.getAttribute('data-testid'))).toEqual([
      'worker-row-autofix',
      'worker-row-pr-status',
      'worker-row-ci-failure',
      'worker-row-review-gate-merge-conflict',
      'worker-row-coderabbit-address',
    ]);
    expect(screen.queryByText('Worker processes (5)')).not.toBeInTheDocument();
    expect(screen.getByText('Autofix')).toBeInTheDocument();
    expect(screen.getByText('PR status')).toBeInTheDocument();
    expect(screen.getByText('CI failure repair')).toBeInTheDocument();
    expect(screen.getByText('Merge conflict repair')).toBeInTheDocument();
    expect(screen.getByText('Coderabbit Address')).toBeInTheDocument();
  });

  it('shows disabled Autofix and CI rows when policy is disabled', () => {
    renderQueueView(
      new Map(),
      makeWorkerStatus([
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
    );

    expect(within(screen.getByTestId('worker-row-autofix')).getByText('Disabled · autoFixRetries=0')).toBeInTheDocument();
    expect(within(screen.getByTestId('worker-row-ci-failure')).getByText('Disabled · autoFixRetries=0')).toBeInTheDocument();
    expect(within(screen.getByTestId('worker-row-ci-failure')).getByText('Starts on launch')).toBeInTheDocument();
  });

  it('calls start worker for a stopped row', () => {
    renderQueueView(
      new Map(),
      makeWorkerStatus([
        makeWorker({
          lifecycle: 'stopped',
          autoStarts: false,
          startable: true,
          stoppable: false,
        }),
      ]),
    );

    fireEvent.click(within(screen.getByTestId('worker-row-autofix')).getByRole('button', { name: 'Enable worker' }));
    expect(onStartWorker).toHaveBeenCalledWith('autofix');
  });

  it('calls stop worker for a running row', () => {
    renderQueueView(
      new Map(),
      makeWorkerStatus([
        makeWorker({
          kind: 'ci-failure',
          autoStarts: true,
          startable: false,
          stoppable: true,
        }),
      ]),
    );

    fireEvent.click(within(screen.getByTestId('worker-row-ci-failure')).getByRole('button', { name: 'Disable worker' }));
    expect(onStopWorker).toHaveBeenCalledWith('ci-failure');
  });

  it('disables worker controls in read-only mode', () => {
    renderQueueView(
      new Map(),
      makeWorkerStatus([
        makeWorker({
          lifecycle: 'stopped',
          autoStarts: false,
          startable: true,
          stoppable: false,
        }),
      ]),
      null,
      true,
    );

    const start = within(screen.getByTestId('worker-row-autofix')).getByRole('button', { name: 'Enable worker' });
    expect(start).toBeDisabled();
    expect(start).toHaveAttribute('title', 'Read-only window');
  });

  it('selects worker rows and keeps action details out of the process list', () => {
    const task = makeUITask({ id: 'wf-1/fix-target', status: 'failed', description: 'needs fix' });
    renderQueueView(
      new Map([[task.id, task]]),
      makeWorkerStatus([
        makeWorker({
          kind: 'ci-failure',
          recentActions: [makeWorkerAction({
            workerKind: 'ci-failure',
            taskId: task.id,
            subjectId: task.id,
          })],
        }),
      ]),
      null,
      false,
      'ci-failure',
    );

    const row = screen.getByTestId('worker-row-ci-failure');
    expect(row.className).toContain('ring-cyan');
    expect(within(row).getByText('Active work')).toBeInTheDocument();
    expect(within(row).getByText('Active work: Fix With Agent · Running')).toBeInTheDocument();
    expect(within(row).queryByText('Last recorded action')).not.toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: 'Open task: fix-target' })).not.toBeInTheDocument();

    fireEvent.click(row);
    expect(onSelectWorker).toHaveBeenCalledWith('ci-failure');
  });

  it('expands relationships only for the affected worker action task', () => {
    const buildTask = makeUITask({
      id: 'wf-1/build',
      status: 'running',
      description: 'Build the project',
      dependencies: [],
    });
    const deployTask = makeUITask({
      id: 'wf-1/deploy',
      status: 'blocked',
      description: 'Deploy after build',
      dependencies: ['wf-1/build'],
    });
    const tasks = new Map<string, TaskState>([
      [buildTask.id, buildTask],
      [deployTask.id, deployTask],
    ]);

    renderQueueView(
      tasks,
      makeWorkerStatus([
        makeWorker({ recentActions: [makeWorkerAction({ taskId: buildTask.id, subjectId: buildTask.id })] }),
      ]),
    );

    expect(screen.getByTestId('queue-rels-toggle-action-wf-1/build')).toBeInTheDocument();
    expect(screen.queryByTestId('queue-rels-toggle-backlog-wf-1/deploy')).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Expand relationships'));

    const relsSection = screen.getByTestId('rels-wf-1/build');
    expect(relsSection.textContent).toContain('downstream:');
    expect(relsSection.textContent).toContain('Deploy after build');

    const deployChip = relsSection.querySelector('button');
    expect(deployChip).not.toBeNull();
    fireEvent.click(deployChip!);
    expect(onTaskClick).toHaveBeenCalledWith(expect.objectContaining({ id: deployTask.id }));
  });

  it('selection highlight persists on expanded worker action rows', () => {
    const buildTask = makeUITask({
      id: 'wf-1/build',
      status: 'running',
      description: 'Build the project',
      dependencies: [],
    });
    const deployTask = makeUITask({
      id: 'wf-1/deploy',
      status: 'blocked',
      description: 'Deploy after build',
      dependencies: ['wf-1/build'],
    });
    const tasks = new Map<string, TaskState>([
      [buildTask.id, buildTask],
      [deployTask.id, deployTask],
    ]);

    renderQueueView(
      tasks,
      makeWorkerStatus([
        makeWorker({ recentActions: [makeWorkerAction({ taskId: buildTask.id, subjectId: buildTask.id })] }),
      ]),
      buildTask.id,
    );

    const selectedRow = screen.getByText('Build the project').closest('[data-row-id]');
    expect(selectedRow?.className).toContain('bg-cyan-950/30');

    fireEvent.click(screen.getByLabelText('Expand relationships'));

    expect(selectedRow?.className).toContain('bg-cyan-950/30');
    expect(screen.getByTestId('rels-wf-1/build')).toBeInTheDocument();
  });
});
