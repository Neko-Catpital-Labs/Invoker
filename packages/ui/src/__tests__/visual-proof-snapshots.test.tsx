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

  it('workflow graph with detached lineage visual state', async () => {
    const workflows: WorkflowMeta[] = [
      { id: 'wf-root', name: 'Root Stack', status: 'review_ready' },
      {
        id: 'wf-active',
        name: 'Active Downstream',
        status: 'running',
        externalDependencies: [
          { workflowId: 'wf-root', requiredStatus: 'completed', gatePolicy: 'review_ready' },
        ],
      },
      {
        id: 'wf-detached',
        name: 'Detached Downstream',
        status: 'pending',
        externalDependencyChanges: [
          {
            before: {
              workflowId: 'wf-root',
              taskId: '__merge__',
              requiredStatus: 'completed',
              gatePolicy: 'review_ready',
            },
            changedAt: '2026-06-03T12:00:00.000Z',
          },
        ],
        detachedExternalDependencies: [
          {
            workflowId: 'wf-root',
            taskId: '__merge__',
            requiredStatus: 'completed',
            gatePolicy: 'review_ready',
            detachedAt: '2026-06-03T12:00:00.000Z',
          },
        ],
      },
    ];
    const tasks = workflows.map((workflow) =>
      makeUITask({
        id: `${workflow.id}-task`,
        description: `${workflow.name} task`,
        status: workflow.status === 'review_ready' ? 'completed' : 'pending',
        workflowId: workflow.id,
      }),
    );

    render(<App />);
    act(() => mock.setTasks(tasks, workflows));

    await waitFor(() => {
      expect(screen.getByText('Root Stack')).toBeInTheDocument();
      expect(screen.getByText('Active Downstream')).toBeInTheDocument();
      expect(screen.getByText('Detached Downstream')).toBeInTheDocument();
    });

    const activeEdge = screen.getByTestId('rf__edge-workflow:active:wf-root->wf-active');
    expect(activeEdge).toHaveAttribute('data-label', 'Active workflow dependency');
    expect(activeEdge).toHaveAttribute('data-stroke-width', '2');
    expect(activeEdge).not.toHaveAttribute('data-stroke-dasharray');

    const detachedEdge = screen.getByTestId('rf__edge-workflow:detached:wf-root->wf-detached');
    expect(detachedEdge).toHaveAttribute('data-label', 'Detached workflow lineage');
    expect(detachedEdge).toHaveAttribute('data-stroke-dasharray', '4 7');
    expect(detachedEdge).toHaveAttribute('data-stroke-width', '1.5');

    const detachedBadge = screen.getByLabelText('Detached lineage');
    expect(detachedBadge).toHaveTextContent('Detached');
    expect(screen.getByTestId('workflow-node-wf-detached')).toContainElement(detachedBadge);
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
