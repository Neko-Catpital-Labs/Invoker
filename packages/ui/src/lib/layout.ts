/**
 * DAG layout algorithm — Sugiyama-inspired layered layout.
 *
 * Computes (x, y) positions for each task node based on dependency levels.
 * Tasks at the same level are arranged vertically, levels flow left to right.
 *
 * Enhancements over a basic level assignment:
 * 1. Barycenter ordering — reorders nodes within levels to minimize edge crossings.
 * 2. Variable spacing — nodes with more connections get extra vertical padding.
 * 3. Median alignment — shifts nodes toward the median y of their neighbors
 *    for straighter edges.
 */

import type { TaskState } from '../types.js';

export interface NodePosition {
  x: number;
  y: number;
}

const NODE_WIDTH = 280;
const NODE_HEIGHT = 80;
const HORIZONTAL_GAP = 120;
const VERTICAL_GAP_BASE = 40;
const VERTICAL_GAP_PER_CONNECTION = 12;
const BARYCENTER_SWEEPS = 4;

/**
 * Computes depth levels for tasks using iterative topological approach.
 * Tasks with no dependencies are level 0.
 * A task's level = max(levels of dependencies) + 1.
 */
function computeLevels(tasks: TaskState[]): Map<string, number> {
  const levels = new Map<string, number>();
  const taskIds = new Set(tasks.map((t) => t.id));

  // Set level 0 for tasks with no dependencies (or deps outside this set)
  for (const task of tasks) {
    const internalDeps = task.dependencies.filter((d) => taskIds.has(d));
    if (internalDeps.length === 0) {
      levels.set(task.id, 0);
    }
  }

  // Iteratively calculate remaining levels
  let changed = true;
  let iterations = 0;
  const maxIterations = tasks.length + 1;

  while (changed && iterations < maxIterations) {
    changed = false;
    iterations++;

    for (const task of tasks) {
      if (levels.has(task.id)) continue;

      const internalDeps = task.dependencies.filter((d) => taskIds.has(d));
      const depLevels = internalDeps
        .map((depId) => levels.get(depId))
        .filter((l): l is number => l !== undefined);

      if (depLevels.length === internalDeps.length) {
        const maxDepLevel = depLevels.length > 0 ? Math.max(...depLevels) : -1;
        levels.set(task.id, maxDepLevel + 1);
        changed = true;
      }
    }
  }

  // Fallback: assign level 0 to any unresolved tasks
  for (const task of tasks) {
    if (!levels.has(task.id)) {
      levels.set(task.id, 0);
    }
  }

  return levels;
}

/**
 * Builds adjacency lookups: children (forward edges) and parents (backward edges).
 * Only considers edges between tasks in the provided set.
 */
function buildAdjacency(
  tasks: TaskState[],
): { children: Map<string, string[]>; parents: Map<string, string[]> } {
  const taskIds = new Set(tasks.map((t) => t.id));
  const children = new Map<string, string[]>();
  const parents = new Map<string, string[]>();

  for (const task of tasks) {
    if (!children.has(task.id)) children.set(task.id, []);
    if (!parents.has(task.id)) parents.set(task.id, []);
  }

  for (const task of tasks) {
    for (const depId of task.dependencies) {
      if (taskIds.has(depId)) {
        // depId -> task.id (parent -> child)
        children.get(depId)!.push(task.id);
        parents.get(task.id)!.push(depId);
      }
    }
  }

  return { children, parents };
}

/**
 * Counts total connections (in-degree + out-degree) for each task.
 */
function countConnections(
  tasks: TaskState[],
  children: Map<string, string[]>,
  parents: Map<string, string[]>,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const task of tasks) {
    const outDeg = children.get(task.id)?.length ?? 0;
    const inDeg = parents.get(task.id)?.length ?? 0;
    counts.set(task.id, inDeg + outDeg);
  }
  return counts;
}

