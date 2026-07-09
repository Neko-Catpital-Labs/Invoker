import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import * as ReactFlowModule from '@xyflow/react';
import { TaskDAG } from '../components/TaskDAG.js';
import { makeUITask } from './helpers/mock-invoker.js';
import type { TaskState, WorkflowMeta } from '../types.js';

vi.mock('@xyflow/react', async () => {
  // Vitest hoists mock factories before static helper imports initialize.
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

const fitViewMock = (ReactFlowModule as unknown as { __fitViewMock: Mock }).__fitViewMock;
const setCenterMock = (ReactFlowModule as unknown as { __setCenterMock: Mock }).__setCenterMock;
const getZoomMock = (ReactFlowModule as unknown as { __getZoomMock: Mock }).__getZoomMock;

describe('TaskDAG status filters', () => {
  beforeEach(() => {
    fitViewMock.mockClear();
    setCenterMock.mockClear();
    getZoomMock.mockReset();
    getZoomMock.mockReturnValue(1);
  });

  it('keeps queue-assigning tasks visible under the assigning filter', async () => {
    const assigningTask = makeUITask({
      id: 'wf-1/assigning-task',
      workflowId: 'wf-1',
      status: 'pending',
      description: 'assigning task',
      execution: { phase: 'launching', selectedAttemptId: 'wf-1/assigning-task-a1' },
    });
    const pendingTask = makeUITask({
      id: 'wf-1/pending-task',
      workflowId: 'wf-1',
      status: 'pending',
      description: 'pending task',
      dependencies: ['wf-1/assigning-task'],
    });
    const tasks = new Map<string, TaskState>([
      [assigningTask.id, assigningTask],
      [pendingTask.id, pendingTask],
    ]);
    const workflows = new Map<string, WorkflowMeta>([
      ['wf-1', { id: 'wf-1', name: 'wf-1', status: 'running' }],
    ]);

    render(
      <TaskDAG
        tasks={tasks}
        workflows={workflows}
        statusFilters={new Set(['assigning'])}
        runningTaskIds={new Set([assigningTask.id])}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId(`rf__node-${assigningTask.id}`)).toBeInTheDocument();
      expect(screen.getByTestId(`rf__node-${pendingTask.id}`)).toBeInTheDocument();
    });

    expect(screen.getByText('ASSIGNING')).toBeInTheDocument();

    const assigningNode = screen.getByTestId(`rf__node-${assigningTask.id}`).firstElementChild as HTMLElement;
    const pendingNode = screen.getByTestId(`rf__node-${pendingTask.id}`).firstElementChild as HTMLElement;

    expect(assigningNode.className).not.toContain('opacity-20');
    expect(pendingNode.className).toContain('opacity-20');
  });
});
