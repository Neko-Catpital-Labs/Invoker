import { describe, it, expect, beforeEach } from 'vitest';
import { ActionGraph } from '../action-graph.js';
import type { TaskState } from '../types.js';

function makeTask(
  id: string,
  deps: string[] = [],
  status: TaskState['status'] = 'pending',
): TaskState {
  return {
    id,
    description: `Task ${id}`,
    status,
    dependencies: deps,
    createdAt: new Date(),
  };
}

describe('ActionGraph', () => {
  let graph: ActionGraph;

  beforeEach(() => {
    graph = new ActionGraph();
  });

  // ── createNode ──────────────────────────────────────────────

  describe('createNode', () => {
    it('returns the node and a created delta', () => {
      const { node, delta } = graph.createNode('t1', 'Build app', []);

      expect(node.id).toBe('t1');
      expect(node.description).toBe('Build app');
      expect(node.status).toBe('pending');
      expect(node.dependencies).toEqual([]);
      expect(delta).toEqual({ type: 'created', task: node });
    });

    it('sets status to blocked when a dependency has failed', () => {
      graph.createNode('dep1', 'Dep', []);
      // Simulate dep1 failing
      graph.setNode('dep1', { ...graph.getNode('dep1')!, status: 'failed' });

      const { node } = graph.createNode('t2', 'Downstream', ['dep1']);

      expect(node.status).toBe('blocked');
      expect(node.blockedBy).toBe('dep1');
    });

    it('stays pending when dependencies have not failed', () => {
      graph.createNode('dep1', 'Dep', []);

      const { node } = graph.createNode('t2', 'Downstream', ['dep1']);

      expect(node.status).toBe('pending');
      expect(node.blockedBy).toBeUndefined();
    });

    it('passes options through to the task state', () => {
      const { node } = graph.createNode('t1', 'Task', [], {
        command: 'npm test',
        prompt: 'Run tests',
      });

      expect(node.command).toBe('npm test');
      expect(node.prompt).toBe('Run tests');
    });
  });

  // ── getNode ─────────────────────────────────────────────────

  describe('getNode', () => {
    it('returns undefined for a missing ID', () => {
      expect(graph.getNode('nonexistent')).toBeUndefined();
    });

    it('returns the node after creation', () => {
      graph.createNode('t1', 'Task', []);
      const node = graph.getNode('t1');

      expect(node).toBeDefined();
      expect(node!.id).toBe('t1');
    });
  });

  // ── getAllNodes ──────────────────────────────────────────────

  describe('getAllNodes', () => {
    it('returns all nodes in the graph', () => {
      graph.createNode('a', 'A', []);
      graph.createNode('b', 'B', []);
      graph.createNode('c', 'C', ['a']);

      const all = graph.getAllNodes();
      const ids = all.map((n) => n.id).sort();

      expect(ids).toEqual(['a', 'b', 'c']);
    });

    it('returns empty array for an empty graph', () => {
      expect(graph.getAllNodes()).toEqual([]);
    });
  });

  // ── getReadyNodes ───────────────────────────────────────────

  describe('getReadyNodes', () => {
    it('returns only pending nodes with all deps completed', () => {
      graph.createNode('a', 'A', []);
      graph.setNode('a', { ...graph.getNode('a')!, status: 'completed' });

      graph.createNode('b', 'B', ['a']);
      graph.createNode('c', 'C', ['a']);
      graph.setNode('c', { ...graph.getNode('c')!, status: 'running' });

      graph.createNode('d', 'D', ['b']);

      const ready = graph.getReadyNodes();
      const ids = ready.map((n) => n.id);

      // b is pending, dep a is completed -> ready
      // c is running -> not ready
      // d is pending, dep b is not completed -> not ready
      expect(ids).toEqual(['b']);
    });

    it('returns nodes with no dependencies if pending', () => {
      graph.createNode('a', 'A', []);
      graph.createNode('b', 'B', []);

      const ready = graph.getReadyNodes();
      const ids = ready.map((n) => n.id).sort();

      expect(ids).toEqual(['a', 'b']);
    });

    it('returns empty when no nodes are ready', () => {
      graph.createNode('a', 'A', []);
      graph.setNode('a', { ...graph.getNode('a')!, status: 'running' });

      expect(graph.getReadyNodes()).toEqual([]);
    });
  });

  // ── restoreNode ─────────────────────────────────────────────

  describe('restoreNode', () => {
    it('inserts a node without producing a delta', () => {
      const task = makeTask('restored', [], 'completed');
      graph.restoreNode(task);

      expect(graph.getNode('restored')).toBe(task);
      expect(graph.getNodeCount()).toBe(1);
    });

    it('overwrites an existing node with the same ID', () => {
      graph.createNode('t1', 'Original', []);
      const replacement = makeTask('t1', [], 'completed');
      graph.restoreNode(replacement);

      expect(graph.getNode('t1')!.status).toBe('completed');
    });
  });

  // ── rewriteDependency ───────────────────────────────────────

  describe('rewriteDependency', () => {
    it('updates deps and returns deltas', () => {
      graph.createNode('old', 'Old task', []);
      graph.createNode('new', 'New task', []);
      graph.createNode('child', 'Child', ['old']);

      const deltas = graph.rewriteDependency('old', 'new');

      expect(deltas).toHaveLength(1);
      expect(deltas[0]).toEqual({
        type: 'updated',
        taskId: 'child',
        changes: { dependencies: ['new'] },
      });
      expect(graph.getNode('child')!.dependencies).toEqual(['new']);
    });

    it('skips experiment children of the old dep', () => {
      graph.createNode('parent', 'Parent', []);
      graph.createNode('new-parent', 'New parent', []);
      graph.createNode('exp-child', 'Experiment', ['parent'], {
        parentTask: 'parent',
      });

      const deltas = graph.rewriteDependency('parent', 'new-parent');

      // exp-child should not be rewritten because parentTask === oldDepId
      expect(deltas).toHaveLength(0);
      expect(graph.getNode('exp-child')!.dependencies).toEqual(['parent']);
    });

    it('returns empty when no nodes depend on oldDepId', () => {
      graph.createNode('a', 'A', []);
      graph.createNode('b', 'B', []);

      const deltas = graph.rewriteDependency('a', 'b');

      expect(deltas).toEqual([]);
    });
  });

  // ── removeNode ──────────────────────────────────────────────

  describe('removeNode', () => {
    it('deletes a node and returns true', () => {
      graph.createNode('t1', 'Task', []);

      expect(graph.removeNode('t1')).toBe(true);
      expect(graph.getNode('t1')).toBeUndefined();
      expect(graph.getNodeCount()).toBe(0);
    });

    it('returns false for a nonexistent node', () => {
      expect(graph.removeNode('missing')).toBe(false);
    });
  });

  // ── clear ───────────────────────────────────────────────────

  describe('clear', () => {
    it('empties the graph', () => {
      graph.createNode('a', 'A', []);
      graph.createNode('b', 'B', []);
      graph.createNode('c', 'C', ['a']);

      graph.clear();

      expect(graph.getAllNodes()).toEqual([]);
      expect(graph.getNodeCount()).toBe(0);
    });
  });
});
