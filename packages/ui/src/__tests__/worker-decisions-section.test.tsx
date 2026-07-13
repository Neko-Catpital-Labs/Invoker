import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkerDecisionsSection } from '../components/WorkerDecisionsSection.js';
import type { WorkerActionSummary } from '../types.js';

const decisions: WorkerActionSummary[] = [
  {
    id: 'wd-act',
    workerKind: 'autofix',
    actionType: 'fix-task',
    workflowId: 'wf-1',
    taskId: 'wf-1/task-1',
    subjectType: 'task',
    subjectId: 'wf-1/task-1',
    externalKey: 'wf-1/task-1:g0:a1',
    status: 'queued',
    attemptCount: 1,
    agentName: 'codex',
    decision: 'act',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:01:00.000Z',
  },
  {
    id: 'wd-skip',
    workerKind: 'autofix',
    actionType: 'fix-task',
    workflowId: 'wf-1',
    subjectType: 'task',
    subjectId: 'wf-1/task-2',
    externalKey: 'wf-1/task-2:g0:a1',
    status: 'skipped',
    attemptCount: 3,
    reason: 'worker-retry-budget-exhausted',
    decision: 'skip',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:02:00.000Z',
  },
];

function installGetWorkerDecisions() {
  const getWorkerDecisions = vi.fn(async () => ({
    actions: decisions,
    limit: 25,
    offset: 0,
    hasMore: false,
  }));
  (window as unknown as { invoker: Record<string, unknown> }).invoker = { getWorkerDecisions };
  return getWorkerDecisions;
}

describe('WorkerDecisionsSection', () => {
  afterEach(() => {
    delete (window as unknown as { invoker?: unknown }).invoker;
  });

  it('renders both decision rows with the skip reason and the filter buttons', async () => {
    installGetWorkerDecisions();
    render(<WorkerDecisionsSection workerKind="autofix" />);

    const rows = await screen.findAllByTestId('worker-decision-row');
    expect(rows).toHaveLength(2);
    expect(screen.getByText(/worker-retry-budget-exhausted/)).toBeTruthy();

    expect(screen.getByTestId('worker-decisions-filter-all')).toBeTruthy();
    expect(screen.getByTestId('worker-decisions-filter-act')).toBeTruthy();
    expect(screen.getByTestId('worker-decisions-filter-skip')).toBeTruthy();
  });

  it('re-requests with decision=skip when the skip filter is clicked', async () => {
    const getWorkerDecisions = installGetWorkerDecisions();
    render(<WorkerDecisionsSection workerKind="autofix" />);

    await screen.findAllByTestId('worker-decision-row');

    fireEvent.click(screen.getByTestId('worker-decisions-filter-skip'));

    await waitFor(() => {
      expect(
        getWorkerDecisions.mock.calls.some(
          ([request]) => (request as { decision?: string }).decision === 'skip',
        ),
      ).toBe(true);
    });
  });
});