/**
 * Computes the barycenter (average position) of a node's neighbors in an
 * adjacent level. Used to determine optimal ordering within a level.
 *
 * Returns undefined if the node has no neighbors in the reference level,
 * meaning the node's position should remain stable.
 */
function barycenter(
  nodeId: string,
  neighbors: string[],
  orderIndex: Map<string, number>,
): number | undefined {
  const positions: number[] = [];
  for (const nId of neighbors) {
    const idx = orderIndex.get(nId);
    if (idx !== undefined) positions.push(idx);
  }
  if (positions.length === 0) return undefined;
  return positions.reduce((a, b) => a + b, 0) / positions.length;
}

/**
 * Counts edge crossings between two adjacent levels given their current orderings.
 * An edge crossing occurs when edge (u1 -> v1) and (u2 -> v2) have
 * u1 above u2 but v1 below v2 (or vice versa).
 */
export function countCrossings(
  leftLevel: string[],
  rightLevel: string[],
  children: Map<string, string[]>,
): number {
  const rightIndex = new Map<string, number>();
  rightLevel.forEach((id, i) => rightIndex.set(id, i));

  // Collect edges as (leftIdx, rightIdx) pairs
  const edges: [number, number][] = [];
  for (let li = 0; li < leftLevel.length; li++) {
    const nodeChildren = children.get(leftLevel[li]) ?? [];
    for (const childId of nodeChildren) {
      const ri = rightIndex.get(childId);
      if (ri !== undefined) {
        edges.push([li, ri]);
      }
    }
  }

  // Count inversions: pairs where left order and right order disagree
  let crossings = 0;
  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 1; j < edges.length; j++) {
      const [l1, r1] = edges[i];
      const [l2, r2] = edges[j];
      if ((l1 - l2) * (r1 - r2) < 0) {
        crossings++;
      }
    }
  }

  return crossings;
}

/**
 * Reorders nodes within each level to minimize edge crossings using
 * the barycenter heuristic (a core step of the Sugiyama method).
 *
 * Performs alternating forward (left-to-right) and backward (right-to-left)
 * sweeps. Each sweep reorders a level based on the average position of
 * its nodes' neighbors in the adjacent fixed level.
 *
 * Only accepts a reordering if it reduces (or maintains) the crossing count.
 */
