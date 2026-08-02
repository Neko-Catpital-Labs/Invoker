import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeUITask } from './helpers/mock-invoker.js';
import type { TaskState } from '../types.js';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

vi.mock('../lib/layout.js', async () => {
  const actual = await vi.importActual<typeof import('../lib/layout.js')>('../lib/layout.js');
  return {
    ...actual,
    layoutTaskGraph: vi.fn(async (tasks: { id: string }[]) => {
      const positions = new Map<string, { x: number; y: number }>();
      [...tasks]
        .sort((a, b) => a.id.localeCompare(b.id))
        .forEach((task, index) => positions.set(task.id, { x: 1000 + index * 100, y: 1000 }));
      return { positions, edgePoints: new Map(), usedFallback: false };
    }),
  };
});

const { TaskDAG } = await import('../components/TaskDAG.js');
const { layoutTaskGraph } = await import('../lib/layout.js');

function taskMap(...tasks: TaskState[]): Map<string, TaskState> {
  return new Map(tasks.map((task) => [task.id, task]));
}

describe('TaskDAG fallback layout mode', () => {
  beforeEach(() => {
    vi.mocked(layoutTaskGraph).mockClear();
  });

  it('does not start async layout work in fallback mode', async () => {
    const task = makeUITask({ id: 'wf-1/a', workflowId: 'wf-1', status: 'pending' });

    render(<TaskDAG tasks={taskMap(task)} layoutMode="fallback" />);

    expect(await screen.findByTestId('rf__node-wf-1/a')).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(layoutTaskGraph).not.toHaveBeenCalled();
  });

  it('keeps async layout enabled by default', async () => {
    const task = makeUITask({ id: 'wf-1/a', workflowId: 'wf-1', status: 'pending' });

    render(<TaskDAG tasks={taskMap(task)} />);

    await waitFor(() => expect(layoutTaskGraph).toHaveBeenCalledTimes(1));
  });
});
