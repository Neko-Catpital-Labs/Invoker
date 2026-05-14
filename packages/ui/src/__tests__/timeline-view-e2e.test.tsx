/**
 * Component test: Timeline view rendering and interaction.
 *
 * Demoted from packages/app/e2e/timeline-view.spec.ts.
 * Tests switching to timeline view, bar rendering, elapsed time, and task selection.
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

const alpha = makeUITask({
  id: 'task-alpha',
  description: 'First test task',
  status: 'pending',
  workflowId: 'wf-timeline',
  command: 'echo hello-alpha',
});

const beta = makeUITask({
  id: 'task-beta',
  description: 'Second test task',
  status: 'pending',
  workflowId: 'wf-timeline',
  dependencies: ['task-alpha'],
  command: 'echo hello-beta',
});
const workflows: WorkflowMeta[] = [{ id: 'wf-timeline', name: 'Timeline WF', status: 'running' }];

describe('Timeline view (component)', () => {
  let mock: MockInvoker;

  beforeEach(() => {
    mock = createMockInvoker();
    mock.install();
  });

  afterEach(() => {
    mock.cleanup();
  });

  it('clicking Timeline button shows the timeline view', async () => {
    render(<App />);
    act(() => mock.setTasks([alpha, beta], workflows));

    fireEvent.click(screen.getByTestId('rail-timeline'));

    await waitFor(() => {
      expect(screen.getByTestId('timeline-view')).toBeInTheDocument();
    });
  });

  it('timeline shows task bars after loading tasks', async () => {
    render(<App />);
    act(() => mock.setTasks([alpha, beta], workflows));

    fireEvent.click(screen.getByTestId('rail-timeline'));

    await waitFor(() => {
      expect(screen.getByTestId('timeline-bar-task-alpha')).toBeInTheDocument();
      expect(screen.getByTestId('timeline-bar-task-beta')).toBeInTheDocument();
    });
  });

  it('completed task shows elapsed time', async () => {
    const now = Date.now();
    const completedAlpha = makeUITask({
      id: 'task-alpha',
      description: 'First test task',
      status: 'completed',
      workflowId: 'wf-timeline',
      command: 'echo hello-alpha',
      execution: {
        startedAt: new Date(now - 5000),
        completedAt: new Date(now),
      },
    } as any);

    render(<App />);
    act(() => mock.setTasks([completedAlpha, beta], workflows));

    fireEvent.click(screen.getByTestId('rail-timeline'));

    await waitFor(() => {
      const bar = screen.getByTestId('timeline-bar-task-alpha');
      expect(bar).toHaveTextContent(/\d+s/);
    });
  });

  it('switching back to Home workflow graph works', async () => {
    render(<App />);
    act(() => mock.setTasks([alpha, beta], workflows));

    fireEvent.click(screen.getByTestId('rail-timeline'));

    await waitFor(() => {
      expect(screen.getByTestId('timeline-bar-task-alpha')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('rail-home'));

    await waitFor(() => {
      expect(screen.queryByTestId('timeline-view')).not.toBeInTheDocument();
      expect(screen.getByTestId('workflow-node-wf-timeline')).toBeInTheDocument();
    });
  });
});
