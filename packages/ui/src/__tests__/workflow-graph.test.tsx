import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { WorkflowGraph } from '../components/WorkflowGraph.js';
import type { TaskState, WorkflowMeta, WorkflowStatus } from '../types.js';
import * as ReactFlowModule from '@xyflow/react';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

const fitViewMock = (ReactFlowModule as unknown as { __fitViewMock: Mock }).__fitViewMock;

function wf(id: string, status: WorkflowStatus): WorkflowMeta {
  return { id, name: id, status };
}

function task(id: string, workflowId: string): TaskState {
  return {
    id,
    description: id,
    status: 'pending',
    dependencies: [],
    config: { workflowId },
    execution: {},
    taskStateVersion: 1,
  };
}

describe('WorkflowGraph', () => {
  beforeEach(() => {
    fitViewMock.mockClear();
  });

  it('calls selection and context menu handlers', () => {
    const onSelectWorkflow = vi.fn();
    const onWorkflowContextMenu = vi.fn();
    const workflows = new Map([
      ['wf-a', wf('wf-a', 'running')],
    ]);
    const tasks = new Map([
      ['t1', task('t1', 'wf-a')],
    ]);

    render(
      <WorkflowGraph
        tasks={tasks}
        workflows={workflows}
        selectedWorkflowId={null}
        statusFilters={new Set()}
        onSelectWorkflow={onSelectWorkflow}
        onWorkflowContextMenu={onWorkflowContextMenu}
      />,
    );

    const node = screen.getByTestId('workflow-node-wf-a');
    fireEvent.click(node);
    expect(onSelectWorkflow).toHaveBeenCalledWith('wf-a');

    fireEvent.contextMenu(node);
    expect(onWorkflowContextMenu).toHaveBeenCalledTimes(1);
    expect(onWorkflowContextMenu.mock.calls[0][1]).toBe('wf-a');
  });

  it('renders filtered workflows dimmed', () => {
    const workflows = new Map([
      ['wf-a', wf('wf-a', 'running')],
    ]);
    const tasks = new Map([
      ['t1', task('t1', 'wf-a')],
    ]);

    render(
      <WorkflowGraph
        tasks={tasks}
        workflows={workflows}
        selectedWorkflowId={null}
        statusFilters={new Set<WorkflowStatus>(['failed'])}
        onSelectWorkflow={() => {}}
        onWorkflowContextMenu={() => {}}
      />,
    );

    const node = screen.getByTestId('workflow-node-wf-a');
    expect(node).toBeInTheDocument();
    expect(node).toHaveClass('opacity-35');
  });

  it('renders the React Flow wrapper for non-empty workflow graphs', () => {
    const workflows = new Map([
      ['wf-a', wf('wf-a', 'running')],
    ]);
    const tasks = new Map([
      ['t1', task('t1', 'wf-a')],
    ]);

    render(
      <WorkflowGraph
        tasks={tasks}
        workflows={workflows}
        selectedWorkflowId={null}
        statusFilters={new Set()}
        onSelectWorkflow={() => {}}
        onWorkflowContextMenu={() => {}}
      />,
    );

    expect(screen.getByTestId('workflow-graph-react-flow')).toBeInTheDocument();
    expect(screen.getByTestId('mock-react-flow')).toBeInTheDocument();
  });

  it('does not re-fit after topology changes once initial fit is done', async () => {
    const workflows = new Map([
      ['wf-a', wf('wf-a', 'running')],
    ]);
    const tasks = new Map([
      ['t1', task('t1', 'wf-a')],
    ]);

    const { rerender } = render(
      <WorkflowGraph
        tasks={tasks}
        workflows={workflows}
        selectedWorkflowId={null}
        statusFilters={new Set()}
        onSelectWorkflow={() => {}}
        onWorkflowContextMenu={() => {}}
      />,
    );

    await vi.waitFor(() => {
      expect(fitViewMock).toHaveBeenCalled();
    });
    fitViewMock.mockClear();

    const refreshedWorkflows = new Map([
      ['wf-a', wf('wf-a', 'running')],
      ['wf-b', wf('wf-b', 'pending')],
    ]);
    const refreshedTasks = new Map([
      ['t1', task('t1', 'wf-a')],
      ['t2', task('t2', 'wf-b')],
    ]);

    rerender(
      <WorkflowGraph
        tasks={refreshedTasks}
        workflows={refreshedWorkflows}
        selectedWorkflowId={null}
        statusFilters={new Set()}
        onSelectWorkflow={() => {}}
        onWorkflowContextMenu={() => {}}
      />,
    );

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(fitViewMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('workflow-node-wf-b')).toBeInTheDocument();
  });

  describe('one-shot centerWorkflowRequest', () => {
    const setCenterMock = (ReactFlowModule as unknown as { __setCenterMock: Mock }).__setCenterMock;

    beforeEach(() => {
      setCenterMock.mockClear();
      fitViewMock.mockClear();
    });

    it('calls setCenter once for a new centerWorkflowRequest', async () => {
      const workflows = new Map([['wf-a', wf('wf-a', 'running')]]);
      const tasks = new Map([['t1', task('t1', 'wf-a')]]);

      render(
        <WorkflowGraph
          tasks={tasks}
          workflows={workflows}
          selectedWorkflowId={null}
          centerWorkflowRequest={{ id: 'wf-a', requestId: 1 }}
          statusFilters={new Set()}
          onSelectWorkflow={() => {}}
          onWorkflowContextMenu={() => {}}
        />,
      );

      await vi.waitFor(() => {
        expect(setCenterMock).toHaveBeenCalledTimes(1);
      });
    });

    it('does not repeat setCenter for the same requestId on re-render', async () => {
      const workflows = new Map([['wf-a', wf('wf-a', 'running')]]);
      const tasks = new Map([['t1', task('t1', 'wf-a')]]);
      const request = { id: 'wf-a', requestId: 1 };

      const { rerender } = render(
        <WorkflowGraph
          tasks={tasks}
          workflows={workflows}
          selectedWorkflowId={null}
          centerWorkflowRequest={request}
          statusFilters={new Set()}
          onSelectWorkflow={() => {}}
          onWorkflowContextMenu={() => {}}
        />,
      );

      await vi.waitFor(() => {
        expect(setCenterMock).toHaveBeenCalledTimes(1);
      });

      setCenterMock.mockClear();

      rerender(
        <WorkflowGraph
          tasks={tasks}
          workflows={workflows}
          selectedWorkflowId={'wf-a'}
          centerWorkflowRequest={request}
          statusFilters={new Set()}
          onSelectWorkflow={() => {}}
          onWorkflowContextMenu={() => {}}
        />,
      );

      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(setCenterMock).not.toHaveBeenCalled();
    });

    it('calls setCenter again for a new requestId', async () => {
      const workflows = new Map([['wf-a', wf('wf-a', 'running')]]);
      const tasks = new Map([['t1', task('t1', 'wf-a')]]);

      const { rerender } = render(
        <WorkflowGraph
          tasks={tasks}
          workflows={workflows}
          selectedWorkflowId={null}
          centerWorkflowRequest={{ id: 'wf-a', requestId: 1 }}
          statusFilters={new Set()}
          onSelectWorkflow={() => {}}
          onWorkflowContextMenu={() => {}}
        />,
      );

      await vi.waitFor(() => {
        expect(setCenterMock).toHaveBeenCalledTimes(1);
      });

      setCenterMock.mockClear();

      rerender(
        <WorkflowGraph
          tasks={tasks}
          workflows={workflows}
          selectedWorkflowId={null}
          centerWorkflowRequest={{ id: 'wf-a', requestId: 2 }}
          statusFilters={new Set()}
          onSelectWorkflow={() => {}}
          onWorkflowContextMenu={() => {}}
        />,
      );

      await vi.waitFor(() => {
        expect(setCenterMock).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('graphSignature key removal', () => {
    const wfgSource = readFileSync(
      resolve(__dirname, '..', 'components', 'WorkflowGraph.tsx'),
      'utf-8',
    );

    it('does not pass key={graphSignature} to ReactFlow', () => {
      const reactFlowBlock = wfgSource.slice(
        wfgSource.indexOf('<ReactFlow'),
        wfgSource.indexOf('</ReactFlow>'),
      );
      expect(reactFlowBlock).not.toContain('key={graphSignature}');
    });

    it('does not compute graphSignature', () => {
      expect(wfgSource).not.toContain('graphSignature');
    });
  });
});
