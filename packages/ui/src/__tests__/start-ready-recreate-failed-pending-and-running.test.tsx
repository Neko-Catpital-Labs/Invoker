import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import type { StartReadyResult } from '@invoker/contracts';
import { createMockInvoker, makeUITask, type MockInvoker } from './helpers/mock-invoker.js';
import type { WorkflowMeta } from '../types.js';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

const { App } = await import('../App.js');

const previewResult: StartReadyResult = {
  preview: {
    readyTaskIds: ['wf-1/ready'],
    recoverableTaskIds: [],
    failedWorkflowIds: ['wf-2'],
    pendingWorkflowIds: ['wf-1'],
    runningWorkflowIds: ['wf-3'],
    completedWorkflowIds: [],
    skipped: {
      awaitingApproval: 0,
      reviewReady: 0,
      blocked: 0,
      failedTasks: 1,
      pendingTasks: 1,
      runningTasks: 1,
      completedTasks: 0,
    },
  },
  started: [],
  recreatedWorkflowIds: [],
  dryRun: true,
};

describe('Start and recreate failed, pending, and running', () => {
  let mock: MockInvoker;

  beforeEach(() => {
    mock = createMockInvoker();
    mock.api.startReady = vi.fn(async (request) => {
      if (request?.dryRun) return previewResult;
      return {
        ...previewResult,
        dryRun: false,
        recreatedWorkflowIds: ['wf-1', 'wf-2', 'wf-3'],
      };
    });
    mock.install();
  });

  afterEach(() => {
    mock.cleanup();
  });

  it('opens the preview dialog for failed-pending-and-running and confirms with the broader flag', async () => {
    const workflows: WorkflowMeta[] = [
      { id: 'wf-1', name: 'Alpha', status: 'running' },
      { id: 'wf-2', name: 'Beta', status: 'failed' },
      { id: 'wf-3', name: 'Gamma', status: 'running' },
    ];
    const pending = makeUITask({ id: 'wf-1/ready', description: 'Ready', status: 'pending', workflowId: 'wf-1' });
    const failed = makeUITask({ id: 'wf-2/failed', description: 'Failed', status: 'failed', workflowId: 'wf-2' });
    const running = makeUITask({ id: 'wf-3/running', description: 'Running', status: 'running', workflowId: 'wf-3' });

    render(<App />);
    act(() => mock.setTasks([pending, failed, running], workflows));
    fireEvent.click(await screen.findByTestId('sidebar-home'));

    await waitFor(() => {
      expect(screen.getByTestId('rail-start-ready-menu')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('rail-start-ready-menu'));
    fireEvent.click(await screen.findByTestId('rail-start-ready-recreate-failed-pending-and-running'));

    await waitFor(() => {
      expect(mock.api.startReady).toHaveBeenCalledWith({
        dryRun: true,
        recreateFailedPendingAndRunning: true,
      });
    });

    expect(await screen.findByTestId('start-ready-preview-dialog')).toBeInTheDocument();
    expect(screen.getByText('Start and recreate failed, pending, and running')).toBeInTheDocument();
    expect(screen.getByText('Pending workflows')).toBeInTheDocument();
    expect(screen.getByText('Running workflows')).toBeInTheDocument();
    expect(screen.getByText('Running tasks')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('start-ready-preview-confirm'));
    await waitFor(() => {
      expect(mock.api.startReady).toHaveBeenCalledWith({ recreateFailedPendingAndRunning: true });
    });
  });
});