function minimizeCrossings(
  levelGroups: Map<number, TaskState[]>,
  children: Map<string, string[]>,
  parents: Map<string, string[]>,
): Map<number, TaskState[]> {
  const sortedLevels = [...levelGroups.keys()].sort((a, b) => a - b);
  if (sortedLevels.length <= 1) return levelGroups;

  // Work with mutable orderings
  const orderings = new Map<number, string[]>();
  for (const [level, group] of levelGroups) {
    orderings.set(level, group.map((t) => t.id));
  }

  const taskLookup = new Map<string, TaskState>();
  for (const group of levelGroups.values()) {
    for (const task of group) {
      taskLookup.set(task.id, task);
    }
  }

  for (let sweep = 0; sweep < BARYCENTER_SWEEPS; sweep++) {
    // Forward sweep: fix level i, reorder level i+1
    for (let i = 0; i < sortedLevels.length - 1; i++) {
      const fixedLevel = sortedLevels[i];
      const freeLevel = sortedLevels[i + 1];
      const fixedOrder = orderings.get(fixedLevel)!;
      const freeOrder = orderings.get(freeLevel)!;

      // Build index map for the fixed level
      const fixedIndex = new Map<string, number>();
      fixedOrder.forEach((id, idx) => fixedIndex.set(id, idx));

      // Compute barycenter for each node in the free level
      const barycenters = new Map<string, number | undefined>();
      for (const nodeId of freeOrder) {
        const nodeParents = (parents.get(nodeId) ?? []).filter((p) =>
          fixedIndex.has(p),
        );
        barycenters.set(nodeId, barycenter(nodeId, nodeParents, fixedIndex));
      }

      // Sort: nodes with a barycenter are ordered by it; others keep relative position
      const candidate = [...freeOrder].sort((a, b) => {
        const ba = barycenters.get(a);
        const bb = barycenters.get(b);
        if (ba !== undefined && bb !== undefined) return ba - bb;
        if (ba !== undefined) return -1;
        if (bb !== undefined) return 1;
        return 0; // preserve relative order
      });

      // Accept only if crossings don't increase
      const oldCross = countCrossings(fixedOrder, freeOrder, children);
      const newCross = countCrossings(fixedOrder, candidate, children);
      if (newCross <= oldCross) {
        orderings.set(freeLevel, candidate);
      }
    }

    // Backward sweep: fix level i, reorder level i-1
    for (let i = sortedLevels.length - 1; i > 0; i--) {
      const fixedLevel = sortedLevels[i];
      const freeLevel = sortedLevels[i - 1];
      const fixedOrder = orderings.get(fixedLevel)!;
      const freeOrder = orderings.get(freeLevel)!;

      const fixedIndex = new Map<string, number>();
      fixedOrder.forEach((id, idx) => fixedIndex.set(id, idx));

      const barycenters = new Map<string, number | undefined>();
      for (const nodeId of freeOrder) {
        const nodeChildren = (children.get(nodeId) ?? []).filter((c) =>
          fixedIndex.has(c),
        );
        barycenters.set(nodeId, barycenter(nodeId, nodeChildren, fixedIndex));
      }

      const candidate = [...freeOrder].sort((a, b) => {
        const ba = barycenters.get(a);
        const bb = barycenters.get(b);
        if (ba !== undefined && bb !== undefined) return ba - bb;
        if (ba !== undefined) return -1;
        if (bb !== undefined) return 1;
        return 0;
      });

      const oldCross = countCrossings(candidate, fixedOrder, children);
      const newCross = countCrossings(freeOrder, fixedOrder, children);
      // For backward sweep: the "free" level is the left level
      const oldCrossCheck = countCrossings(freeOrder, fixedOrder, children);
      const newCrossCheck = countCrossings(candidate, fixedOrder, children);
      if (newCrossCheck <= oldCrossCheck) {
        orderings.set(freeLevel, candidate);
      }
    }
  }

  // Convert back to TaskState arrays
  const result = new Map<number, TaskState[]>();
  for (const [level, order] of orderings) {
    result.set(
      level,
      order.map((id) => taskLookup.get(id)!),
    );
  }
  return result;
}

/**
 * Computes the vertical gap for a node based on its connection count.
 * Nodes with more edges get extra spacing to reduce visual clutter around them.
 */
function verticalGapForNode(connectionCount: number): number {
  return VERTICAL_GAP_BASE + Math.max(0, connectionCount - 1) * VERTICAL_GAP_PER_CONNECTION;
}

/**
 * Computes the median y-position of a node's neighbors in adjacent levels.
 * Returns undefined if the node has no positioned neighbors.
 */
function medianNeighborY(
  nodeId: string,
  parents: Map<string, string[]>,
  children: Map<string, string[]>,
  positions: Map<string, NodePosition>,
): number | undefined {
  const neighborIds = [
    ...(parents.get(nodeId) ?? []),
    ...(children.get(nodeId) ?? []),
  ];
  const ys: number[] = [];
  for (const nId of neighborIds) {
    const pos = positions.get(nId);
    if (pos) ys.push(pos.y);
  }
  if (ys.length === 0) return undefined;
  ys.sort((a, b) => a - b);
  const mid = Math.floor(ys.length / 2);
  return ys.length % 2 === 1 ? ys[mid] : (ys[mid - 1] + ys[mid]) / 2;
}

/**
 * Positions nodes in a left-to-right flow using a Sugiyama-inspired algorithm:
 *
 * 1. Assign levels via topological sort (computeLevels).
 * 2. Reorder nodes within levels to minimize edge crossings (barycenter heuristic).
 * 3. Place nodes with variable vertical spacing (more connections = more space).
 * 4. Adjust y-positions toward the median of connected neighbors for alignment.
 */
