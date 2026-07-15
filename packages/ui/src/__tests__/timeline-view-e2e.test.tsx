/**
 * Component test: Timeline view rendering and interaction.
 *
 * Demoted from packages/app/e2e/timeline-view.spec.ts.
 * Tests worker timeline behavior plus the preserved task Gantt mode.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, act, waitFor, fireEvent, within } from '@testing-library/react';
import { vi } from 'vitest';
import { App } from '../App.js';
import { createMockInvoker, makeUITask, type MockInvoker } from './helpers/mock-invoker.js';
import type { WorkerActionSummary, WorkflowMeta } from '../types.js';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

const workflowAlpha: WorkflowMeta = { id: 'wf-alpha', name: 'Alpha Flow', status: 'running' };
const workflowBeta: WorkflowMeta = { id: 'wf-beta', name: 'Beta Flow', status: 'running' };

const alpha = makeUITask({
  id: 'wf-alpha/task-alpha',
  description: 'First test task',
  status: 'pending',
  workflowId: workflowAlpha.id,
  command: 'echo hello-alpha',
});

const beta = makeUITask({
  id: 'wf-alpha/task-beta',
  description: 'Second test task',
  status: 'pending',
  workflowId: workflowAlpha.id,
  dependencies: [alpha.id],
  command: 'echo hello-beta',
});

const gamma = makeUITask({
  id: 'wf-beta/task-gamma',
  description: 'Third test task',
  status: 'pending',
  workflowId: workflowBeta.id,
  command: 'echo hello-gamma',
});

function makeWorkerAction(overrides: Partial<WorkerActionSummary> & {
  id: string;
  workerKind: string;
  workflowId: string;
  createdAt: string;
}): WorkerActionSummary {
  return {
    id: overrides.id,
    workerKind: overrides.workerKind,
    actionType: 'repair',
    workflowId: overrides.workflowId,
    taskId: alpha.id,
    subjectType: 'task',
    subjectId: alpha.id,
    externalKey: `action:${overrides.id}`,
    status: 'completed',
    attemptCount: 1,
    createdAt: overrides.createdAt,
    updatedAt: overrides.createdAt,
    ...overrides,
  };
}

async function chooseGraphMenuItem(testId: string): Promise<void> {
  fireEvent.click(screen.getByTestId('graph-more-button'));
  await waitFor(() => {
    expect(screen.getByTestId('graph-more-menu')).toBeInTheDocument();
  });
  fireEvent.click(screen.getByTestId(testId));
}

async function chooseTimelineMode(mode: 'workers' | 'tasks'): Promise<void> {
  fireEvent.click(screen.getByTestId(`timeline-mode-${mode}`));
  await waitFor(() => {
    expect(screen.getByTestId(`timeline-mode-${mode}`)).toHaveAttribute('aria-pressed', 'true');
  });
}

function getWorkerActionOrder(): Array<string | null> {
  return within(screen.getByTestId('worker-timeline-list'))
    .getAllByRole('button')
    .map((element) => element.getAttribute('data-testid'));
}

describe('Timeline view (component)', () => {
  let mock: MockInvoker;

  beforeEach(() => {
    mock = createMockInvoker();
    mock.install();
  });

  afterEach(() => {
    mock.cleanup();
  });

  it('opening Timeline shows Workers mode by default', async () => {
    render(<App />);
    act(() => {
      mock.setTasks([alpha, beta], [workflowAlpha]);
      mock.setWorkerDecisions({ actions: [], limit: 100, offset: 0, hasMore: false, workflowId: workflowAlpha.id });
    });

    await chooseGraphMenuItem('rail-timeline');

    await waitFor(() => {
      expect(screen.getByTestId('timeline-view')).toBeInTheDocument();
      expect(screen.getByTestId('timeline-mode-workers')).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByTestId('worker-timeline-view')).toBeInTheDocument();
    });
  });

  it('switching to Tasks mode still shows the existing task bars', async () => {
    render(<App />);
    act(() => {
      mock.setTasks([alpha, beta], [workflowAlpha]);
    });

    await chooseGraphMenuItem('rail-timeline');
    await chooseTimelineMode('tasks');

    await waitFor(() => {
      expect(screen.getByTestId('timeline-bar-wf-alpha/task-alpha')).toBeInTheDocument();
      expect(screen.getByTestId('timeline-bar-wf-alpha/task-beta')).toBeInTheDocument();
    });
  });

  it('completed task shows elapsed time in Tasks mode', async () => {
    const now = Date.now();
    const completedAlpha = makeUITask({
      id: alpha.id,
      description: alpha.description,
      status: 'completed',
      workflowId: workflowAlpha.id,
      command: 'echo hello-alpha',
      execution: {
        startedAt: new Date(now - 5000),
        completedAt: new Date(now),
      },
    } as never);

    render(<App />);
    act(() => {
      mock.setTasks([completedAlpha, beta], [workflowAlpha]);
    });

    await chooseGraphMenuItem('rail-timeline');
    await chooseTimelineMode('tasks');

    await waitFor(() => {
      const bar = screen.getByTestId('timeline-bar-wf-alpha/task-alpha');
      expect(bar).toHaveTextContent(/\d+s/);
    });
  });

  it('clicking a task timeline row updates the inspector', async () => {
    const now = Date.now();
    const startedAlpha = makeUITask({
      id: alpha.id,
      description: alpha.description,
      status: 'completed',
      workflowId: workflowAlpha.id,
      command: 'echo hello-alpha',
      execution: {
        startedAt: new Date(now - 5000),
        completedAt: new Date(now),
      },
    } as never);

    render(<App />);
    act(() => {
      mock.setTasks([startedAlpha, beta], [workflowAlpha]);
    });

    await chooseGraphMenuItem('rail-timeline');
    await chooseTimelineMode('tasks');

    await waitFor(() => {
      expect(screen.getByTestId('timeline-bar-wf-alpha/task-alpha')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('timeline-bar-wf-alpha/task-alpha'));

    await waitFor(() => {
      expect(screen.getByTestId('workflow-inspector-title')).toHaveTextContent('First test task');
    });
  });

  it('task timeline row text keeps selectable text styling', async () => {
    render(<App />);
    act(() => {
      mock.setTasks([alpha, beta], [workflowAlpha]);
    });

    await chooseGraphMenuItem('rail-timeline');
    await chooseTimelineMode('tasks');

    await waitFor(() => {
      expect(screen.getByTestId('timeline-bar-wf-alpha/task-alpha')).toBeInTheDocument();
    });

    const row = screen.getByTestId('timeline-bar-wf-alpha/task-alpha');
    expect(row.getAttribute('role')).toBe('button');

    const taskLabel = row.querySelector('.select-text');
    expect(taskLabel).not.toBeNull();
    expect(taskLabel!.classList.contains('cursor-text')).toBe(true);
  });

  it('workflow select changes the worker decision request scope', async () => {
    const betaAction = makeWorkerAction({
      id: 'beta-action',
      workerKind: 'autofix',
      workflowId: workflowBeta.id,
      createdAt: '2024-01-01T00:03:00Z',
      taskId: gamma.id,
      subjectId: gamma.id,
      completedAt: '2024-01-01T00:03:10Z',
    });

    render(<App />);
    act(() => {
      mock.setTasks([alpha, beta, gamma], [workflowAlpha, workflowBeta]);
      mock.setWorkerDecisions((request) => {
        if (request.workflowId === workflowBeta.id) {
          return { actions: [betaAction], limit: 100, offset: request.offset ?? 0, hasMore: false, workflowId: workflowBeta.id };
        }
        return { actions: [], limit: 100, offset: request.offset ?? 0, hasMore: false, workflowId: workflowAlpha.id };
      });
    });

    await chooseGraphMenuItem('rail-timeline');

    await waitFor(() => {
      expect(mock.api.getWorkerDecisions).toHaveBeenCalledWith({ workflowId: workflowAlpha.id, limit: 100, offset: 0 });
    });

    fireEvent.change(screen.getByTestId('worker-timeline-workflow-select'), { target: { value: workflowBeta.id } });

    await waitFor(() => {
      expect(mock.api.getWorkerDecisions).toHaveBeenCalledWith({ workflowId: workflowBeta.id, limit: 100, offset: 0 });
      expect(screen.getByTestId('worker-timeline-action-beta-action-launched')).toBeInTheDocument();
    });
  });

  it('renders worker events as one chronological list and preserves task mode behavior', async () => {
    const alphaOlder = makeWorkerAction({
      id: 'alpha-older',
      workerKind: 'autofix',
      workflowId: workflowAlpha.id,
      createdAt: '2024-01-01T00:00:05Z',
      taskId: alpha.id,
      subjectId: alpha.id,
      completedAt: '2024-01-01T00:00:08Z',
      reason: 'Retry budget opened a repair path.',
      summary: 'Repair finished cleanly.',
    });
    const alphaRepair = makeWorkerAction({
      id: 'alpha-repair',
      workerKind: 'autofix',
      workflowId: workflowAlpha.id,
      createdAt: '2024-01-01T00:00:10Z',
      taskId: alpha.id,
      subjectId: alpha.id,
      completedAt: '2024-01-01T00:00:20Z',
      reason: 'Autofix picked the failing task.',
      summary: 'Repair finished cleanly.',
    });
    const alphaReview = makeWorkerAction({
      id: 'alpha-review',
      workerKind: 'pr-summary-refresh',
      workflowId: workflowAlpha.id,
      createdAt: '2024-01-01T00:00:30Z',
      taskId: beta.id,
      subjectId: beta.id,
      actionType: 'refresh-review',
      completedAt: '2024-01-01T00:00:40Z',
      summary: 'Updated review metadata.',
    });
    const alphaInspect = makeWorkerAction({
      id: 'alpha-inspect',
      workerKind: 'autofix',
      workflowId: workflowAlpha.id,
      createdAt: '2024-01-01T00:00:50Z',
      taskId: alpha.id,
      subjectId: alpha.id,
      actionType: 'inspect',
      status: 'running',
      updatedAt: '2024-01-01T00:00:55Z',
      completedAt: undefined,
      reason: 'Selected task still has open execution output.',
    });

    render(<App />);
    act(() => {
      mock.setTasks([alpha, beta, gamma], [workflowAlpha, workflowBeta]);
      mock.setWorkerDecisions((request) => {
        if (request.workflowId !== workflowAlpha.id) {
          return { actions: [], limit: 100, offset: request.offset ?? 0, hasMore: false, workflowId: request.workflowId };
        }
        if ((request.offset ?? 0) === 0) {
          return {
            actions: [alphaRepair, alphaReview, alphaInspect],
            limit: 100,
            offset: 0,
            hasMore: true,
            workflowId: workflowAlpha.id,
          };
        }
        return {
          actions: [alphaOlder],
          limit: 100,
          offset: request.offset ?? 0,
          hasMore: false,
          workflowId: workflowAlpha.id,
        };
      });
    });

    await chooseGraphMenuItem('rail-timeline');

    await waitFor(() => {
      expect(screen.getByTestId('timeline-mode-workers')).toHaveAttribute('aria-pressed', 'true');
      expect(getWorkerActionOrder()).toEqual([
        'worker-timeline-action-alpha-repair-launched',
        'worker-timeline-action-alpha-repair-finished',
        'worker-timeline-action-alpha-review-launched',
        'worker-timeline-action-alpha-review-finished',
        'worker-timeline-action-alpha-inspect-launched',
      ]);
    });

    expect(screen.getByTestId('worker-timeline-row-alpha-repair-launched')).toHaveTextContent('Autofix');
    expect(screen.getByTestId('worker-timeline-row-alpha-repair-launched')).toHaveTextContent('Repair');
    expect(screen.getByTestId('worker-timeline-row-alpha-repair-launched')).toHaveTextContent('Launched');
    expect(screen.getByTestId('worker-timeline-row-alpha-repair-finished')).toHaveTextContent('Finished executing');
    expect(screen.getByTestId('worker-timeline-row-alpha-review-launched')).toHaveTextContent('PR summary refresh');
    expect(screen.getByTestId('worker-timeline-row-alpha-review-launched')).toHaveTextContent('Refresh Review');
    expect(screen.getByTestId('worker-timeline-row-alpha-inspect-launched')).toHaveTextContent('Inspect');

    fireEvent.click(screen.getByTestId('worker-timeline-action-alpha-repair-finished'));

    await waitFor(() => {
      expect(screen.getByTestId('workflow-inspector-title')).toHaveTextContent('First test task');
    });

    fireEvent.click(screen.getByTestId('worker-timeline-filter-autofix'));

    await waitFor(() => {
      expect(getWorkerActionOrder()).toEqual([
        'worker-timeline-action-alpha-repair-launched',
        'worker-timeline-action-alpha-repair-finished',
        'worker-timeline-action-alpha-inspect-launched',
      ]);
      expect(screen.queryByTestId('worker-timeline-action-alpha-review-launched')).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('worker-timeline-filter-autofix'));

    await waitFor(() => {
      expect(getWorkerActionOrder()).toEqual([
        'worker-timeline-action-alpha-repair-launched',
        'worker-timeline-action-alpha-repair-finished',
        'worker-timeline-action-alpha-review-launched',
        'worker-timeline-action-alpha-review-finished',
        'worker-timeline-action-alpha-inspect-launched',
      ]);
    });

    fireEvent.change(screen.getByTestId('worker-timeline-task-search'), { target: { value: 'first' } });

    await waitFor(() => {
      expect(getWorkerActionOrder()).toEqual([
        'worker-timeline-action-alpha-repair-launched',
        'worker-timeline-action-alpha-repair-finished',
        'worker-timeline-action-alpha-inspect-launched',
      ]);
      expect(screen.queryByTestId('worker-timeline-action-alpha-review-launched')).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('worker-timeline-load-more'));

    await waitFor(() => {
      expect(mock.api.getWorkerDecisions).toHaveBeenCalledWith({ workflowId: workflowAlpha.id, limit: 100, offset: 3 });
      expect(getWorkerActionOrder()).toEqual([
        'worker-timeline-action-alpha-older-launched',
        'worker-timeline-action-alpha-older-finished',
        'worker-timeline-action-alpha-repair-launched',
        'worker-timeline-action-alpha-repair-finished',
        'worker-timeline-action-alpha-inspect-launched',
      ]);
    });

    expect(within(screen.getByTestId('worker-timeline-list')).getAllByText('Retry budget opened a repair path.')).toHaveLength(2);
    expect(within(screen.getByTestId('worker-timeline-list')).getAllByText('Repair finished cleanly.')).toHaveLength(4);
    expect(within(screen.getByTestId('worker-timeline-list')).getByText('Selected task still has open execution output.')).toBeInTheDocument();

    await chooseTimelineMode('tasks');

    await waitFor(() => {
      expect(screen.getByTestId('timeline-bar-wf-alpha/task-alpha')).toBeInTheDocument();
      expect(screen.getByTestId('timeline-bar-wf-alpha/task-beta')).toBeInTheDocument();
    });
  });

  it('switching back to Home workflow graph works', async () => {
    render(<App />);
    act(() => {
      mock.setTasks([alpha, beta], [workflowAlpha]);
    });

    await chooseGraphMenuItem('rail-timeline');
    await chooseTimelineMode('tasks');

    await waitFor(() => {
      expect(screen.getByTestId('timeline-bar-wf-alpha/task-alpha')).toBeInTheDocument();
    });

    await chooseGraphMenuItem('rail-home');

    await waitFor(() => {
      expect(screen.queryByTestId('timeline-view')).not.toBeInTheDocument();
      expect(screen.getByTestId('workflow-node-wf-alpha')).toBeInTheDocument();
    });
  });
});
