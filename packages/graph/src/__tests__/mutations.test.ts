import { describe, it, expect, beforeEach } from 'vitest';
import { ActionGraph } from '../action-graph.js';
import { forkDirtySubtree } from '../mutations.js';

describe('forkDirtySubtree', () => {
  let graph: ActionGraph;

  beforeEach(() => {
    graph = new ActionGraph();
  });

  it('returns empty when dirty task has no descendants', () => {
    graph.createNode('root', 'Root task', []);
    graph.setNode('root', { ...graph.getNode('root')!, status: 'completed' });

    const deltas = forkDirtySubtree(graph, 'root');

    expect(deltas).toEqual([]);
  });

  it('clones downstream tasks with versioned IDs', () => {
    // A (dirty) -> B -> C
    graph.createNode('A', 'Task A', []);
    graph.setNode('A', { ...graph.getNode('A')!, status: 'completed' });

    graph.createNode('B', 'Task B', ['A']);
    graph.setNode('B', { ...graph.getNode('B')!, status: 'completed' });

    graph.createNode('C', 'Task C', ['B']);
    graph.setNode('C', { ...graph.getNode('C')!, status: 'completed' });

    const deltas = forkDirtySubtree(graph, 'A');

    // Should produce stale updates for B and C, plus created deltas for B-v2 and C-v2
    const staleDeltas = deltas.filter(
      (d) => d.type === 'updated' && 'changes' in d && d.changes.status === 'stale',
    );
    const createdDeltas = deltas.filter((d) => d.type === 'created');

    expect(staleDeltas).toHaveLength(2);
    expect(createdDeltas).toHaveLength(2);

    const cloneIds = createdDeltas.map((d) => d.type === 'created' && d.task.id).sort();
    expect(cloneIds).toEqual(['B-v2', 'C-v2']);
  });

  it('rewrites dependencies in clones', () => {
    // A (dirty) -> B -> C
    graph.createNode('A', 'Task A', []);
    graph.setNode('A', { ...graph.getNode('A')!, status: 'completed' });

    graph.createNode('B', 'Task B', ['A']);
    graph.setNode('B', { ...graph.getNode('B')!, status: 'completed' });

    graph.createNode('C', 'Task C', ['B']);
    graph.setNode('C', { ...graph.getNode('C')!, status: 'completed' });

    forkDirtySubtree(graph, 'A');

    // B-v2 should depend on A (the dirty task itself, not cloned)
    const bClone = graph.getNode('B-v2');
    expect(bClone).toBeDefined();
    expect(bClone!.dependencies).toEqual(['A']);

    // C-v2 should depend on B-v2 (remapped from B)
    const cClone = graph.getNode('C-v2');
    expect(cClone).toBeDefined();
    expect(cClone!.dependencies).toEqual(['B-v2']);
  });

  it('marks original descendants as stale', () => {
    graph.createNode('A', 'Task A', []);
    graph.setNode('A', { ...graph.getNode('A')!, status: 'completed' });

    graph.createNode('B', 'Task B', ['A']);
    graph.setNode('B', { ...graph.getNode('B')!, status: 'completed' });

    forkDirtySubtree(graph, 'A');

    // Original B should now be stale
    expect(graph.getNode('B')!.status).toBe('stale');
  });

  it('does not mark pending descendants as stale', () => {
    graph.createNode('A', 'Task A', []);
    graph.setNode('A', { ...graph.getNode('A')!, status: 'completed' });

    graph.createNode('B', 'Task B', ['A']);
    // B stays pending — not in STALEABLE_STATUSES

    forkDirtySubtree(graph, 'A');

    // B should remain pending (not stale)
    expect(graph.getNode('B')!.status).toBe('pending');
  });

  it('original dirty task retains its state', () => {
    graph.createNode('A', 'Task A', []);
    graph.setNode('A', { ...graph.getNode('A')!, status: 'completed' });

    graph.createNode('B', 'Task B', ['A']);
    graph.setNode('B', { ...graph.getNode('B')!, status: 'completed' });

    forkDirtySubtree(graph, 'A');

    // A itself should NOT be modified — only descendants are forked
    const root = graph.getNode('A')!;
    expect(root.status).toBe('completed');
    expect(root.id).toBe('A');
  });

  it('handles a diamond graph', () => {
    // A (dirty) -> B, C -> D
    graph.createNode('A', 'Task A', []);
    graph.setNode('A', { ...graph.getNode('A')!, status: 'completed' });

    graph.createNode('B', 'Task B', ['A']);
    graph.setNode('B', { ...graph.getNode('B')!, status: 'completed' });

    graph.createNode('C', 'Task C', ['A']);
    graph.setNode('C', { ...graph.getNode('C')!, status: 'completed' });

    graph.createNode('D', 'Task D', ['B', 'C']);
    graph.setNode('D', { ...graph.getNode('D')!, status: 'completed' });

    forkDirtySubtree(graph, 'A');

    // All originals should be stale
    expect(graph.getNode('B')!.status).toBe('stale');
    expect(graph.getNode('C')!.status).toBe('stale');
    expect(graph.getNode('D')!.status).toBe('stale');

    // Clones should exist with remapped deps
    const dClone = graph.getNode('D-v2');
    expect(dClone).toBeDefined();
    expect(dClone!.dependencies.sort()).toEqual(['B-v2', 'C-v2']);
  });
});
