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

  it('workflow graph detached lineage visual proof', async () => {
    const workflows: WorkflowMeta[] = [
      { id: 'wf-upstream', name: 'Upstream', status: 'review_ready' },
      {
        id: 'wf-active-child',
        name: 'Active child',
        status: 'running',
        externalDependencies: [{ workflowId: 'wf-upstream', requiredStatus: 'completed' }],
      },
      {
        id: 'wf-detached-child',
        name: 'Detached child',
        status: 'running',
        externalDependencyChanges: [
          {
            before: { workflowId: 'wf-upstream', requiredStatus: 'completed', gatePolicy: 'review_ready' },
            changedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      },
    ];
    const upstream = makeUITask({
      id: 'task-upstream',
      description: 'Upstream merge gate',
      status: 'review_ready',
      workflowId: 'wf-upstream',
    });
    const activeChild = makeUITask({
      id: 'task-active-child',
      description: 'Still actively depends on upstream',
      status: 'running',
      workflowId: 'wf-active-child',
    });
    const detachedChild = makeUITask({
      id: 'task-detached-child',
      description: 'Detached downstream merge gate',
      status: 'running',
      workflowId: 'wf-detached-child',
      config: {
        workflowId: 'wf-detached-child',
        isMergeNode: true,
        detachedExternalDependencies: [
          {
            workflowId: 'wf-upstream',
            requiredStatus: 'completed',
            gatePolicy: 'review_ready',
            detachedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      } as any,
    });

    render(<App />);
    act(() => mock.setTasks([upstream, activeChild, detachedChild], workflows));

    await waitFor(() => {
      expect(screen.getByTestId('workflow-node-wf-upstream')).toBeInTheDocument();
      expect(screen.getByTestId('workflow-node-wf-active-child')).toBeInTheDocument();
      expect(screen.getByTestId('workflow-node-wf-detached-child')).toBeInTheDocument();
    });

    const activeEdge = screen.getByTestId('rf__edge-workflow:active:wf-upstream->wf-active-child');
    expect(activeEdge).toHaveAttribute('data-kind', 'active');
    expect(activeEdge).toHaveAttribute('aria-label', 'Active workflow dependency');
    expect(activeEdge.getAttribute('style') ?? '').not.toContain('stroke-dasharray');

    const detachedEdge = screen.getByTestId('rf__edge-workflow:detached:wf-upstream->wf-detached-child');
    expect(detachedEdge).toHaveAttribute('data-kind', 'detached');
    expect(detachedEdge).toHaveAttribute('aria-label', 'Detached workflow dependency');
    expect(detachedEdge.getAttribute('style') ?? '').toContain('stroke-dasharray: 6 6');
    expect(screen.queryByTestId('rf__edge-workflow:active:wf-upstream->wf-detached-child')).not.toBeInTheDocument();

    const detachedBadge = screen.getByTestId('workflow-node-wf-detached-child-detached-badge');
    expect(detachedBadge).toHaveTextContent('Detached');
    expect(detachedBadge).toHaveAttribute('title', 'Detached from 1 upstream workflow');
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
