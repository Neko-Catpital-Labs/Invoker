import { describe, expect, it } from 'vitest';
import { layoutTaskGraph } from '../lib/layout.js';
import type { TaskState } from '../types.js';

function makeTask(id: string, deps: string[] = []): TaskState {
  return {
    id,
    description: `Task ${id}`,
    status: 'pending',
    dependencies: deps,
    createdAt: new Date('2025-01-01'),
    config: {},
    execution: {},
  };
}

describe('layoutTaskGraph', () => {
  it('returns a position for every task', async () => {
    const tasks = [
      makeTask('a'),
      makeTask('b', ['a']),
      makeTask('c', ['b']),
    ];

    const result = await layoutTaskGraph(tasks, [
      { id: 'local:a->b', source: 'a', target: 'b' },
      { id: 'local:b->c', source: 'b', target: 'c' },
    ]);

    expect(result.positions.size).toBe(tasks.length);
    for (const task of tasks) {
      expect(result.positions.has(task.id)).toBe(true);
    }
  });

  it('keeps dependency direction left-to-right', async () => {
    const tasks = [
      makeTask('a'),
      makeTask('b', ['a']),
      makeTask('c', ['b']),
    ];

    const result = await layoutTaskGraph(tasks, [
      { id: 'local:a->b', source: 'a', target: 'b' },
      { id: 'local:b->c', source: 'b', target: 'c' },
    ]);

    expect(result.positions.get('a')!.x).toBeLessThan(result.positions.get('b')!.x);
    expect(result.positions.get('b')!.x).toBeLessThan(result.positions.get('c')!.x);
  });

  it('is deterministic for shuffled input', async () => {
    const tasks = [
      makeTask('root'),
      makeTask('left', ['root']),
      makeTask('right', ['root']),
      makeTask('leaf', ['left', 'right']),
    ];
    const edges = [
      { id: 'local:root->left', source: 'root', target: 'left' },
      { id: 'local:root->right', source: 'root', target: 'right' },
      { id: 'local:left->leaf', source: 'left', target: 'leaf' },
      { id: 'local:right->leaf', source: 'right', target: 'leaf' },
    ];

    const reference = await layoutTaskGraph(tasks, edges);
    const shuffled = await layoutTaskGraph(
      [tasks[3], tasks[1], tasks[0], tasks[2]],
      [edges[2], edges[0], edges[3], edges[1]],
    );

    for (const task of tasks) {
      expect(shuffled.positions.get(task.id)).toEqual(reference.positions.get(task.id));
    }
  });

  it('uses external edges as layout constraints', async () => {
    const tasks = [
      makeTask('source'),
      makeTask('middle'),
      makeTask('target'),
    ];

    const result = await layoutTaskGraph(tasks, [
      { id: 'external:source->target', source: 'source', target: 'target' },
    ]);

    expect(result.positions.get('source')!.x).toBeLessThan(result.positions.get('target')!.x);
  });

  it('rejects when ELK fails', async () => {
    const tasks = [
      makeTask('a'),
      makeTask('b', ['a']),
    ];

    await expect(layoutTaskGraph(
      tasks,
      [{ id: 'local:a->b', source: 'a', target: 'b' }],
      { elk: { layout: async () => { throw new Error('forced failure'); } } },
    )).rejects.toThrow('forced failure');
  });

  it('passes through routed edge points when ELK returns them', async () => {
    const tasks = [
      makeTask('a'),
      makeTask('b', ['a']),
    ];

    const result = await layoutTaskGraph(
      tasks,
      [{ id: 'local:a->b', source: 'a', target: 'b' }],
      {
        elk: {
          layout: async () => ({
            children: [
              { id: 'a', x: 10, y: 20 },
              { id: 'b', x: 300, y: 20 },
            ],
            edges: [
              {
                id: 'local:a->b',
                sections: [
                  {
                    startPoint: { x: 290, y: 60 },
                    bendPoints: [{ x: 320, y: 60 }],
                    endPoint: { x: 300, y: 60 },
                  },
                ],
              },
            ],
          }),
        },
      },
    );

    expect(result.edgePoints.get('local:a->b')).toEqual([
      { x: 290, y: 60 },
      { x: 320, y: 60 },
      { x: 300, y: 60 },
    ]);
  });
});
