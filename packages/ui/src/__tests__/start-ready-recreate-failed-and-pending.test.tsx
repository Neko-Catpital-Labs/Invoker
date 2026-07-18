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
    pendingWorkflowIds: ['wf-1', 'wf-3'],
    skipped: {
      awaitingApproval: 0,
      reviewReady: 0,
      blocked: 0,
      failedTasks: 1,
      pendingTasks: 2,
    },
  },
  started: [],
  recreatedWorkflowIds: [],
  dryRun: true,
};

describe('Start and recreate failed and pending', () => {
  let mock: MockInvoker;

  beforeEach(() => {
    mock = createMockInvoker();
    mock.api.startReady = vi.fn(async (request) => {
      if (request?.dryRun) return previewResult;
      return { ...previewResult, dryRun: false, recreatedWorkflowIds: ['wf-1', 'wf-2', 'wf-3'] };
    });
    mock.install();
  });

  afterEach(() => {
    mock.cleanup();
  });

  it('opens the preview dialog for failed-and-pending and confirms with the broader flag', async () => {
    const workflows: WorkflowMeta[] = [
      { id: 'wf-1', name: 'Alpha', status: 'running' },
      { id: 'wf-2', name: 'Beta', status: 'failed' },
    ];
    const pending = makeUITask({ id: 'wf-1/ready', description: 'Ready', status: 'pending', workflowId: 'wf-1' });
    const failed = makeUITask({ id: 'wf-2/failed', description: 'Failed', status: 'failed', workflowId: 'wf-2' });

    render(<App />);
    act(() => mock.setTasks([pending, failed], workflows));
    fireEvent.click(await screen.findByTestId('sidebar-home'));

    await waitFor(() => {
      expect(screen.getByTestId('rail-start-ready-menu')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('rail-start-ready-menu'));
    fireEvent.click(await screen.findByTestId('rail-start-ready-recreate-failed-and-pending'));

    await waitFor(() => {
      expect(mock.api.startReady).toHaveBeenCalledWith({
        dryRun: true,
        recreateFailedAndPending: true,
      });
    });

    expect(await screen.findByTestId('start-ready-preview-dialog')).toBeInTheDocument();
    expect(screen.getByText('Start and recreate failed and pending')).toBeInTheDocument();
    expect(screen.getByText('Pending workflows')).toBeInTheDocument();
    expect(screen.getByText('Pending tasks')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('start-ready-preview-confirm'));
    await waitFor(() => {
      expect(mock.api.startReady).toHaveBeenCalledWith({ recreateFailedAndPending: true });
    });
  });
});
