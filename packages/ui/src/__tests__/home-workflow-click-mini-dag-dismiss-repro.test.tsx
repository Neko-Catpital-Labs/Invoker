/**
 * Regression: Home workflow-node click must keep the floating mini-DAG visible.
 *
 * Real Electron clicks go through WorkflowGraph's deferred pane-pan pointer
 * capture on the graph root. The subsequent click is retargeted off the node,
 * so workflow-graph-surface's dismiss handler clears the selection in the same
 * turn. Unit tests that only fireEvent.click(node) never hit that path.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, act, waitFor, fireEvent } from '@testing-library/react';
import { vi } from 'vitest';
import { createMockInvoker, makeUITask, type MockInvoker } from './helpers/mock-invoker.js';
import type { WorkflowMeta } from '../types.js';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

const { App } = await import('../App.js');

const workflows: WorkflowMeta[] = [{ id: 'wf-a', name: 'Workflow A', status: 'running' }];

const alpha = makeUITask({
  id: 'task-alpha',
  description: 'First test task',
  status: 'pending',
  workflowId: 'wf-a',
  command: 'echo hello-alpha',
});

const beta = makeUITask({
  id: 'task-beta',
  description: 'Second test task',
  status: 'pending',
  workflowId: 'wf-a',
  dependencies: ['task-alpha'],
  command: 'echo hello-beta',
});

describe('Home workflow graph mini DAG click dismissal repro', () => {
  let mock: MockInvoker;

  beforeEach(() => {
    mock = createMockInvoker();
    mock.install();
  });

  afterEach(() => {
    mock.cleanup();
  });

  async function selectWorkflowA() {
    render(<App />);
    act(() => mock.setTasks([alpha, beta], workflows));

    await waitFor(() => {
      expect(screen.getByTestId('workflow-node-wf-a')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('rf__node-wf-a'));

    await waitFor(() => {
      expect(screen.getByTestId('selected-workflow-mini-dag')).toHaveTextContent('Workflow A');
      expect(screen.getByTestId('workflow-inspector-title')).toHaveTextContent('Workflow A');
    });
  }

  it('keeps the selected mini DAG after a blank graph surface click', async () => {
    await selectWorkflowA();

    fireEvent.click(screen.getByTestId('workflow-graph-surface'));

    await waitFor(() => {
      expect(screen.getByTestId('selected-workflow-mini-dag')).toHaveTextContent('Workflow A');
      expect(screen.getByTestId('workflow-inspector-title')).toHaveTextContent('Workflow A');
    });
  });

  it('keeps the selected mini DAG after a retargeted React Flow pane click', async () => {
    await selectWorkflowA();

    fireEvent.click(screen.getByTestId('workflow-graph-react-flow'), {
      clientX: 24,
      clientY: 24,
    });

    await waitFor(() => {
      expect(screen.getByTestId('selected-workflow-mini-dag')).toHaveTextContent('Workflow A');
      expect(screen.getByTestId('workflow-inspector-title')).toHaveTextContent('Workflow A');
    });
  });
});
