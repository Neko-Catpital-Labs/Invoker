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

  // ── API surface guardrail ──────────────────────────────────

  describe('API surface (read-only + sync)', () => {
    it('exposes only read methods and restoreNode/clear', () => {
      expect(typeof graph.getNode).toBe('function');
      expect(typeof graph.getAllNodes).toBe('function');
      expect(typeof graph.getNodeCount).toBe('function');
      expect(typeof graph.getReadyNodes).toBe('function');
      expect(typeof graph.restoreNode).toBe('function');
      expect(typeof graph.clear).toBe('function');
    });

    it('does not expose write methods', () => {
      expect((graph as any).setNode).toBeUndefined();
      expect((graph as any).createNode).toBeUndefined();
      expect((graph as any).rewriteDependency).toBeUndefined();
      expect((graph as any).removeNode).toBeUndefined();
    });
  });

  // ── getNode ─────────────────────────────────────────────────

  describe('getNode', () => {
    it('returns undefined for a missing ID', () => {
      expect(graph.getNode('nonexistent')).toBeUndefined();
    });

    it('returns the node after restoreNode', () => {
      graph.restoreNode(makeTask('t1'));
      const node = graph.getNode('t1');

      expect(node).toBeDefined();
      expect(node!.id).toBe('t1');
    });
  });

  // ── getAllNodes ──────────────────────────────────────────────

  describe('getAllNodes', () => {
    it('returns all nodes in the graph', () => {
      graph.restoreNode(makeTask('a'));
      graph.restoreNode(makeTask('b'));
      graph.restoreNode(makeTask('c', ['a']));

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
      graph.restoreNode(makeTask('a', [], 'completed'));
      graph.restoreNode(makeTask('b', ['a'], 'pending'));
      graph.restoreNode(makeTask('c', ['a'], 'running'));
      graph.restoreNode(makeTask('d', ['b'], 'pending'));

      const ready = graph.getReadyNodes();
      const ids = ready.map((n) => n.id);

      // b is pending, dep a is completed -> ready
      // c is running -> not ready
      // d is pending, dep b is not completed -> not ready
      expect(ids).toEqual(['b']);
    });

    it('returns nodes with no dependencies if pending', () => {
      graph.restoreNode(makeTask('a'));
      graph.restoreNode(makeTask('b'));

      const ready = graph.getReadyNodes();
      const ids = ready.map((n) => n.id).sort();

      expect(ids).toEqual(['a', 'b']);
    });

    it('returns empty when no nodes are ready', () => {
      graph.restoreNode(makeTask('a', [], 'running'));

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
      graph.restoreNode(makeTask('t1', [], 'pending'));
      const replacement = makeTask('t1', [], 'completed');
      graph.restoreNode(replacement);

      expect(graph.getNode('t1')!.status).toBe('completed');
    });
  });

  // ── clear ───────────────────────────────────────────────────

  describe('clear', () => {
    it('empties the graph', () => {
      graph.restoreNode(makeTask('a'));
      graph.restoreNode(makeTask('b'));
      graph.restoreNode(makeTask('c', ['a']));

      graph.clear();

      expect(graph.getAllNodes()).toEqual([]);
      expect(graph.getNodeCount()).toBe(0);
    });
  });
});
