/**
 * Tests for TaskDAG stability fixes:
 * - onNodesChange filters to only dimension/select changes
 * - Watchdog detects both missing and visibility:hidden nodes
 * - fitView prop removed (no visibility:hidden mechanism)
 * - rfNodes state syncs from task-derived nodes
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { applyNodeChanges, type Node, type NodeChange } from '@xyflow/react';

const source = readFileSync(
  resolve(__dirname, '..', 'components', 'TaskDAG.tsx'),
  'utf-8',
);

describe('TaskDAG stability', () => {
  describe('selection wiring', () => {
    it('accepts selectedTaskId in TaskDAG props', () => {
      expect(source).toContain('selectedTaskId?: string | null;');
    });

    it('marks nodes selected based on selectedTaskId', () => {
      expect(source).toContain('selected: selectedTaskId === task.id');
    });
  });

  // ── fitView prop removal ──────────────────────────────────
  describe('fitView prop removal', () => {
    it('does not pass fitView as a prop to ReactFlow', () => {
      // The ReactFlow JSX block should not contain the fitView prop.
      // Match the prop form (standalone `fitView` or `fitView=`), but not
      // the `fitView(` function call or `fitView}` closing in callbacks.
      const reactFlowBlock = source.slice(
        source.indexOf('<ReactFlow'),
        source.indexOf('</ReactFlow>'),
      );
      const hasFitViewProp =
        /\bfitView\b(?!\s*[({])/.test(reactFlowBlock) &&
        !reactFlowBlock.includes('fitView={');
      expect(hasFitViewProp).toBe(false);
    });

    it('does not pass fitViewOptions as a prop to ReactFlow', () => {
      const reactFlowBlock = source.slice(
        source.indexOf('<ReactFlow'),
        source.indexOf('</ReactFlow>'),
      );
      expect(reactFlowBlock).not.toContain('fitViewOptions');
    });

    it('passes onInit handler to ReactFlow', () => {
      const reactFlowBlock = source.slice(
        source.indexOf('<ReactFlow'),
        source.indexOf('</ReactFlow>'),
      );
      expect(reactFlowBlock).toContain('onInit={onInitHandler}');
    });
  });

  // ── onNodesChange filtering ───────────────────────────────
  describe('onNodesChange filtering', () => {
    const baseNode: Node = {
      id: 'task-1',
      type: 'taskNode',
      position: { x: 0, y: 0 },
      data: { task: {}, label: 'Test' },
    };

    function filterChanges(changes: NodeChange[]): NodeChange[] {
      return changes.filter(
        (c) => c.type === 'dimensions' || c.type === 'select',
      );
    }

    it('passes through dimension changes', () => {
      const changes: NodeChange[] = [
        {
          type: 'dimensions',
          id: 'task-1',
          dimensions: { width: 260, height: 80 },
          resizing: false,
        },
      ];
      const filtered = filterChanges(changes);
      expect(filtered).toHaveLength(1);
      expect(filtered[0].type).toBe('dimensions');
    });

    it('passes through select changes', () => {
      const changes: NodeChange[] = [
        { type: 'select', id: 'task-1', selected: true },
      ];
      const filtered = filterChanges(changes);
      expect(filtered).toHaveLength(1);
      expect(filtered[0].type).toBe('select');
    });

    it('filters out position changes', () => {
      const changes: NodeChange[] = [
        {
          type: 'position',
          id: 'task-1',
          position: { x: 100, y: 200 },
          dragging: false,
        },
      ];
      const filtered = filterChanges(changes);
      expect(filtered).toHaveLength(0);
    });

    it('filters out remove changes', () => {
      const changes: NodeChange[] = [
        { type: 'remove', id: 'task-1' },
      ];
      const filtered = filterChanges(changes);
      expect(filtered).toHaveLength(0);
    });

    it('keeps dimensions while filtering out position in mixed batch', () => {
      const changes: NodeChange[] = [
        {
          type: 'dimensions',
          id: 'task-1',
          dimensions: { width: 260, height: 80 },
          resizing: false,
        },
        {
          type: 'position',
          id: 'task-1',
          position: { x: 50, y: 50 },
          dragging: false,
        },
        { type: 'select', id: 'task-1', selected: true },
      ];
      const filtered = filterChanges(changes);
      expect(filtered).toHaveLength(2);
      expect(filtered.map((c) => c.type)).toEqual(['dimensions', 'select']);
    });

    it('applyNodeChanges preserves dimensions on existing nodes', () => {
      const nodes: Node[] = [{ ...baseNode }];
      const changes: NodeChange[] = [
        {
          type: 'dimensions',
          id: 'task-1',
          dimensions: { width: 260, height: 80 },
          resizing: false,
        },
      ];
      const updated = applyNodeChanges(changes, nodes);
      expect(updated).toHaveLength(1);
      expect(updated[0].measured).toEqual({ width: 260, height: 80 });
    });

    it('dimension changes survive a simulated task-delta re-render', () => {
      // 1. Start with task-derived nodes (no dimensions)
      let rfNodes: Node[] = [{ ...baseNode }];

      // 2. Apply dimension change (React Flow measured the node)
      const dimChanges: NodeChange[] = [
        {
          type: 'dimensions',
          id: 'task-1',
          dimensions: { width: 260, height: 80 },
          resizing: false,
        },
      ];
      const filtered = filterChanges(dimChanges);
      rfNodes = applyNodeChanges(filtered, rfNodes);
      expect(rfNodes[0].measured).toEqual({ width: 260, height: 80 });

      // 3. Task delta arrives: new node objects replace rfNodes (simulates useEffect)
      const newTaskNodes: Node[] = [
        {
          id: 'task-1',
          type: 'taskNode',
          position: { x: 0, y: 0 },
          data: { task: { status: 'running' }, label: 'Test' },
        },
      ];
      rfNodes = newTaskNodes;

      // 4. Dimensions are lost on the new objects — this is expected.
      //    React Flow will re-measure but without fitView prop it won't hide them.
      expect(rfNodes[0].measured).toBeUndefined();
    });
  });

  // ── Watchdog detection logic ──────────────────────────────
  describe('watchdog detection logic', () => {
    function shouldTrigger(
      domNodeCount: number,
      hiddenCount: number,
      propsNodeCount: number,
    ): boolean {
      return (
        (domNodeCount === 0 && propsNodeCount > 0) ||
        (hiddenCount > 0 && hiddenCount === domNodeCount)
      );
    }

    it('triggers when no DOM nodes but props have nodes', () => {
      expect(shouldTrigger(0, 0, 3)).toBe(true);
    });

    it('triggers when all DOM nodes are hidden', () => {
      expect(shouldTrigger(3, 3, 3)).toBe(true);
    });

    it('does not trigger when all nodes are visible', () => {
      expect(shouldTrigger(3, 0, 3)).toBe(false);
    });

    it('does not trigger when only some nodes are hidden', () => {
      expect(shouldTrigger(3, 1, 3)).toBe(false);
    });

    it('does not trigger when no props nodes exist', () => {
      expect(shouldTrigger(0, 0, 0)).toBe(false);
    });
  });

  // ── onNodesChange handler is wired up ─────────────────────
  describe('onNodesChange handler wiring', () => {
    it('passes onNodesChange to ReactFlow', () => {
      const reactFlowBlock = source.slice(
        source.indexOf('<ReactFlow'),
        source.indexOf('</ReactFlow>'),
      );
      expect(reactFlowBlock).toContain('onNodesChange={onNodesChange}');
    });

    it('passes rfNodes (not raw nodes) to ReactFlow', () => {
      const reactFlowBlock = source.slice(
        source.indexOf('<ReactFlow'),
        source.indexOf('</ReactFlow>'),
      );
      expect(reactFlowBlock).toContain('nodes={rfNodes}');
      expect(reactFlowBlock).not.toMatch(/nodes=\{nodes\}/);
    });
  });
});
