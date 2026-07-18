/**
 * Regression: Home workflow-node click must keep the floating mini DAG visible.
 *
 * Real Electron clicks can be retargeted from a workflow node to the React Flow
 * root in the same turn. That blank-pane click must not clear the workflow
 * selection that the node click just established.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, waitFor, fireEvent } from '@testing-library/react';
import { createMockInvoker, makeUITask, type MockInvoker } from './helpers/mock-invoker.js';
import type { WorkflowMeta } from '../types.js';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

const { App } = await import('../App.js');

const workflowTasks = [
  makeUITask({
    id: 'task-alpha',
    description: 'Alpha task',
    status: 'pending',
    workflowId: 'wf-retarget',
    command: 'echo alpha',
  }),
  makeUITask({
    id: 'task-beta',
    description: 'Beta task',
    status: 'pending',
    workflowId: 'wf-retarget',
    dependencies: ['task-alpha'],
    command: 'echo beta',
  }),
];

const workflows: WorkflowMeta[] = [
  { id: 'wf-retarget', name: 'Retarget Repro Workflow', status: 'running' },
];

describe('Home workflow mini DAG blank-click regression', () => {
  let mock: MockInvoker;

  beforeEach(() => {
    mock = createMockInvoker();
    mock.install();
  });

  afterEach(() => {
    mock.cleanup();
  });

  it('keeps the mini DAG when select is followed by a retargeted pane click in the same turn', async () => {
    render(<App />);
    act(() => mock.setTasks(workflowTasks, workflows));

    await waitFor(() => {
      expect(screen.getByTestId('workflow-node-wf-retarget')).toBeInTheDocument();
    });

    const node = screen.getByTestId('workflow-node-wf-retarget');
    const paneRoot = screen.getByTestId('workflow-graph-react-flow');

    act(() => {
      fireEvent.click(node);
      fireEvent.click(paneRoot);
    });

    await waitFor(() => {
      expect(screen.getByTestId('selected-workflow-mini-dag')).toHaveTextContent('Retarget Repro Workflow');
      expect(screen.getByTestId('workflow-inspector-title')).toHaveTextContent('Retarget Repro Workflow');
    });
  });
});
