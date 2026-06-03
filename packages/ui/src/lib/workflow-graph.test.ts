import { describe, expect, it } from 'vitest';
import type { TaskState, WorkflowMeta } from '../types.js';
import { deriveWorkflowGraph, layoutWorkflowGraph, type WorkflowGraph } from './workflow-graph.js';

function makeWorkflow(
  id: string,
  status: WorkflowMeta['status'] = 'running',
  createdAt?: string,
): WorkflowMeta {
  return { id, name: id, status, createdAt };
}

function makeTask(
  id: string,
  workflowId: string,
  externalDependencies: Array<{ workflowId: string; taskId?: string }> = [],
  detachedExternalDependencies: Array<{ workflowId: string; taskId?: string; detachedAt?: string }> = [],
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
      detachedExternalDependencies: detachedExternalDependencies.map((dep) => ({
        workflowId: dep.workflowId,
        taskId: dep.taskId,
        requiredStatus: 'completed' as const,
        detachedAt: dep.detachedAt ?? '2026-06-02T08:57:38.000Z',
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
      { source: 'A', target: 'B', kind: 'active' },
      { source: 'B', target: 'C', kind: 'active' },
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
      { source: 'A', target: 'B', kind: 'active' },
      { source: 'A', target: 'C', kind: 'active' },
      { source: 'B', target: 'D', kind: 'active' },
      { source: 'C', target: 'D', kind: 'active' },
    ]);
  });

  it('derives detached workflow lineage from provenance without active dependencies', () => {
    const workflows = new Map([
      ['A', makeWorkflow('A')],
      ['B', makeWorkflow('B')],
      ['C', makeWorkflow('C')],
    ]);
    const tasks = new Map<string, TaskState>([
      ['b1', makeTask('b1', 'B', [], [{ workflowId: 'A' }])],
      ['c1', makeTask('c1', 'C', [{ workflowId: 'B' }])],
    ]);

    const graph = deriveWorkflowGraph(workflows, tasks);
    expect(graph.edges).toEqual([
      { source: 'A', target: 'B', kind: 'detached' },
      { source: 'B', target: 'C', kind: 'active' },
    ]);
    expect(tasks.get('b1')?.config.externalDependencies).toEqual([]);
  });

  it('deduplicates detached provenance and lets active edges take precedence', () => {
    const workflows = new Map([
      ['A', makeWorkflow('A')],
      ['B', makeWorkflow('B')],
    ]);
    const tasks = new Map<string, TaskState>([
      ['b1', makeTask('b1', 'B', [{ workflowId: 'A' }], [{ workflowId: 'A' }])],
      ['b2', makeTask('b2', 'B', [], [{ workflowId: 'A', taskId: 'leaf' }])],
    ]);

    const graph = deriveWorkflowGraph(workflows, tasks);
    expect(graph.edges).toEqual([
      { source: 'A', target: 'B', kind: 'active' },
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

describe('layoutWorkflowGraph', () => {
  it('places a standalone workflow component in its own row band', () => {
    const graph = makeGraph(
      [
        makeWorkflow('chain-a', 'running', '2026-01-01T00:00:00.000Z'),
        makeWorkflow('chain-b', 'running', '2026-01-01T00:00:00.000Z'),
        makeWorkflow('solo', 'running', '2026-02-01T00:00:00.000Z'),
      ],
      [{ source: 'chain-a', target: 'chain-b' }],
    );

    const positions = layoutWorkflowGraph(graph, 100, 50, 25);

    expect(positions.get('solo')).toEqual({ x: 80, y: 80 });
    expect(positions.get('chain-a')?.y).toBe(155);
    expect(positions.get('chain-b')?.y).toBe(155);
  });

  it('stacks disconnected chain components without overlapping rows', () => {
    const graph = makeGraph(
      [
        makeWorkflow('older-a', 'running', '2026-01-01T00:00:00.000Z'),
        makeWorkflow('older-b', 'running', '2026-01-01T00:00:00.000Z'),
        makeWorkflow('newer-a', 'running', '2026-03-01T00:00:00.000Z'),
        makeWorkflow('newer-b', 'running', '2026-03-01T00:00:00.000Z'),
      ],
      [
        { source: 'older-a', target: 'older-b' },
        { source: 'newer-a', target: 'newer-b' },
      ],
    );

    const positions = layoutWorkflowGraph(graph, 100, 50, 25);

    expect(positions.get('newer-a')).toEqual({ x: 80, y: 80 });
    expect(positions.get('newer-b')).toEqual({ x: 180, y: 80 });
    expect(positions.get('older-a')).toEqual({ x: 80, y: 155 });
    expect(positions.get('older-b')).toEqual({ x: 180, y: 155 });
  });

  it('orders components newest-created first', () => {
    const graph = makeGraph(
      [
        makeWorkflow('old', 'running', '2026-01-01T00:00:00.000Z'),
        makeWorkflow('new', 'running', '2026-04-01T00:00:00.000Z'),
        makeWorkflow('middle', 'running', '2026-02-01T00:00:00.000Z'),
      ],
      [],
    );

    const positions = layoutWorkflowGraph(graph, 100, 50, 25);

    expect(positions.get('new')?.y).toBe(80);
    expect(positions.get('middle')?.y).toBe(155);
    expect(positions.get('old')?.y).toBe(230);
  });

  it('reserves component height from the widest dependency level', () => {
    const graph = makeGraph(
      [
        makeWorkflow('root', 'running', '2026-03-01T00:00:00.000Z'),
        makeWorkflow('left', 'running', '2026-03-01T00:00:00.000Z'),
        makeWorkflow('middle', 'running', '2026-03-01T00:00:00.000Z'),
        makeWorkflow('right', 'running', '2026-03-01T00:00:00.000Z'),
        makeWorkflow('older', 'running', '2026-01-01T00:00:00.000Z'),
      ],
      [
        { source: 'root', target: 'left' },
        { source: 'root', target: 'middle' },
        { source: 'root', target: 'right' },
      ],
    );

    const positions = layoutWorkflowGraph(graph, 100, 50, 25);

    expect(positions.get('left')?.y).toBe(80);
    expect(positions.get('middle')?.y).toBe(130);
    expect(positions.get('right')?.y).toBe(180);
    expect(positions.get('older')?.y).toBe(255);
  });

  it('keeps crossing-prone disconnected workflows in separate row groups', () => {
    const graph = makeGraph(
      [
        makeWorkflow('fix-step-1', 'running', '2026-01-01T00:00:00.000Z'),
        makeWorkflow('fix-step-2', 'running', '2026-01-01T00:00:00.000Z'),
        { ...makeWorkflow('cost-query', 'running', '2026-02-01T00:00:00.000Z'), name: 'Cost Query' },
      ],
      [{ source: 'fix-step-1', target: 'fix-step-2' }],
    );

    const positions = layoutWorkflowGraph(graph, 100, 50, 25);

    expect(positions.get('cost-query')?.y).toBe(80);
    expect(positions.get('fix-step-1')?.y).toBe(155);
    expect(positions.get('fix-step-2')?.y).toBe(155);
  });

  it('orders nodes inside a component by adjacent-level barycenter', () => {
    const graph = makeGraph(
      [
        makeWorkflow('a-root'),
        makeWorkflow('b-root'),
        makeWorkflow('x-target'),
        makeWorkflow('y-target'),
        makeWorkflow('z-join'),
      ],
      [
        { source: 'a-root', target: 'y-target' },
        { source: 'b-root', target: 'x-target' },
        { source: 'x-target', target: 'z-join' },
        { source: 'y-target', target: 'z-join' },
      ],
    );

    const positions = layoutWorkflowGraph(graph, 100, 50, 25);

    expect(positions.get('y-target')).toEqual({ x: 180, y: 80 });
    expect(positions.get('x-target')).toEqual({ x: 180, y: 130 });
  });

  it('uses detached edges for component grouping and dependency levels', () => {
    const graph = makeGraph(
      [
        makeWorkflow('upstream', 'running', '2026-01-01T00:00:00.000Z'),
        makeWorkflow('downstream', 'running', '2026-01-01T00:00:00.000Z'),
        makeWorkflow('new-standalone', 'running', '2026-03-01T00:00:00.000Z'),
      ],
      [{ source: 'upstream', target: 'downstream', kind: 'detached' }],
    );

    const positions = layoutWorkflowGraph(graph, 100, 50, 25);

    expect(positions.get('new-standalone')).toEqual({ x: 80, y: 80 });
    expect(positions.get('upstream')).toEqual({ x: 80, y: 155 });
    expect(positions.get('downstream')).toEqual({ x: 180, y: 155 });
  });
});

type GraphEdgeInput = Omit<WorkflowGraph['edges'][number], 'kind'> & {
  kind?: WorkflowGraph['edges'][number]['kind'];
};

function makeGraph(
  workflows: WorkflowMeta[],
  edges: GraphEdgeInput[],
): WorkflowGraph {
  return {
    nodes: workflows.map((workflow) => ({ id: workflow.id, name: workflow.name, workflow })),
    edges: edges.map((edge) => ({ ...edge, kind: edge.kind ?? 'active' })),
    missingDependencies: [],
  };
}
