/**
 * Component test: Plan loading and DAG rendering.
 *
 * Demoted from packages/app/e2e/plan-loading.spec.ts.
 * Tests that loading tasks renders nodes in the DAG mock.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import { vi } from 'vitest';
import { createMockInvoker, makeUITask, type MockInvoker } from './helpers/mock-invoker.js';
import type { WorkflowMeta } from '../types.js';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

const { App } = await import('../App.js');

const alpha = makeUITask({
  id: 'task-alpha',
  description: 'First test task',
  status: 'pending',
  workflowId: 'wf-load',
  command: 'echo hello-alpha',
});

const beta = makeUITask({
  id: 'task-beta',
  description: 'Second test task depending on alpha',
  status: 'pending',
  workflowId: 'wf-load',
  dependencies: ['task-alpha'],
  command: 'echo hello-beta',
});
const workflows: WorkflowMeta[] = [
  { id: 'wf-load', name: 'Loaded Workflow', status: 'running' },
];

describe('Plan loading (component)', () => {
  let mock: MockInvoker;

  beforeEach(() => {
    mock = createMockInvoker();
    mock.install();
  });

  afterEach(() => {
    mock.cleanup();
  });

  it('renders workflow graph nodes after setTasks', async () => {
    render(<App />);
    act(() => mock.setTasks([alpha, beta], workflows));

    await waitFor(() => {
      expect(screen.getByTestId('workflow-node-wf-load')).toBeInTheDocument();
    });
  });

  it('tasks are in pending state', () => {
    expect(alpha.status).toBe('pending');
    expect(beta.status).toBe('pending');
  });

  it('empty state disappears after tasks are loaded', async () => {
    render(<App />);
    expect(screen.getByTestId('workflow-empty-state')).toBeInTheDocument();

    act(() => mock.setTasks([alpha, beta], workflows));

    await waitFor(() => {
      expect(screen.queryByTestId('workflow-empty-state')).not.toBeInTheDocument();
    });
  });

  it('selecting workflow renders mini DAG for its tasks', async () => {
    render(<App />);
    act(() => mock.setTasks([alpha, beta], workflows));

    await waitFor(() => {
      expect(screen.getByTestId('workflow-node-wf-load')).toBeInTheDocument();
    });
    screen.getByTestId('workflow-node-wf-load').click();
    await waitFor(() => expect(screen.getByTestId('selected-workflow-mini-dag')).toHaveTextContent('Loaded Workflow task DAG'));
  });
});
