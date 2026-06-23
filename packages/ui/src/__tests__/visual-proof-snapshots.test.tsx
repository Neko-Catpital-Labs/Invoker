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

  it('detached-lineage graph state — detached marker distinct from active dependency edge', async () => {
    // Deterministic fixture: one shared upstream workflow with two downstreams —
    // one still actively depending on it, one explicitly detached. Proves the
    // detached lineage renders as a distinct dashed edge + badge, not as an
    // active solid edge.
    const workflows: WorkflowMeta[] = [
      { id: 'wf-up', name: 'Upstream', status: 'completed' },
      {
        id: 'wf-active',
        name: 'Active downstream',
        status: 'running',
        externalDependencies: [{ workflowId: 'wf-up', requiredStatus: 'completed' }],
      },
      {
        id: 'wf-detached',
        name: 'Detached downstream',
        status: 'running',
        detachedExternalDependencies: [
          {
            workflowId: 'wf-up',
            taskId: '__merge__',
            requiredStatus: 'completed',
            gatePolicy: 'completed',
            detachedAt: '2026-01-02T00:00:00.000Z',
          },
        ],
      },
    ];
    const upstream = makeUITask({ id: 'task-up', description: 'Upstream task', status: 'completed', workflowId: 'wf-up' });
    const active = makeUITask({ id: 'task-active', description: 'Active downstream task', status: 'running', workflowId: 'wf-active' });
    const detached = makeUITask({ id: 'task-detached', description: 'Detached downstream task', status: 'running', workflowId: 'wf-detached' });

    render(<App />);
    act(() => mock.setTasks([upstream, active, detached], workflows));

    await waitFor(() => {
      expect(screen.getByTestId('workflow-node-wf-active')).toBeInTheDocument();
      expect(screen.getByTestId('workflow-node-wf-detached')).toBeInTheDocument();
    });

    // Active dependency: solid edge (no dash), distinct accessible name.
    const activeEdge = screen.getByTestId('rf__edge-workflow:active:wf-up->wf-active');
    expect(activeEdge).toHaveAttribute('data-kind', 'active');
    expect(activeEdge).toHaveAttribute('data-stroke-dasharray', '');
    expect(activeEdge).toHaveAccessibleName('Active workflow dependency');

    // Detached lineage: dashed edge, distinct kind + accessible name.
    const detachedEdge = screen.getByTestId('rf__edge-workflow:detached:wf-up->wf-detached');
    expect(detachedEdge).toHaveAttribute('data-kind', 'detached');
    expect(detachedEdge).toHaveAttribute('data-stroke-dasharray', '5 6');
    expect(detachedEdge).toHaveAccessibleName('Detached workflow lineage');

    // The detached downstream carries the "Detached" badge; the active one does not.
    const badge = screen.getByTestId('workflow-node-wf-detached-detached-lineage');
    expect(badge).toHaveTextContent('Detached');
    expect(badge).toHaveAttribute('title', 'Detached from 1 upstream workflow');
    expect(screen.queryByTestId('workflow-node-wf-active-detached-lineage')).not.toBeInTheDocument();
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
