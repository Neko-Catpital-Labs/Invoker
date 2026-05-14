import { describe, expect, it } from 'vitest';
import type { TaskState, WorkflowMeta } from '../types.js';
import { deriveWorkflowGraph, layoutWorkflowGraphWithElk } from './workflow-graph.js';

function makeWorkflow(id: string, status: WorkflowMeta['status'] = 'running'): WorkflowMeta {
  return { id, name: id, status };
}

function makeTask(
  id: string,
  workflowId: string,
  externalDependencies: Array<{ workflowId: string; taskId?: string }> = [],
): TaskState {
  return {
    id,
    description: id,
    status: 'pending',
    dependencies: [],
    config: {
      workflowId,
      externalDependencies: externalDependencies.map((dep) => ({
        workflowId: dep.workflowId,
        taskId: dep.taskId,
        requiredStatus: 'completed' as const,
      })),
    },
    execution: {},
    taskStateVersion: 1,
  };
}

describe('deriveWorkflowGraph', () => {
  it('derives linear stack edges', () => {
    const workflows = new Map([
      ['A', makeWorkflow('A')],
      ['B', makeWorkflow('B')],
      ['C', makeWorkflow('C')],
    ]);
    const tasks = new Map<string, TaskState>([
      ['b1', makeTask('b1', 'B', [{ workflowId: 'A' }])],
      ['c1', makeTask('c1', 'C', [{ workflowId: 'B' }])],
    ]);

    const graph = deriveWorkflowGraph(workflows, tasks);
    expect(graph.edges).toEqual([
      { source: 'A', target: 'B' },
      { source: 'B', target: 'C' },
    ]);
  });

  it('supports fork and fan-in', () => {
    const workflows = new Map([
      ['A', makeWorkflow('A')],
      ['B', makeWorkflow('B')],
      ['C', makeWorkflow('C')],
      ['D', makeWorkflow('D')],
    ]);
    const tasks = new Map<string, TaskState>([
      ['b1', makeTask('b1', 'B', [{ workflowId: 'A' }])],
      ['c1', makeTask('c1', 'C', [{ workflowId: 'A' }])],
      ['d1', makeTask('d1', 'D', [{ workflowId: 'B' }, { workflowId: 'C' }])],
    ]);

    const graph = deriveWorkflowGraph(workflows, tasks);
    expect(graph.edges).toEqual([
      { source: 'A', target: 'B' },
      { source: 'A', target: 'C' },
      { source: 'B', target: 'D' },
      { source: 'C', target: 'D' },
    ]);
  });

  it('collects missing external dependencies without crashing', () => {
    const workflows = new Map([
      ['B', makeWorkflow('B')],
    ]);
    const tasks = new Map<string, TaskState>([
      ['b1', makeTask('b1', 'B', [{ workflowId: 'missing' }])],
    ]);

    const graph = deriveWorkflowGraph(workflows, tasks);
    expect(graph.edges).toEqual([]);
    expect(graph.missingDependencies).toEqual(['missing->B']);
  });

  it('keeps no-dependency workflows as standalone nodes', () => {
    const workflows = new Map([
      ['A', makeWorkflow('A')],
      ['B', makeWorkflow('B')],
    ]);

    const graph = deriveWorkflowGraph(workflows, new Map());
    expect(graph.nodes.map((node) => node.id)).toEqual(['A', 'B']);
    expect(graph.edges).toEqual([]);
  });
});

describe('layoutWorkflowGraphWithElk', () => {
  it('returns ELK workflow positions and route points', async () => {
    const workflows = new Map([
      ['A', makeWorkflow('A')],
      ['B', makeWorkflow('B')],
    ]);
    const tasks = new Map<string, TaskState>([
      ['b1', makeTask('b1', 'B', [{ workflowId: 'A' }])],
    ]);

    const graph = deriveWorkflowGraph(workflows, tasks);
    const layout = await layoutWorkflowGraphWithElk(graph, {
      elk: {
        layout: async () => ({
          children: [
            { id: 'A', x: 10, y: 20 },
            { id: 'B', x: 300, y: 20 },
          ],
          edges: [
            {
              id: 'A->B',
              sections: [
                {
                  startPoint: { x: 230, y: 54 },
                  bendPoints: [{ x: 260, y: 54 }],
                  endPoint: { x: 300, y: 54 },
                },
              ],
            },
          ],
        }),
      },
    });

    expect(layout.positions.get('A')).toEqual({ x: 10, y: 20 });
    expect(layout.positions.get('B')).toEqual({ x: 300, y: 20 });
    expect(layout.edgePoints.get('A->B')).toEqual([
      { x: 230, y: 54 },
      { x: 260, y: 54 },
      { x: 300, y: 54 },
    ]);
  });

  it('rejects when ELK fails', async () => {
    const workflows = new Map([
      ['A', makeWorkflow('A')],
      ['B', makeWorkflow('B')],
    ]);
    const tasks = new Map<string, TaskState>([
      ['b1', makeTask('b1', 'B', [{ workflowId: 'A' }])],
    ]);

    const graph = deriveWorkflowGraph(workflows, tasks);
    await expect(layoutWorkflowGraphWithElk(graph, {
      elk: { layout: async () => { throw new Error('forced failure'); } },
    })).rejects.toThrow('forced failure');
  });
});
