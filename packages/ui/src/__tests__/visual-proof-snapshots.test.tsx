/**
 * Snapshot test: Visual proof states.
 *
 * Demoted from packages/app/e2e/visual-proof.spec.ts.
 * DOM snapshots catch structural regressions (missing elements, wrong text).
 * Pixel screenshots remain via scripts/ui-visual-proof.sh for PR reviews.
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

describe('Visual proof snapshots', () => {
  let mock: MockInvoker;

  beforeEach(() => {
    mock = createMockInvoker();
    mock.install();
  });

  afterEach(() => {
    mock.cleanup();
  });

  it('empty-state', () => {
    render(<App />);
    expect(screen.getByText('Load a plan to render workflow graph')).toBeInTheDocument();
    expect(screen.getByTestId('rail-open-file')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Home' })).toBeInTheDocument();
    expect(screen.queryByText('System Setup')).not.toBeInTheDocument();
  });

  it('workflow graph with selected mini-dag', async () => {
    const workflows: WorkflowMeta[] = [
      { id: 'wf-alpha', name: 'Alpha', status: 'running' },
      { id: 'wf-beta', name: 'Beta', status: 'failed' },
    ];
    const alpha = makeUITask({ id: 'task-alpha', description: 'First test task', status: 'running', workflowId: 'wf-alpha' });
    const beta = makeUITask({
      id: 'task-beta',
      description: 'Second test task',
      status: 'pending',
      workflowId: 'wf-beta',
      config: {
        workflowId: 'wf-beta',
        externalDependencies: [{ workflowId: 'wf-alpha', requiredStatus: 'completed' }],
      } as any,
    });

    render(<App />);
    act(() => mock.setTasks([alpha, beta], workflows));

    await waitFor(() => {
      expect(screen.getByText('Alpha')).toBeInTheDocument();
      expect(screen.getByText('Beta')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('workflow-node-wf-alpha'));
    await waitFor(() => {
      expect(screen.getByTestId('selected-workflow-mini-dag')).toHaveTextContent('Alpha task DAG');
      expect(screen.getByTestId('workflow-inspector-title')).toHaveTextContent('Alpha');
    });
  });

  it('workflow graph with active and detached lineage edges', async () => {
    const workflows: WorkflowMeta[] = [
      { id: 'wf-root', name: 'Root lineage', status: 'completed' },
      { id: 'wf-middle', name: 'Detached middle', status: 'running' },
      { id: 'wf-leaf', name: 'Active leaf', status: 'pending' },
    ];
    const root = makeUITask({
      id: 'task-root',
      description: 'Root workflow task',
      status: 'completed',
      workflowId: 'wf-root',
    });
    const middle = makeUITask({
      id: 'task-middle',
      description: 'Detached middle workflow task',
      status: 'running',
      workflowId: 'wf-middle',
      config: {
        workflowId: 'wf-middle',
        detachedExternalDependencies: [
          {
            workflowId: 'wf-root',
            requiredStatus: 'completed',
            gatePolicy: 'review_ready',
            detachedAt: '2026-06-02T08:57:38.000Z',
          },
        ],
      } as any,
    });
    const leaf = makeUITask({
      id: 'task-leaf',
      description: 'Leaf workflow with active dependency',
      status: 'pending',
      workflowId: 'wf-leaf',
      config: {
        workflowId: 'wf-leaf',
        externalDependencies: [
          { workflowId: 'wf-middle', requiredStatus: 'completed', gatePolicy: 'review_ready' },
        ],
      } as any,
    });

    render(<App />);
    act(() => mock.setTasks([root, middle, leaf], workflows));

    await waitFor(() => {
      expect(screen.getByText('Root lineage')).toBeInTheDocument();
      expect(screen.getByText('Detached middle')).toBeInTheDocument();
      expect(screen.getByText('Active leaf')).toBeInTheDocument();
    });

    const detachedEdge = screen.getByTestId('rf__edge-workflow:detached:wf-root->wf-middle');
    expect(detachedEdge).toHaveAttribute('data-kind', 'detached');
    expect(detachedEdge).toHaveAttribute('data-label', 'Detached');
    expect(detachedEdge).toHaveAttribute('data-stroke-dasharray', '6 5');
    expect(detachedEdge).toHaveAttribute(
      'aria-label',
      'Detached workflow dependency from wf-root to wf-middle',
    );
    expect(screen.queryByTestId('rf__edge-workflow:wf-root->wf-middle')).not.toBeInTheDocument();

    const activeEdge = screen.getByTestId('rf__edge-workflow:wf-middle->wf-leaf');
    expect(activeEdge).toHaveAttribute('data-kind', 'active');
    expect(activeEdge).not.toHaveAttribute('data-stroke-dasharray');
  });

  it('workflow and task context menus render', async () => {
    const workflows: WorkflowMeta[] = [{ id: 'wf-alpha', name: 'Alpha', status: 'running' }];
    const alpha = makeUITask({ id: 'task-alpha', description: 'First test task', status: 'running', workflowId: 'wf-alpha' });

    render(<App />);
    act(() => mock.setTasks([alpha], workflows));

    await waitFor(() => {
      expect(screen.getByTestId('workflow-node-wf-alpha')).toBeInTheDocument();
    });

    fireEvent.contextMenu(screen.getByTestId('workflow-node-wf-alpha'));
    await waitFor(() => {
      expect(screen.getByText('Open Workflow')).toBeInTheDocument();
      expect(screen.getByText('Retry Workflow')).toBeInTheDocument();
    });
  });
});
