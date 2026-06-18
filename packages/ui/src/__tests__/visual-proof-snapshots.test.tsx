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

  it('workflow graph detached-lineage proof shows active and detached edges distinctly', async () => {
    const workflows: WorkflowMeta[] = [
      { id: 'wf-root', name: 'Root workflow', status: 'review_ready' },
      {
        id: 'wf-active-child',
        name: 'Active downstream',
        status: 'running',
        externalDependencies: [
          {
            workflowId: 'wf-root',
            taskId: '__merge__wf-root',
            requiredStatus: 'completed',
            gatePolicy: 'review_ready',
          },
        ],
      },
      {
        id: 'wf-detached-child',
        name: 'Detached downstream',
        status: 'running',
        detachedExternalDependencies: [
          {
            workflowId: 'wf-root',
            taskId: '__merge__wf-root',
            requiredStatus: 'completed',
            gatePolicy: 'review_ready',
            detachedAt: '2026-01-02T00:00:00.000Z',
          },
        ],
      },
    ];
    const tasks = [
      makeUITask({ id: 'task-root', description: 'Root task', status: 'completed', workflowId: 'wf-root' }),
      makeUITask({
        id: 'task-active-child',
        description: 'Active downstream task',
        status: 'running',
        workflowId: 'wf-active-child',
      }),
      makeUITask({
        id: 'task-detached-child',
        description: 'Detached downstream task',
        status: 'running',
        workflowId: 'wf-detached-child',
      }),
    ];

    render(<App />);
    act(() => mock.setTasks(tasks, workflows));

    await waitFor(() => {
      expect(screen.getByText('Root workflow')).toBeInTheDocument();
      expect(screen.getByText('Active downstream')).toBeInTheDocument();
      expect(screen.getByText('Detached downstream')).toBeInTheDocument();
    });

    const activeEdge = screen.getByTestId('rf__edge-workflow:active:wf-root->wf-active-child');
    expect(activeEdge).toHaveAccessibleName('Active workflow dependency');
    expect(activeEdge).toHaveAttribute('data-kind', 'active');
    expect(activeEdge).toHaveAttribute('data-stroke-dasharray', '');

    const detachedEdge = screen.getByTestId('rf__edge-workflow:detached:wf-root->wf-detached-child');
    expect(detachedEdge).toHaveAccessibleName('Detached workflow lineage');
    expect(detachedEdge).toHaveAttribute('data-kind', 'detached');
    expect(detachedEdge).toHaveAttribute('data-stroke-dasharray', '5 6');

    const detachedBadge = screen.getByTestId('workflow-node-wf-detached-child-detached-lineage');
    expect(detachedBadge).toHaveTextContent('Detached');
    expect(detachedBadge).toHaveAttribute('title', 'Detached from 1 upstream workflow');
    expect(screen.queryByTestId('workflow-node-wf-active-child-detached-lineage')).not.toBeInTheDocument();
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
