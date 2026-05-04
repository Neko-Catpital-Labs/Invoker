import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueueView } from '../components/QueueView.js';
import { makeUITask } from './helpers/mock-invoker.js';
import type { TaskState } from '../types.js';

describe('QueueView', () => {
  const onTaskClick = vi.fn();
  const onCancel = vi.fn();

  beforeEach(() => {
    onTaskClick.mockReset();
    onCancel.mockReset();
    vi.stubGlobal('confirm', vi.fn(() => true));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders action queue in running-then-queued order and separates backlog', async () => {
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

    const getQueueStatus = vi.fn(async () => ({
      maxConcurrency: 6,
      runningCount: 1,
      running: [{ taskId: runningTask.id, description: runningTask.description }],
      queued: [{ taskId: queuedTask.id, priority: 0, description: queuedTask.description }],
    }));
    (window as unknown as { invoker: unknown }).invoker = { getQueueStatus };

    render(
      <QueueView
        tasks={tasks}
        onTaskClick={onTaskClick}
        onCancel={onCancel}
        selectedTaskId={null}
      />,
    );

    await waitFor(() => expect(getQueueStatus).toHaveBeenCalled());
    expect(screen.getByText('Action Queue (2)')).toBeInTheDocument();
    expect(screen.getByText('Backlog (1)')).toBeInTheDocument();
    expect(screen.getByText('#1')).toBeInTheDocument();
    expect(screen.getByText('#2')).toBeInTheDocument();
    // Canonical status labels instead of raw "running"/"queued"
    expect(screen.getByText('Running')).toBeInTheDocument();
    expect(screen.getByText('Pending')).toBeInTheDocument();
    expect(screen.getByText('phase: Executing')).toBeInTheDocument();
    expect(screen.getByText('priority: 0')).toBeInTheDocument();
    expect(screen.getByText('deps: running-task')).toBeInTheDocument();
    // Backlog rows now show canonical status badge
    expect(screen.getByText('Blocked')).toBeInTheDocument();
  });

  it('supports click-through and cancel actions in queue rows', async () => {
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

    const getQueueStatus = vi.fn(async () => ({
      maxConcurrency: 6,
      runningCount: 1,
      running: [{ taskId: runningTask.id, description: runningTask.description }],
      queued: [{ taskId: queuedTask.id, priority: 1, description: queuedTask.description }],
    }));
    (window as unknown as { invoker: unknown }).invoker = { getQueueStatus };

    render(
      <QueueView
        tasks={tasks}
        onTaskClick={onTaskClick}
        onCancel={onCancel}
        selectedTaskId={null}
      />,
    );

    await waitFor(() => expect(getQueueStatus).toHaveBeenCalled());

    fireEvent.click(screen.getByText('run-all-fixture-tests'));
    expect(onTaskClick).toHaveBeenCalledWith(expect.objectContaining({ id: runningTask.id }));

    fireEvent.click(screen.getAllByText('Terminate')[0]);
    expect(onCancel).toHaveBeenCalledWith(runningTask.id);
    // Confirm dialog uses display-friendly task ID, not raw ID
    expect(window.confirm).toHaveBeenCalledWith(
      expect.stringContaining('run-all-fixture-tests'),
    );
    expect(window.confirm).not.toHaveBeenCalledWith(
      expect.stringContaining('wf-1/'),
    );
  });

  it('renders merge gate ids with a stable label', async () => {
    const mergeGateTask = makeUITask({
      id: '__merge__wf-123',
      status: 'blocked',
      description: 'Workflow gate for queued merge',
      dependencies: ['wf-1/build'],
    });
    const tasks = new Map<string, TaskState>([
      [mergeGateTask.id, mergeGateTask],
    ]);

    const getQueueStatus = vi.fn(async () => ({
      maxConcurrency: 6,
      runningCount: 0,
      running: [],
      queued: [],
    }));
    (window as unknown as { invoker: unknown }).invoker = { getQueueStatus };

    render(
      <QueueView
        tasks={tasks}
        onTaskClick={onTaskClick}
        onCancel={onCancel}
        selectedTaskId={null}
      />,
    );

    await waitFor(() => expect(getQueueStatus).toHaveBeenCalled());
    expect(screen.getByText('merge gate')).toBeInTheDocument();
    expect(screen.queryByText('__merge__wf-123')).not.toBeInTheDocument();
  });

  it('places manual-action tasks in Action Queue with canonical labels', async () => {
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

    const getQueueStatus = vi.fn(async () => ({
      maxConcurrency: 6,
      runningCount: 0,
      running: [],
      queued: [],
    }));
    (window as unknown as { invoker: unknown }).invoker = { getQueueStatus };

    render(
      <QueueView
        tasks={tasks}
        onTaskClick={onTaskClick}
        onCancel={onCancel}
        selectedTaskId={null}
      />,
    );

    await waitFor(() => expect(getQueueStatus).toHaveBeenCalled());

    // All manual-action tasks land in Action Queue
    expect(screen.getByText('Action Queue (4)')).toBeInTheDocument();
    expect(screen.getByText('Backlog (1)')).toBeInTheDocument();

    // Canonical status labels
    expect(screen.getByText('Fixing With AI')).toBeInTheDocument();
    expect(screen.getByText('Needs Input')).toBeInTheDocument();
    expect(screen.getByText('Review Ready')).toBeInTheDocument();
    expect(screen.getByText('Awaiting Approval')).toBeInTheDocument();

    // Blocked task stays in backlog
    expect(screen.getByText('blocked by something')).toBeInTheDocument();
  });

  it('shows pending tasks in Action Queue when scheduler-queued with canonical Pending label', async () => {
    const pendingTask = makeUITask({
      id: 'wf-1/pending-task',
      status: 'pending',
      description: 'waiting to run',
    });
    const tasks = new Map<string, TaskState>([
      [pendingTask.id, pendingTask],
    ]);

    const getQueueStatus = vi.fn(async () => ({
      maxConcurrency: 6,
      runningCount: 0,
      running: [],
      queued: [{ taskId: pendingTask.id, priority: 5, description: pendingTask.description }],
    }));
    (window as unknown as { invoker: unknown }).invoker = { getQueueStatus };

    render(
      <QueueView
        tasks={tasks}
        onTaskClick={onTaskClick}
        onCancel={onCancel}
        selectedTaskId={null}
      />,
    );

    await waitFor(() => expect(getQueueStatus).toHaveBeenCalled());
    expect(screen.getByText('Action Queue (1)')).toBeInTheDocument();
    expect(screen.getByText('Backlog (0)')).toBeInTheDocument();
    expect(screen.getByText('Pending')).toBeInTheDocument();
    expect(screen.getByText('priority: 5')).toBeInTheDocument();
  });

  describe('relationship expander', () => {
    function setupRelationshipScenario() {
      // A -> B -> C chain: A has no deps, B depends on A, C depends on B.
      // This gives A downstream=[B], B upstream=[A] downstream=[C], C upstream=[B].
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

      const getQueueStatus = vi.fn(async () => ({
        maxConcurrency: 6,
        runningCount: 1,
        running: [{ taskId: taskA.id, description: taskA.description }],
        queued: [],
      }));
      (window as unknown as { invoker: unknown }).invoker = { getQueueStatus };

      return { tasks, taskA, taskB, taskC, getQueueStatus };
    }

    it('relationships are collapsed by default', async () => {
      const { tasks, getQueueStatus } = setupRelationshipScenario();

      render(
        <QueueView
          tasks={tasks}
          onTaskClick={onTaskClick}
          onCancel={onCancel}
          selectedTaskId={null}
        />,
      );

      await waitFor(() => expect(getQueueStatus).toHaveBeenCalled());

      // The rels toggle buttons should be present (tasks have relationships).
      // task-a is in Action Queue; task-b and task-c are in Backlog.
      expect(screen.getByTestId('queue-rels-toggle-action-wf-1/task-a')).toBeInTheDocument();
      expect(screen.getByTestId('queue-rels-toggle-backlog-wf-1/task-b')).toBeInTheDocument();
      expect(screen.getByTestId('queue-rels-toggle-backlog-wf-1/task-c')).toBeInTheDocument();

      // But no upstream/downstream labels should be visible (collapsed)
      expect(screen.queryByText('upstream:')).not.toBeInTheDocument();
      expect(screen.queryByText('downstream:')).not.toBeInTheDocument();
    });

    it('clicking expander toggles relationship section per row', async () => {
      const { tasks, getQueueStatus } = setupRelationshipScenario();

      render(
        <QueueView
          tasks={tasks}
          onTaskClick={onTaskClick}
          onCancel={onCancel}
          selectedTaskId={null}
        />,
      );

      await waitFor(() => expect(getQueueStatus).toHaveBeenCalled());

      // task-a is in Action Queue; it has downstream only (task-b depends on it).
      // Expand task-a's relationships.
      const expandButtons = screen.getAllByLabelText('Expand relationships');
      // Click the first one (task-a in Action Queue)
      fireEvent.click(expandButtons[0]);

      // Now the relationship section for task-a should appear
      const relsSection = screen.getByTestId('rels-wf-1/task-a');
      expect(relsSection).toBeInTheDocument();
      expect(relsSection.textContent).toContain('downstream:');
      expect(relsSection.textContent).toContain('task-b');

      // Click again to collapse
      const collapseButton = screen.getByLabelText('Collapse relationships');
      fireEvent.click(collapseButton);
      expect(screen.queryByTestId('rels-wf-1/task-a')).not.toBeInTheDocument();
    });

    it('shows both upstream and downstream in expanded row', async () => {
      const { tasks, getQueueStatus } = setupRelationshipScenario();

      render(
        <QueueView
          tasks={tasks}
          onTaskClick={onTaskClick}
          onCancel={onCancel}
          selectedTaskId={null}
        />,
      );

      await waitFor(() => expect(getQueueStatus).toHaveBeenCalled());

      // task-b is in Backlog (blocked), has upstream=[task-a] and downstream=[task-c].
      // Find the rels button for task-b in backlog.
      // The backlog has task-b and task-c. task-b has both directions.
      const expandButtons = screen.getAllByLabelText('Expand relationships');
      // There should be buttons for task-a (action queue), task-b (backlog), task-c (backlog).
      // task-a has only downstream, task-b has both, task-c has only upstream.
      // Expand task-b (second expand button, index 1)
      fireEvent.click(expandButtons[1]);

      expect(screen.getByText('upstream:')).toBeInTheDocument();
      expect(screen.getByText('downstream:')).toBeInTheDocument();
      // upstream chip shows task-a
      expect(screen.getByTestId('rels-wf-1/task-b')).toBeInTheDocument();
    });

    it('clicking a related task chip selects and navigates to that task', async () => {
      const { tasks, getQueueStatus } = setupRelationshipScenario();

      render(
        <QueueView
          tasks={tasks}
          onTaskClick={onTaskClick}
          onCancel={onCancel}
          selectedTaskId={null}
        />,
      );

      await waitFor(() => expect(getQueueStatus).toHaveBeenCalled());

      // Expand task-a to see downstream task-b chip
      const expandButtons = screen.getAllByLabelText('Expand relationships');
      fireEvent.click(expandButtons[0]);

      // The downstream chip for task-b is inside the rels section
      const relsSection = screen.getByTestId('rels-wf-1/task-a');
      const taskBChip = relsSection.querySelector('button');
      expect(taskBChip).not.toBeNull();
      fireEvent.click(taskBChip!);

      // onTaskClick should have been called with task-b's state
      expect(onTaskClick).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'wf-1/task-b' }),
      );
    });

    it('does not show rels button for tasks with no relationships', async () => {
      const loneTask = makeUITask({
        id: 'wf-1/lone-task',
        status: 'pending',
        description: 'no deps',
        dependencies: [],
      });
      const tasks = new Map<string, TaskState>([
        [loneTask.id, loneTask],
      ]);

      const getQueueStatus = vi.fn(async () => ({
        maxConcurrency: 6,
        runningCount: 0,
        running: [],
        queued: [{ taskId: loneTask.id, priority: 0, description: loneTask.description }],
      }));
      (window as unknown as { invoker: unknown }).invoker = { getQueueStatus };

      render(
        <QueueView
          tasks={tasks}
          onTaskClick={onTaskClick}
          onCancel={onCancel}
          selectedTaskId={null}
        />,
      );

      await waitFor(() => expect(getQueueStatus).toHaveBeenCalled());
      expect(screen.queryByTestId('queue-rels-toggle-action-wf-1/lone-task')).not.toBeInTheDocument();
      expect(screen.queryByTestId('queue-rels-toggle-backlog-wf-1/lone-task')).not.toBeInTheDocument();
    });
  });

  describe('integrated queue hardening', () => {
    it('canonical labels, expanded rels, and Terminate coexist in a composed queue', async () => {
      // Scenario: running task with a downstream blocked dep, plus a manual-action task.
      // Exercises all three prior-workflow features together:
      // 1. Canonical status labels (Running, Fixing With AI, Blocked)
      // 2. Relationship expanders (upstream/downstream chips)
      // 3. Task-level Terminate wording on action buttons
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

      const getQueueStatus = vi.fn(async () => ({
        maxConcurrency: 4,
        runningCount: 1,
        running: [{ taskId: runningTask.id, description: runningTask.description }],
        queued: [],
      }));
      (window as unknown as { invoker: unknown }).invoker = { getQueueStatus };

      render(
        <QueueView
          tasks={tasks}
          onTaskClick={onTaskClick}
          onCancel={onCancel}
          selectedTaskId={null}
        />,
      );

      await waitFor(() => expect(getQueueStatus).toHaveBeenCalled());

      // 1. Canonical status labels present in both sections
      expect(screen.getByText('Action Queue (2)')).toBeInTheDocument();
      expect(screen.getByText('Backlog (1)')).toBeInTheDocument();
      expect(screen.getByText('Running')).toBeInTheDocument();
      expect(screen.getByText('Fixing With AI')).toBeInTheDocument();
      expect(screen.getByText('Blocked')).toBeInTheDocument();
      expect(screen.getByText('phase: Executing')).toBeInTheDocument();

      // 2. Relationship expanders visible on tasks with deps
      const expandButtons = screen.getAllByLabelText('Expand relationships');
      expect(expandButtons.length).toBe(2); // build (downstream) and deploy (upstream)

      // Expand the running task (build) to see downstream
      fireEvent.click(expandButtons[0]);
      const buildRels = screen.getByTestId('rels-wf-1/build');
      expect(buildRels.textContent).toContain('downstream:');
      expect(buildRels.textContent).toContain('deploy');

      // Expand the blocked task (deploy) to see upstream
      fireEvent.click(expandButtons[1]);
      const deployRels = screen.getByTestId('rels-wf-1/deploy');
      expect(deployRels.textContent).toContain('upstream:');
      expect(deployRels.textContent).toContain('build');

      // 3. Task-level Terminate buttons present on all action rows
      const terminateButtons = screen.getAllByText('Terminate');
      expect(terminateButtons.length).toBe(3); // 2 action + 1 backlog

      // Click Terminate on the running task — confirm uses display-friendly ID
      fireEvent.click(terminateButtons[0]);
      expect(window.confirm).toHaveBeenCalledWith(
        expect.stringContaining('build'),
      );
      expect(onCancel).toHaveBeenCalledWith(runningTask.id);

      // Navigate via relationship chip: click "deploy" chip in build's rels
      const deployChip = buildRels.querySelector('button');
      expect(deployChip).not.toBeNull();
      fireEvent.click(deployChip!);
      expect(onTaskClick).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'wf-1/deploy' }),
      );
    });

    it('selection highlight persists on expanded rows', async () => {
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

      const getQueueStatus = vi.fn(async () => ({
        maxConcurrency: 4,
        runningCount: 1,
        running: [{ taskId: taskA.id, description: taskA.description }],
        queued: [],
      }));
      (window as unknown as { invoker: unknown }).invoker = { getQueueStatus };

      // Render with task-a selected
      render(
        <QueueView
          tasks={tasks}
          onTaskClick={onTaskClick}
          onCancel={onCancel}
          selectedTaskId="wf-1/task-a"
        />,
      );

      await waitFor(() => expect(getQueueStatus).toHaveBeenCalled());

      // The selected row should have bg-gray-600 highlight
      const selectedRow = screen.getByText('task-a').closest('[data-row-id]');
      expect(selectedRow?.className).toContain('bg-gray-600');

      // Expand relationships on the selected row
      const expandButtons = screen.getAllByLabelText('Expand relationships');
      fireEvent.click(expandButtons[0]);

      // Selection highlight still applies after expansion
      expect(selectedRow?.className).toContain('bg-gray-600');
      expect(screen.getByTestId('rels-wf-1/task-a')).toBeInTheDocument();
    });
  });
});