export function layoutNodes(
  tasks: TaskState[],
): Map<string, NodePosition> {
  const positions = new Map<string, NodePosition>();

  if (tasks.length === 0) return positions;

  // Sort by id so level grouping and barycenter tie-breaks are deterministic regardless of caller order.
  const sorted = [...tasks].sort((a, b) => a.id.localeCompare(b.id));

  const levels = computeLevels(sorted);
  const { children, parents } = buildAdjacency(sorted);
  const connections = countConnections(sorted, children, parents);

  // Group tasks by level
  let levelGroups = new Map<number, TaskState[]>();
  for (const task of sorted) {
    const level = levels.get(task.id) ?? 0;
    if (!levelGroups.has(level)) levelGroups.set(level, []);
    levelGroups.get(level)!.push(task);
  }

  // Step 2: Minimize crossings via barycenter ordering
  levelGroups = minimizeCrossings(levelGroups, children, parents);

  // Step 3: Initial placement with variable spacing
  for (const [level, tasksAtLevel] of levelGroups) {
    // Compute per-node gaps based on connection count
    const gaps: number[] = [];
    for (let i = 0; i < tasksAtLevel.length; i++) {
      const conn = connections.get(tasksAtLevel[i].id) ?? 0;
      gaps.push(verticalGapForNode(conn));
    }

    // Total height: sum of node heights + sum of gaps between nodes
    let totalHeight = tasksAtLevel.length * NODE_HEIGHT;
    for (let i = 0; i < tasksAtLevel.length - 1; i++) {
      // Gap between node i and node i+1: use the larger of the two adjacent gaps
      totalHeight += Math.max(gaps[i], gaps[i + 1]);
    }

    const startY = -totalHeight / 2;
    let currentY = startY;

    for (let i = 0; i < tasksAtLevel.length; i++) {
      const task = tasksAtLevel[i];
      positions.set(task.id, {
        x: level * (NODE_WIDTH + HORIZONTAL_GAP),
        y: currentY,
      });
      if (i < tasksAtLevel.length - 1) {
        currentY += NODE_HEIGHT + Math.max(gaps[i], gaps[i + 1]);
      }
    }
  }

  // Step 4: Median alignment pass — nudge nodes toward their neighbors' median y.
  // Process levels left-to-right, then right-to-left.
  const sortedLevels = [...levelGroups.keys()].sort((a, b) => a - b);

  for (const direction of ['forward', 'backward'] as const) {
    const levelOrder =
      direction === 'forward' ? sortedLevels : [...sortedLevels].reverse();

    for (const level of levelOrder) {
      const tasksAtLevel = levelGroups.get(level)!;
      if (tasksAtLevel.length <= 1) continue;

      // Compute desired y for each node
      const desired: { id: string; y: number }[] = [];
      for (const task of tasksAtLevel) {
        const medY = medianNeighborY(task.id, parents, children, positions);
        if (medY !== undefined) {
          desired.push({ id: task.id, y: medY });
        } else {
          desired.push({ id: task.id, y: positions.get(task.id)!.y });
        }
      }

      // Apply desired positions while maintaining minimum spacing and ordering.
      // Sort desired by current ordering index (don't reorder, just shift).
      for (let i = 0; i < desired.length; i++) {
        const conn = connections.get(desired[i].id) ?? 0;
        const gap = verticalGapForNode(conn);
        let newY = desired[i].y;

        // Ensure no overlap with the previous node
        if (i > 0) {
          const prevPos = positions.get(desired[i - 1].id)!;
          const prevConn = connections.get(desired[i - 1].id) ?? 0;
          const minGap = Math.max(gap, verticalGapForNode(prevConn));
          const minY = prevPos.y + NODE_HEIGHT + minGap;
          newY = Math.max(newY, minY);
        }

        positions.set(desired[i].id, {
          x: positions.get(desired[i].id)!.x,
          y: newY,
        });
      }
    }
  }

  return positions;
}
