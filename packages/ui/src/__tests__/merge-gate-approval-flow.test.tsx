/**
 * Integration test: Merge gate approval flow through full <App />.
 *
 * Verifies the chain: select MergeGateNode → TaskPanel → ApprovalModal
 * with context-specific labels based on workflow onFinish.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, act, waitFor, fireEvent } from '@testing-library/react';
import { createMockInvoker, makeUITask, type MockInvoker } from './helpers/mock-invoker.js';
import type { WorkflowMeta } from '../types.js';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

const { App } = await import('../App.js');

const taskA = makeUITask({
  id: 'task-a1',
  description: 'Regular task A',
  status: 'completed',
  workflowId: 'wf-merge',
  command: 'echo hello',
});

const gateA = makeUITask({
  id: 'gate-a',
  description: 'Merge gate for test plan',
  status: 'awaiting_approval',
  workflowId: 'wf-merge',
  isMergeNode: true,
  dependencies: ['task-a1'],
});

const wfA: WorkflowMeta = {
  id: 'wf-merge',
  name: 'Merge Workflow',
  status: 'running',
  baseBranch: 'main',
  onFinish: 'merge',
  mergeMode: 'manual',
};

describe('Merge gate approval flow (integration)', () => {
  let mock: MockInvoker;

  beforeEach(() => {
    mock = createMockInvoker();
    mock.install();
  });

  afterEach(() => {
    mock.cleanup();
  });

  it('workflow context menu retries workflow', async () => {
    render(<App />);
    act(() => mock.setTasks([taskA, gateA], [wfA]));

    await waitFor(() => {
      expect(screen.getByTestId('workflow-node-wf-merge')).toBeInTheDocument();
    });

    fireEvent.contextMenu(screen.getByTestId('workflow-node-wf-merge'));
    await waitFor(() => {
      expect(screen.getByText('Retry Workflow')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('Retry Workflow'));
    await waitFor(() => expect(mock.api.retryWorkflow).toHaveBeenCalledWith('wf-merge'));
  });

  it('opens the fix approval modal from the selected task inspector', async () => {
    const fixedTask = makeUITask({
      id: 'fix-task',
      description: 'Fix failing test',
      status: 'awaiting_approval',
      workflowId: 'wf-merge',
      prompt: 'Fix the failing test',
      execution: { pendingFixError: 'test failed' },
    });

    render(<App />);
    act(() => mock.setTasks([fixedTask], [wfA]));

    await waitFor(() => {
      expect(screen.getByTestId('workflow-node-wf-merge')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('workflow-node-wf-merge'));
    await waitFor(() => {
      expect(screen.getByTestId('rf__node-fix-task')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('rf__node-fix-task'));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Approve Fix' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Approve Fix' }));
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Approve AI Fix' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getAllByRole('button', { name: 'Approve Fix' }).at(-1)!);
    await waitFor(() => expect(mock.api.approve).toHaveBeenCalledWith('fix-task'));
  });
});
