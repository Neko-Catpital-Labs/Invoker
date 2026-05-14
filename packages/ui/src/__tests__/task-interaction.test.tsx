/**
 * Component test: Task interaction — clicking nodes, TaskPanel details.
 *
 * Demoted from packages/app/e2e/task-interaction.spec.ts.
 * Dropped: terminal-related assertions (Electron shell feature).
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
const alpha = makeUITask({ id: 'task-alpha', description: 'First test task', status: 'pending', workflowId: 'wf-a', command: 'echo hello-alpha' });
const beta = makeUITask({ id: 'task-beta', description: 'Second test task depending on alpha', status: 'pending', workflowId: 'wf-a', dependencies: ['task-alpha'], command: 'echo hello-beta' });

describe('Task interaction (component)', () => {
  let mock: MockInvoker;

  beforeEach(() => {
    mock = createMockInvoker();
    mock.install();
  });

  afterEach(() => {
    mock.cleanup();
  });

  it('selecting a workflow shows mini DAG and inspector content', async () => {
    render(<App />);
    act(() => mock.setTasks([alpha, beta], workflows));

    await waitFor(() => {
      expect(screen.getByTestId('workflow-node-wf-a')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('workflow-node-wf-a'));

    await waitFor(() => {
      expect(screen.getByTestId('selected-workflow-mini-dag')).toHaveTextContent('Workflow A task DAG');
      expect(screen.getByTestId('workflow-inspector-title')).toHaveTextContent('Workflow A');
    });
  });

  it('clicking a mini DAG task updates prompt details', async () => {
    render(<App />);
    act(() => mock.setTasks([alpha, beta], workflows));

    await waitFor(() => {
      expect(screen.getByTestId('workflow-node-wf-a')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('workflow-node-wf-a'));
    await waitFor(() => {
      expect(screen.getByTestId('rf__node-task-alpha')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('rf__node-task-alpha'));

    await waitFor(() => {
      expect(screen.getByText('echo hello-alpha')).toBeInTheDocument();
    });
  });

  it('switching between workflow and task selection replaces sidebar state', async () => {
    const failedTask = makeUITask({
      id: 'task-failed',
      description: 'Failed task',
      status: 'failed',
      workflowId: 'wf-a',
      command: 'exit 1',
      execution: { error: 'task failed' },
    });

    render(<App />);
    act(() => mock.setTasks([failedTask], workflows));

    await waitFor(() => {
      expect(screen.getByTestId('workflow-node-wf-a')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('workflow-node-wf-a'));
    await waitFor(() => {
      expect(screen.getByTestId('workflow-inspector-status-label')).toHaveTextContent('failed');
      expect(screen.queryByTestId('workflow-inspector-prompt-input')).not.toBeInTheDocument();
    });

    fireEvent.click(await screen.findByTestId('rf__node-task-failed'));
    await waitFor(() => {
      expect(screen.getByTestId('workflow-inspector-status-label')).toHaveTextContent('failed');
    });

    fireEvent.click(screen.getByTestId('workflow-node-wf-a'));
    await waitFor(() => {
      expect(screen.getByTestId('workflow-inspector-status-label')).toHaveTextContent('failed');
      expect(screen.queryByTestId('workflow-inspector-prompt-input')).not.toBeInTheDocument();
    });
  });

  it('clicking workflow graph background dismisses the selected mini DAG', async () => {
    render(<App />);
    act(() => mock.setTasks([alpha, beta], workflows));

    await waitFor(() => {
      expect(screen.getByTestId('workflow-node-wf-a')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('workflow-node-wf-a'));
    await waitFor(() => {
      expect(screen.getByTestId('selected-workflow-mini-dag')).toHaveTextContent('Workflow A task DAG');
    });

    fireEvent.click(screen.getByTestId('workflow-graph-scroll'));

    await waitFor(() => {
      expect(screen.queryByTestId('selected-workflow-mini-dag')).not.toBeInTheDocument();
    });
  });
});
