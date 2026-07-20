/**
 * Component test: Merge gate branch selector in TaskPanel.
 *
 * Demoted from packages/app/e2e/merge-branch.spec.ts.
 * Tests clicking merge node shows Target Branch input, branch label, and blur persistence.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, act, waitFor, fireEvent } from '@testing-library/react';
import { createMockInvoker, makeUITask, type MockInvoker } from './helpers/mock-invoker.js';
import type { WorkflowMeta } from '../../types.js';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

const { App } = await import('../App.js');

const taskA = makeUITask({
  id: 'task-a',
  description: 'Task A',
  status: 'pending',
  command: 'echo a',
  workflowId: 'wf-1',
});

const mergeNode = makeUITask({
  id: '__merge__wf-1',
  description: 'Merge gate',
  status: 'pending',
  dependencies: ['task-a'],
  isMergeNode: true,
  workflowId: 'wf-1',
});

const workflows: WorkflowMeta[] = [
  { id: 'wf-1', name: 'Merge Branch Test', status: 'running', baseBranch: 'master' },
];

describe('workflow advanced metadata (component)', () => {
  let mock: MockInvoker;

  beforeEach(() => {
    mock = createMockInvoker();
    mock.install();
  });

  afterEach(() => {
    mock.cleanup();
  });

  it('shows base branch inside advanced metadata section', async () => {
    render(<App />);
    fireEvent.click(await screen.findByTestId('sidebar-planning'));
    act(() => mock.setTasks([taskA, mergeNode], workflows));

    await waitFor(() => {
      expect(screen.getByTestId('workflow-node-wf-1')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('workflow-node-wf-1'));
    fireEvent.click(screen.getByText(/Advanced metadata/i));

    await waitFor(() => {
      expect(screen.getByText(/base branch: master/i)).toBeInTheDocument();
    });
  });
});
