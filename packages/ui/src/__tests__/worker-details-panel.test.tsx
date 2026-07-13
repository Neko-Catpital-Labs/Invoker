import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WorkerDetailsPanel } from '../components/WorkerDetailsPanel.js';
import { makeUITask } from './helpers/mock-invoker.js';
import type { WorkerActionSummary, WorkerStatusEntry, WorkflowMeta } from '../types.js';

const onToggleCollapsed = vi.fn();
const onTaskClick = vi.fn();

const DEFAULT_WORKFLOWS = new Map<string, WorkflowMeta>([
  ['wf-1', { id: 'wf-1', name: 'My Workflow', status: 'running' }],
]);

function makeAction(overrides: Partial<WorkerActionSummary> = {}): WorkerActionSummary {
  return {
    id: 'act-1',
    workerKind: 'ci-failure',
    actionType: 'fix-with-agent',
    workflowId: 'wf-1',
    taskId: 'wf-1/fix-target',
    subjectType: 'task',
    subjectId: 'wf-1/fix-target',
    externalKey: 'wf-1/fix-target',
    status: 'running',
    attemptCount: 1,
    summary: 'Inspecting failed typecheck output.',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeWorker(overrides: Partial<WorkerStatusEntry> = {}): WorkerStatusEntry {
  return {
    kind: 'ci-failure',
    note: 'Repairs failed CI.',
    lifecycle: 'running',
    policy: 'enabled',
    autoStarts: true,
    startable: false,
    stoppable: true,
    recentActions: [makeAction()],
    ...overrides,
  };
}

function renderPanel(
  worker: WorkerStatusEntry | null,
  tasks = new Map(),
  collapsed = false,
  workflows: Map<string, WorkflowMeta> = DEFAULT_WORKFLOWS,
) {
  onToggleCollapsed.mockReset();
  onTaskClick.mockReset();
  render(
    <WorkerDetailsPanel
      worker={worker}
      tasks={tasks}
      workflows={workflows}
      collapsed={collapsed}
      onToggleCollapsed={onToggleCollapsed}
      onTaskClick={onTaskClick}
    />,
  );
}

describe('WorkerDetailsPanel', () => {
  it('shows active worker action details and opens the target task', () => {
    const task = makeUITask({ id: 'wf-1/fix-target', status: 'failed', description: 'needs fix' });
    renderPanel(makeWorker(), new Map([[task.id, task]]));

    expect(screen.getByTestId('worker-details-title')).toHaveTextContent('CI failure repair');
    expect(screen.getByText('Current work')).toBeInTheDocument();
    expect(screen.getAllByText('Task')).toHaveLength(2);
    expect(screen.getAllByText('needs fix')).toHaveLength(2);
    expect(screen.getAllByText('Workflow')).toHaveLength(2);
    expect(screen.getAllByText('My Workflow')).toHaveLength(2);
    expect(screen.getAllByText('Action')).toHaveLength(2);
    expect(screen.getAllByText('Fix With Agent')).toHaveLength(2);
    expect(screen.getAllByText('Running')).toHaveLength(2);

    fireEvent.click(screen.getAllByRole('button', { name: 'Open task: needs fix · My Workflow' })[0]!);
    expect(onTaskClick).toHaveBeenCalledWith(expect.objectContaining({ id: task.id }));
  });

  it('shows completed merge gate target and Autofix history in details', () => {
    renderPanel(makeWorker({
      kind: 'autofix',
      autoStarts: false,
      startable: true,
      stoppable: false,
      recentActions: [makeAction({
        workerKind: 'autofix',
        taskId: '__merge__wf-1',
        subjectId: '__merge__wf-1',
        externalKey: '__merge__wf-1',
        status: 'completed',
        summary: 'Finished merge recovery.',
      })],
      recovery: {
        workerId: 'autofix',
        owner: 'autofix',
        scans: 14,
        submissions: 2,
        skips: 1,
        wakeups: 3,
        lastSkipReason: 'retry budget exhausted',
        lastSkipTaskId: '__merge__wf-1',
      },
    }), new Map());

    expect(screen.getByText('Last recorded action')).toBeInTheDocument();
    expect(screen.getByText('Target task: merge gate · My Workflow')).toBeInTheDocument();
    expect(screen.getByText('Autofix history')).toBeInTheDocument();
    expect(screen.getByText('Scanned 14 · submitted 2 · skipped 1 · last skip: retry budget exhausted on task merge gate')).toBeInTheDocument();
  });

  it('explains pr-status when no actions are persisted', () => {
    renderPanel(makeWorker({
      kind: 'pr-status',
      note: 'Checks pull request status.',
      recentActions: [],
    }));

    expect(screen.getByText('PR status')).toBeInTheDocument();
    expect(screen.getByText('No persisted PR status actions. This worker updates review gates directly.')).toBeInTheDocument();
  });
  it('shows PR CI scan copy when no actions are persisted', () => {
    renderPanel(makeWorker({
      kind: 'pr-ci-failure-scan',
      note: 'Scans mapped PRs for failing CI.',
      recentActions: [],
    }));

    expect(screen.getByTestId('worker-details-title')).toHaveTextContent('PR CI scan');
    expect(screen.getByText('Idle. Scans mapped PRs for failing CI and queues repairs.')).toBeInTheDocument();
    expect(screen.getByText('No PR CI scan runs recorded yet.')).toBeInTheDocument();
  });

  it('shows coderabbit-address as a built-in worker when no actions are persisted', () => {
    renderPanel(makeWorker({
      kind: 'coderabbit-address',
      note: 'Runs the CodeRabbit review-address cron entrypoint under worker scheduling.',
      recentActions: [],
    }));

    expect(screen.getByTestId('worker-details-title')).toHaveTextContent('Coderabbit Address');
    expect(screen.getByText('Idle. Waiting for worker-owned work.')).toBeInTheDocument();
    expect(screen.getByText('No worker actions recorded yet.')).toBeInTheDocument();
  });

  it('uses the same collapsed show control as the inspector', () => {
    renderPanel(makeWorker(), new Map(), true);

    const button = screen.getByRole('button', { name: 'Show details' });
    fireEvent.click(button);
    expect(onToggleCollapsed).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Last recorded action')).not.toBeInTheDocument();
  });

  it('shows empty guidance when no worker is selected', () => {
    renderPanel(null);

    expect(screen.getByText('Worker details')).toBeInTheDocument();
    expect(screen.getByText('Select a worker process to inspect its current work and last recorded action.')).toBeInTheDocument();
  });
});
