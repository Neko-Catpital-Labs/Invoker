import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueueView } from '../components/QueueView.js';
import { makeUITask } from './helpers/mock-invoker.js';
import type { QueueStatus, TaskState } from '../types.js';

describe('QueueView', () => {
  const onTaskClick = vi.fn();
  const onCancel = vi.fn();
  const EMPTY_QUEUE_STATUS: QueueStatus = {
    maxConcurrency: 0,
    runningCount: 0,
    running: [],
    queued: [],
  };

  function renderQueueView(tasks: Map<string, TaskState>, queueStatus: QueueStatus, selectedTaskId: string | null = null) {
    render(
      <QueueView
        tasks={tasks}
        queueStatus={queueStatus}
        onTaskClick={onTaskClick}
        onCancel={onCancel}
        selectedTaskId={selectedTaskId}
      />,
    );
  }

  beforeEach(() => {
    onTaskClick.mockReset();
    onCancel.mockReset();
    vi.stubGlobal('confirm', vi.fn(() => true));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders action queue in running-then-queued order and separates backlog', () => {
    const runningTask = makeUITask({
      id: 'wf-1/running-task',
      status: 'running',
      description: 'running task',
      execution: { phase: 'executing' },
    });
    const queuedTask = makeUITask({
      id: 'wf-1/queued-task',
      status: 'pending',
      description: 'queued task',
    });
    const blockedTask = makeUITask({
      id: 'wf-1/pending-task',
      status: 'blocked',
      description: 'pending task',
      dependencies: ['wf-1/running-task'],
    });
    const tasks = new Map<string, TaskState>([
      [runningTask.id, runningTask],
      [queuedTask.id, queuedTask],
      [blockedTask.id, blockedTask],
    ]);
    const queueStatus: QueueStatus = {
      maxConcurrency: 6,
      runningCount: 1,
      running: [{ taskId: runningTask.id, description: runningTask.description }],
      queued: [{ taskId: queuedTask.id, priority: 0, description: queuedTask.description }],
    };

    renderQueueView(tasks, queueStatus);

    expect(screen.getByText('Action Queue (2)')).toBeInTheDocument();
    expect(screen.getByText('Backlog (1)')).toBeInTheDocument();
    expect(screen.getByText('#1')).toBeInTheDocument();
    expect(screen.getByText('#2')).toBeInTheDocument();
    expect(screen.getByText('Running')).toBeInTheDocument();
    expect(screen.getByText('Pending')).toBeInTheDocument();
    expect(screen.getByText('phase: Executing')).toBeInTheDocument();
    expect(screen.getByText('priority: 0')).toBeInTheDocument();
    expect(screen.getByText('deps: running-task')).toBeInTheDocument();
    expect(screen.getByText('Blocked')).toBeInTheDocument();
  });

  it('renders queue-running launching tasks as Running with launching phase copy', () => {
    const launchingTask = makeUITask({
      id: 'wf-1/launching-task',
      status: 'pending',
      description: 'launching task',
      execution: { phase: 'launching', selectedAttemptId: 'wf-1/launching-task-a1' },
    });
    const tasks = new Map<string, TaskState>([[launchingTask.id, launchingTask]]);
    const queueStatus: QueueStatus = {
      maxConcurrency: 6,
      runningCount: 1,
      running: [{ taskId: launchingTask.id, description: launchingTask.description }],
      queued: [],
    };

    renderQueueView(tasks, queueStatus);

    expect(screen.getByText('Running 1 / 6')).toBeInTheDocument();
    expect(screen.getByText('Running includes launching and AI-fix work.')).toBeInTheDocument();
    expect(screen.getByText('Running')).toBeInTheDocument();
    expect(screen.getByText('phase: Launching')).toBeInTheDocument();
    const row = screen.getByText('launching-task').closest('[data-row-id]');
    expect(row).not.toBeNull();
    expect(row).not.toHaveTextContent('Pending');
  });

  it('supports click-through and cancel actions in queue rows', () => {
    const runningTask = makeUITask({
      id: 'wf-1/run-all-fixture-tests',
      status: 'running',
      description: 'failing task',
      execution: { phase: 'executing' },
    });
    const queuedTask = makeUITask({
      id: 'wf-2/another-task',
      status: 'pending',
      description: 'another task',
    });
    const tasks = new Map<string, TaskState>([
      [runningTask.id, runningTask],
      [queuedTask.id, queuedTask],
    ]);
    const queueStatus: QueueStatus = {
      maxConcurrency: 6,
      runningCount: 1,
      running: [{ taskId: runningTask.id, description: runningTask.description }],
      queued: [{ taskId: queuedTask.id, priority: 1, description: queuedTask.description }],
    };

    renderQueueView(tasks, queueStatus);

    fireEvent.click(screen.getByText('run-all-fixture-tests'));
    expect(onTaskClick).toHaveBeenCalledWith(expect.objectContaining({ id: runningTask.id }));

    fireEvent.click(screen.getAllByText('Terminate')[0]);
    expect(onCancel).toHaveBeenCalledWith(runningTask.id);
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('run-all-fixture-tests'));
    expect(window.confirm).not.toHaveBeenCalledWith(expect.stringContaining('wf-1/'));
  });

  it('renders merge gate ids with a stable label', () => {
    const mergeGateTask = makeUITask({
      id: '__merge__wf-123',
      status: 'blocked',
      description: 'Workflow gate for queued merge',
      dependencies: ['wf-1/build'],
    });
    const tasks = new Map<string, TaskState>([[mergeGateTask.id, mergeGateTask]]);

    renderQueueView(tasks, EMPTY_QUEUE_STATUS);

    expect(screen.getByText('merge gate')).toBeInTheDocument();
    expect(screen.queryByText('__merge__wf-123')).not.toBeInTheDocument();
  });

  it('places manual-action tasks in Action Queue with canonical labels', () => {
    const fixingTask = makeUITask({
      id: 'wf-1/fixing-task',
      status: 'fixing_with_ai',
      description: 'AI fix in progress',
    });
    const needsInputTask = makeUITask({
      id: 'wf-1/input-task',
      status: 'needs_input',
      description: 'waiting for input',
    });
    const reviewTask = makeUITask({
      id: 'wf-1/review-task',
      status: 'review_ready',
      description: 'ready for review',
    });
    const approvalTask = makeUITask({
      id: 'wf-1/approval-task',
      status: 'awaiting_approval',
      description: 'needs approval',
    });
    const blockedTask = makeUITask({
      id: 'wf-1/blocked-task',
      status: 'blocked',
      description: 'blocked by something',
      dependencies: ['wf-1/fixing-task'],
    });
    const tasks = new Map<string, TaskState>([
      [fixingTask.id, fixingTask],
      [needsInputTask.id, needsInputTask],
      [reviewTask.id, reviewTask],
      [approvalTask.id, approvalTask],
      [blockedTask.id, blockedTask],
    ]);

    renderQueueView(tasks, EMPTY_QUEUE_STATUS);

    expect(screen.getByText('Action Queue (4)')).toBeInTheDocument();
    expect(screen.getByText('Backlog (1)')).toBeInTheDocument();
    expect(screen.getByText('Fixing With AI')).toBeInTheDocument();
    expect(screen.getByText('Needs Input')).toBeInTheDocument();
    expect(screen.getByText('Review Ready')).toBeInTheDocument();
    expect(screen.getByText('Awaiting Approval')).toBeInTheDocument();
    expect(screen.getByText('blocked by something')).toBeInTheDocument();
  });

  it('shows pending tasks in Action Queue when scheduler-queued with canonical Pending label', () => {
    const pendingTask = makeUITask({
      id: 'wf-1/pending-task',
      status: 'pending',
      description: 'waiting to run',
    });
    const tasks = new Map<string, TaskState>([[pendingTask.id, pendingTask]]);
    const queueStatus: QueueStatus = {
      maxConcurrency: 6,
      runningCount: 0,
      running: [],
      queued: [{ taskId: pendingTask.id, priority: 5, description: pendingTask.description }],
    };

    renderQueueView(tasks, queueStatus);

    expect(screen.getByText('Action Queue (1)')).toBeInTheDocument();
    expect(screen.getByText('Backlog (0)')).toBeInTheDocument();
    expect(screen.getByText('Pending')).toBeInTheDocument();
    expect(screen.getByText('priority: 5')).toBeInTheDocument();
  });

  describe('relationship expander', () => {
    function setupRelationshipScenario() {
      const taskA = makeUITask({
        id: 'wf-1/task-a',
        status: 'running',
        description: 'first task',
        dependencies: [],
      });
      const taskB = makeUITask({
        id: 'wf-1/task-b',
        status: 'blocked',
        description: 'second task',
        dependencies: ['wf-1/task-a'],
      });
      const taskC = makeUITask({
        id: 'wf-1/task-c',
        status: 'blocked',
        description: 'third task',
        dependencies: ['wf-1/task-b'],
      });
      const tasks = new Map<string, TaskState>([
        [taskA.id, taskA],
        [taskB.id, taskB],
        [taskC.id, taskC],
      ]);
      const queueStatus: QueueStatus = {
        maxConcurrency: 6,
        runningCount: 1,
        running: [{ taskId: taskA.id, description: taskA.description }],
        queued: [],
      };

      return { tasks, taskA, taskB, taskC, queueStatus };
    }

    it('relationships are collapsed by default', () => {
      const { tasks, queueStatus } = setupRelationshipScenario();

      renderQueueView(tasks, queueStatus);

      expect(screen.getByTestId('queue-rels-toggle-action-wf-1/task-a')).toBeInTheDocument();
      expect(screen.getByTestId('queue-rels-toggle-backlog-wf-1/task-b')).toBeInTheDocument();
      expect(screen.getByTestId('queue-rels-toggle-backlog-wf-1/task-c')).toBeInTheDocument();
      expect(screen.queryByText('upstream:')).not.toBeInTheDocument();
      expect(screen.queryByText('downstream:')).not.toBeInTheDocument();
    });

    it('clicking expander toggles relationship section per row', () => {
      const { tasks, queueStatus } = setupRelationshipScenario();

      renderQueueView(tasks, queueStatus);

      const expandButtons = screen.getAllByLabelText('Expand relationships');
      fireEvent.click(expandButtons[0]);

      const relsSection = screen.getByTestId('rels-wf-1/task-a');
      expect(relsSection).toBeInTheDocument();
      expect(relsSection.textContent).toContain('downstream:');
      expect(relsSection.textContent).toContain('task-b');

      const collapseButton = screen.getByLabelText('Collapse relationships');
      fireEvent.click(collapseButton);
      expect(screen.queryByTestId('rels-wf-1/task-a')).not.toBeInTheDocument();
    });

    it('shows both upstream and downstream in expanded row', () => {
      const { tasks, queueStatus } = setupRelationshipScenario();

      renderQueueView(tasks, queueStatus);

      const expandButtons = screen.getAllByLabelText('Expand relationships');
      fireEvent.click(expandButtons[1]);

      expect(screen.getByText('upstream:')).toBeInTheDocument();
      expect(screen.getByText('downstream:')).toBeInTheDocument();
      expect(screen.getByTestId('rels-wf-1/task-b')).toBeInTheDocument();
    });

    it('clicking a related task chip selects and navigates to that task', () => {
      const { tasks, queueStatus } = setupRelationshipScenario();

      renderQueueView(tasks, queueStatus);

      const expandButtons = screen.getAllByLabelText('Expand relationships');
      fireEvent.click(expandButtons[0]);

      const relsSection = screen.getByTestId('rels-wf-1/task-a');
      const taskBChip = relsSection.querySelector('button');
      expect(taskBChip).not.toBeNull();
      fireEvent.click(taskBChip!);

      expect(onTaskClick).toHaveBeenCalledWith(expect.objectContaining({ id: 'wf-1/task-b' }));
    });

    it('does not show rels button for tasks with no relationships', () => {
      const loneTask = makeUITask({
        id: 'wf-1/lone-task',
        status: 'pending',
        description: 'no deps',
        dependencies: [],
      });
      const tasks = new Map<string, TaskState>([[loneTask.id, loneTask]]);
      const queueStatus: QueueStatus = {
        maxConcurrency: 6,
        runningCount: 0,
        running: [],
        queued: [{ taskId: loneTask.id, priority: 0, description: loneTask.description }],
      };

      renderQueueView(tasks, queueStatus);

      expect(screen.queryByTestId('queue-rels-toggle-action-wf-1/lone-task')).not.toBeInTheDocument();
      expect(screen.queryByTestId('queue-rels-toggle-backlog-wf-1/lone-task')).not.toBeInTheDocument();
    });
  });

  describe('integrated queue hardening', () => {
    it('canonical labels, expanded rels, and Terminate coexist in a composed queue', () => {
      const runningTask = makeUITask({
        id: 'wf-1/build',
        status: 'running',
        description: 'Build the project',
        execution: { phase: 'executing' },
        dependencies: [],
      });
      const fixingTask = makeUITask({
        id: 'wf-1/lint',
        status: 'fixing_with_ai',
        description: 'Lint with AI fix',
        dependencies: [],
      });
      const blockedTask = makeUITask({
        id: 'wf-1/deploy',
        status: 'blocked',
        description: 'Deploy after build',
        dependencies: ['wf-1/build'],
      });

      const tasks = new Map<string, TaskState>([
        [runningTask.id, runningTask],
        [fixingTask.id, fixingTask],
        [blockedTask.id, blockedTask],
      ]);
      const queueStatus: QueueStatus = {
        maxConcurrency: 4,
        runningCount: 1,
        running: [{ taskId: runningTask.id, description: runningTask.description }],
        queued: [],
      };

      renderQueueView(tasks, queueStatus);

      expect(screen.getByText('Action Queue (2)')).toBeInTheDocument();
      expect(screen.getByText('Backlog (1)')).toBeInTheDocument();
      expect(screen.getByText('Running')).toBeInTheDocument();
      expect(screen.getByText('Fixing With AI')).toBeInTheDocument();
      expect(screen.getByText('Blocked')).toBeInTheDocument();
      expect(screen.getByText('phase: Executing')).toBeInTheDocument();

      const expandButtons = screen.getAllByLabelText('Expand relationships');
      expect(expandButtons.length).toBe(2);

      fireEvent.click(expandButtons[0]);
      const buildRels = screen.getByTestId('rels-wf-1/build');
      expect(buildRels.textContent).toContain('downstream:');
      expect(buildRels.textContent).toContain('deploy');

      fireEvent.click(expandButtons[1]);
      const deployRels = screen.getByTestId('rels-wf-1/deploy');
      expect(deployRels.textContent).toContain('upstream:');
      expect(deployRels.textContent).toContain('build');

      const terminateButtons = screen.getAllByText('Terminate');
      expect(terminateButtons.length).toBe(3);

      fireEvent.click(terminateButtons[0]);
      expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('build'));
      expect(onCancel).toHaveBeenCalledWith(runningTask.id);

      const deployChip = buildRels.querySelector('button');
      expect(deployChip).not.toBeNull();
      fireEvent.click(deployChip!);
      expect(onTaskClick).toHaveBeenCalledWith(expect.objectContaining({ id: 'wf-1/deploy' }));
    });

    it('selection highlight persists on expanded rows', () => {
      const taskA = makeUITask({
        id: 'wf-1/task-a',
        status: 'running',
        description: 'task a',
        dependencies: [],
      });
      const taskB = makeUITask({
        id: 'wf-1/task-b',
        status: 'blocked',
        description: 'task b',
        dependencies: ['wf-1/task-a'],
      });
      const tasks = new Map<string, TaskState>([
        [taskA.id, taskA],
        [taskB.id, taskB],
      ]);
      const queueStatus: QueueStatus = {
        maxConcurrency: 4,
        runningCount: 1,
        running: [{ taskId: taskA.id, description: taskA.description }],
        queued: [],
      };

      renderQueueView(tasks, queueStatus, 'wf-1/task-a');

      const selectedRow = screen.getByText('task-a').closest('[data-row-id]');
      expect(selectedRow?.className).toContain('bg-gray-600');

      const expandButtons = screen.getAllByLabelText('Expand relationships');
      fireEvent.click(expandButtons[0]);

      expect(selectedRow?.className).toContain('bg-gray-600');
      expect(screen.getByTestId('rels-wf-1/task-a')).toBeInTheDocument();
    });
  });
});
