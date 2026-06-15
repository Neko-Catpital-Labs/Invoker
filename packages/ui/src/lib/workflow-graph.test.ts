import { describe, expect, it } from 'vitest';
import type { TaskState, WorkflowMeta } from '../types.js';
import { deriveWorkflowGraph, layoutWorkflowGraph, type WorkflowGraph } from './workflow-graph.js';

function makeWorkflow(
  id: string,
  status: WorkflowMeta['status'] = 'running',
  createdAt?: string,
  externalDependencies: WorkflowMeta['externalDependencies'] = [],
  externalDependencyChanges: WorkflowMeta['externalDependencyChanges'] = [],
  detachedExternalDependencies: WorkflowMeta['detachedExternalDependencies'] = [],
): WorkflowMeta {
  return {
    id,
    name: id,
    status,
    createdAt,
    externalDependencies,
    externalDependencyChanges,
    detachedExternalDependencies,
  };
}

function makeTask(id: string, workflowId: string): TaskState {
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

describe('deriveWorkflowGraph', () => {
  it('derives linear stack edges', () => {
    const workflows = new Map([
      ['A', makeWorkflow('A')],
      ['B', makeWorkflow('B', 'running', undefined, [{ workflowId: 'A' }])],
      ['C', makeWorkflow('C', 'running', undefined, [{ workflowId: 'B' }])],
    ]);
    const tasks = new Map<string, TaskState>([
      ['b1', makeTask('b1', 'B')],
      ['c1', makeTask('c1', 'C')],
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
      ['B', makeWorkflow('B', 'running', undefined, [{ workflowId: 'A' }])],
      ['C', makeWorkflow('C', 'running', undefined, [{ workflowId: 'A' }])],
      ['D', makeWorkflow('D', 'running', undefined, [{ workflowId: 'B' }, { workflowId: 'C' }])],
    ]);
    const tasks = new Map<string, TaskState>([
      ['b1', makeTask('b1', 'B')],
      ['c1', makeTask('c1', 'C')],
      ['d1', makeTask('d1', 'D')],
    ]);

    const graph = deriveWorkflowGraph(workflows, tasks);
    expect(graph.edges).toEqual([
      { source: 'A', target: 'B', kind: 'active' },
      { source: 'A', target: 'C', kind: 'active' },
      { source: 'B', target: 'D', kind: 'active' },
      { source: 'C', target: 'D', kind: 'active' },
    ]);
  });

  it('collects missing external dependencies without crashing', () => {
    const workflows = new Map([
      ['B', makeWorkflow('B', 'running', undefined, [{ workflowId: 'missing' }])],
    ]);
    const tasks = new Map<string, TaskState>([
      ['b1', makeTask('b1', 'B')],
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

  it('derives dependency-change lineage separately from active dependency edges', () => {
    const workflows = new Map([
      ['A', makeWorkflow('A')],
      [
        'B',
        makeWorkflow('B', 'running', undefined, [], [
          {
            before: {
              workflowId: 'A',
              taskId: '__merge__',
              requiredStatus: 'completed',
              gatePolicy: 'completed',
            },
            changedAt: '2026-01-01T00:00:00.000Z',
          },
        ]),
      ],
    ]);

    const graph = deriveWorkflowGraph(workflows, new Map());

    expect(graph.edges).toEqual([
      { source: 'A', target: 'B', kind: 'historical' },
    ]);
  });

  it('derives detached provenance separately from active dependency edges', () => {
    const workflows = new Map([
      ['A', makeWorkflow('A')],
      [
        'B',
        makeWorkflow('B', 'running', undefined, [], [], [
          {
            workflowId: 'A',
            taskId: '__merge__',
            requiredStatus: 'completed',
            gatePolicy: 'completed',
            detachedAt: '2026-01-02T00:00:00.000Z',
          },
        ]),
      ],
    ]);

    const graph = deriveWorkflowGraph(workflows, new Map());

    expect(graph.edges).toEqual([
      { source: 'A', target: 'B', kind: 'detached' },
    ]);
  });

  it('preserves active dependency edges over detached provenance for the same workflow pair', () => {
    const dependency = {
      workflowId: 'A',
      taskId: '__merge__',
      requiredStatus: 'completed' as const,
      gatePolicy: 'completed' as const,
    };
    const workflows = new Map([
      ['A', makeWorkflow('A')],
      [
        'B',
        makeWorkflow('B', 'running', undefined, [dependency], [], [
          {
            ...dependency,
            detachedAt: '2026-01-02T00:00:00.000Z',
          },
        ]),
      ],
    ]);

    const graph = deriveWorkflowGraph(workflows, new Map());

    expect(graph.edges).toEqual([
      { source: 'A', target: 'B', kind: 'active' },
    ]);
  });

  it('does not duplicate active edges for dependency addition history', () => {
    const dependency = {
      workflowId: 'A',
      taskId: '__merge__',
      requiredStatus: 'completed' as const,
      gatePolicy: 'completed' as const,
    };
    const workflows = new Map([
      ['A', makeWorkflow('A')],
      [
        'B',
        makeWorkflow('B', 'running', undefined, [dependency], [
          {
            after: dependency,
            changedAt: '2026-01-01T00:00:00.000Z',
          },
        ]),
      ],
    ]);

    const graph = deriveWorkflowGraph(workflows, new Map());

    expect(graph.edges).toEqual([
      { source: 'A', target: 'B', kind: 'active' },
    ]);
  });

  it('derives both sides of a dependency replacement history', () => {
    const before = {
      workflowId: 'A',
      taskId: '__merge__',
      requiredStatus: 'completed' as const,
      gatePolicy: 'completed' as const,
    };
    const after = {
      workflowId: 'C',
      taskId: '__merge__',
      requiredStatus: 'completed' as const,
      gatePolicy: 'completed' as const,
    };
    const workflows = new Map([
      ['A', makeWorkflow('A')],
      ['B', makeWorkflow('B', 'running', undefined, [], [{ before, after, changedAt: '2026-01-01T00:00:00.000Z' }])],
      ['C', makeWorkflow('C')],
    ]);

    const graph = deriveWorkflowGraph(workflows, new Map());

    expect(graph.edges).toEqual([
      { source: 'A', target: 'B', kind: 'historical' },
      { source: 'C', target: 'B', kind: 'historical' },
    ]);
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
      [{ source: 'chain-a', target: 'chain-b', kind: 'active' }],
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
        { source: 'older-a', target: 'older-b', kind: 'active' },
        { source: 'newer-a', target: 'newer-b', kind: 'active' },
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
        { source: 'root', target: 'left', kind: 'active' },
        { source: 'root', target: 'middle', kind: 'active' },
        { source: 'root', target: 'right', kind: 'active' },
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
      [{ source: 'fix-step-1', target: 'fix-step-2', kind: 'active' }],
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
        { source: 'a-root', target: 'y-target', kind: 'active' },
        { source: 'b-root', target: 'x-target', kind: 'active' },
        { source: 'x-target', target: 'z-join', kind: 'active' },
        { source: 'y-target', target: 'z-join', kind: 'active' },
      ],
    );

    const positions = layoutWorkflowGraph(graph, 100, 50, 25);

    expect(positions.get('y-target')).toEqual({ x: 180, y: 80 });
    expect(positions.get('x-target')).toEqual({ x: 180, y: 130 });
  });

  it('uses detached lineage as adjacency so detached downstream workflows stay grouped', () => {
    const graph = makeGraph(
      [
        makeWorkflow('former-upstream', 'running', '2026-01-01T00:00:00.000Z'),
        makeWorkflow('detached-downstream', 'running', '2026-01-01T00:00:00.000Z'),
        makeWorkflow('new-standalone', 'running', '2026-02-01T00:00:00.000Z'),
      ],
      [{ source: 'former-upstream', target: 'detached-downstream', kind: 'detached' }],
    );

    const positions = layoutWorkflowGraph(graph, 100, 50, 25);

    expect(positions.get('new-standalone')).toEqual({ x: 80, y: 80 });
    expect(positions.get('former-upstream')).toEqual({ x: 80, y: 155 });
    expect(positions.get('detached-downstream')).toEqual({ x: 180, y: 155 });
  });
});

function makeGraph(
  workflows: WorkflowMeta[],
  edges: WorkflowGraph['edges'],
): WorkflowGraph {
  return {
    nodes: workflows.map((workflow) => ({ id: workflow.id, name: workflow.name, workflow })),
    edges,
    missingDependencies: [],
  };
}
