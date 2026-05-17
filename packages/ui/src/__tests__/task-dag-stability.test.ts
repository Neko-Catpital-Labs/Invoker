/**
 * Tests for TaskDAG stability fixes:
 * - onNodesChange filters to only dimension/select changes
 * - Watchdog detects both missing and visibility:hidden nodes
 * - fitView prop removed (no visibility:hidden mechanism)
 * - rfNodes state preserves measured dimensions from task-derived node updates
 */

import { describe, it, expect } from 'vitest';
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

    function mergeMeasuredNodeState(prevNodes: Node[], nextNodes: Node[]): Node[] {
      const previousById = new Map(prevNodes.map((node) => [node.id, node]));

      return nextNodes.map((node) => {
        const previous = previousById.get(node.id);
        if (!previous) return node;

        return {
          ...node,
          ...(previous.measured ? { measured: previous.measured } : {}),
          ...(previous.width !== undefined ? { width: previous.width } : {}),
          ...(previous.height !== undefined ? { height: previous.height } : {}),
        };
      });
    }

    it('preserves dimensions across a simulated task-delta re-render', () => {
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
      rfNodes = mergeMeasuredNodeState(rfNodes, newTaskNodes);

      // 4. Dimensions are retained so React Flow does not need to re-measure
      //    existing nodes after each status/task data update.
      expect(rfNodes[0].measured).toEqual({ width: 260, height: 80 });
      expect(rfNodes[0].data).toEqual({ task: { status: 'running' }, label: 'Test' });
    });

    it('wires task-derived node sync through measured-state merge', () => {
      expect(source).toContain('mergeMeasuredNodeState(prev, nodes)');
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

    function shouldRecover(missCount: number, recoveryAttempted: boolean): boolean {
      return missCount >= 3 && !recoveryAttempted;
    }

    it('does not recover before repeated watchdog misses', () => {
      expect(shouldRecover(1, false)).toBe(false);
      expect(shouldRecover(2, false)).toBe(false);
    });

    it('recovers once after repeated watchdog misses', () => {
      expect(shouldRecover(3, false)).toBe(true);
      expect(shouldRecover(4, true)).toBe(false);
    });

    it('logs watchdog miss and recovery state', () => {
      expect(source).toContain('missCount: watchdogMissCountRef.current');
      expect(source).toContain('recoveryAttempted: watchdogRecoveryAttemptedRef.current');
      expect(source).toContain('recoveryTriggered: shouldRecover');
    });

    it('remounts React Flow for bounded watchdog recovery', () => {
      const reactFlowBlock = source.slice(
        source.indexOf('<ReactFlow'),
        source.indexOf('</ReactFlow>'),
      );
      expect(source).toContain('const WATCHDOG_RECOVERY_MISS_COUNT = 3;');
      expect(source).toContain('setFlowInstanceKey((key) => key + 1)');
      expect(reactFlowBlock).toContain('key={flowInstanceKey}');
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
