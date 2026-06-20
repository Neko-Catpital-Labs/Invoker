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

  it('workflow graph shows active edges and detached lineage distinctly', async () => {
    const workflows: WorkflowMeta[] = [
      { id: 'wf-alpha', name: 'Alpha', status: 'review_ready' },
      {
        id: 'wf-beta',
        name: 'Beta Detached',
        status: 'completed',
        detachedExternalDependencies: [
          {
            workflowId: 'wf-alpha',
            requiredStatus: 'completed',
            gatePolicy: 'completed',
            detachedAt: '2026-01-02T00:00:00.000Z',
          },
        ],
      },
      {
        id: 'wf-gamma',
        name: 'Gamma Active',
        status: 'running',
        externalDependencies: [
          {
            workflowId: 'wf-alpha',
            requiredStatus: 'completed',
            gatePolicy: 'completed',
          },
        ],
      },
    ];
    const alpha = makeUITask({ id: 'task-alpha', description: 'Root stack task', status: 'review_ready', workflowId: 'wf-alpha' });
    const beta = makeUITask({ id: 'task-beta', description: 'Detached downstream task', status: 'completed', workflowId: 'wf-beta' });
    const gamma = makeUITask({ id: 'task-gamma', description: 'Active downstream task', status: 'running', workflowId: 'wf-gamma' });

    render(<App />);
    act(() => mock.setTasks([alpha, beta, gamma], workflows));

    await waitFor(() => {
      expect(screen.getByTestId('workflow-node-wf-alpha')).toHaveTextContent('Alpha');
      expect(screen.getByTestId('workflow-node-wf-beta')).toHaveTextContent('Beta Detached');
      expect(screen.getByTestId('workflow-node-wf-gamma')).toHaveTextContent('Gamma Active');
    });

    const activeEdge = screen.getByTestId('rf__edge-workflow:active:wf-alpha->wf-gamma');
    expect(activeEdge).toHaveAccessibleName('Active workflow dependency');
    expect(activeEdge).toHaveAttribute('data-stroke-dasharray', '');

    const detachedEdge = screen.getByTestId('rf__edge-workflow:detached:wf-alpha->wf-beta');
    expect(detachedEdge).toHaveAccessibleName('Detached workflow lineage');
    expect(detachedEdge).toHaveAttribute('data-stroke-dasharray', '5 6');
    expect(screen.getByTestId('workflow-node-wf-beta-detached-lineage')).toHaveTextContent('Detached');
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
