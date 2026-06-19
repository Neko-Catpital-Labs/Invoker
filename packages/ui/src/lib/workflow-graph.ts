import { computeWorkflowRollupFromSummaries } from '@invoker/workflow-graph';
import type { TaskState, WorkflowMeta } from '../types.js';

export interface WorkflowGraphNode {
  id: string;
  name: string;
  workflow: WorkflowMeta;
}

export interface WorkflowGraphEdge {
  source: string;
  target: string;
  kind: 'active' | 'historical';
}

export interface WorkflowGraph {
  nodes: WorkflowGraphNode[];
  edges: WorkflowGraphEdge[];
  missingDependencies: string[];
}

export interface WorkflowPosition {
  x: number;
  y: number;
}

export function deriveWorkflowGraph(
  workflows: Map<string, WorkflowMeta>,
  tasks: Map<string, TaskState>,
): WorkflowGraph {
  const workflowNodes = new Map(workflows);
  const fallbackTasksByWorkflow = new Map<string, TaskState[]>();

  for (const task of tasks.values()) {
    const workflowId = task.config.workflowId;
    if (!workflowId || workflowNodes.has(workflowId)) continue;
    const workflowTasks = fallbackTasksByWorkflow.get(workflowId);
    if (workflowTasks) {
      workflowTasks.push(task);
    } else {
      fallbackTasksByWorkflow.set(workflowId, [task]);
    }
  }

  for (const [workflowId, workflowTasks] of fallbackTasksByWorkflow) {
    const rollup = computeWorkflowRollupFromSummaries(workflowTasks.map((task) => ({
      id: task.id,
      description: task.description,
      status: task.status,
      dependencies: task.dependencies,
      execution: task.execution,
    })));
    workflowNodes.set(workflowId, {
      id: workflowId,
      name: workflowId,
      status: rollup.status,
      rollup,
    });
  }

  const nodes: WorkflowGraphNode[] = [...workflowNodes.values()].map((workflow) => ({
    id: workflow.id,
    name: workflow.name,
    workflow,
  }));

  const edgeKeys = new Set<string>();
  const edges: WorkflowGraphEdge[] = [];
  const missingDependencies = new Set<string>();

  for (const workflow of workflowNodes.values()) {
    const targetWorkflowId = workflow.id;
    for (const dep of workflow.externalDependencies ?? []) {
      const sourceWorkflowId = dep.workflowId;
      if (!workflowNodes.has(sourceWorkflowId)) {
        missingDependencies.add(`${sourceWorkflowId}->${targetWorkflowId}`);
        continue;
      }
      if (sourceWorkflowId === targetWorkflowId) continue;
      const key = `active:${sourceWorkflowId}->${targetWorkflowId}`;
      if (edgeKeys.has(key)) continue;
      edgeKeys.add(key);
      edges.push({ source: sourceWorkflowId, target: targetWorkflowId, kind: 'active' });
    }
    for (const change of workflow.externalDependencyChanges ?? []) {
      for (const dependency of [change.before, change.after]) {
        if (!dependency) continue;
        const sourceWorkflowId = dependency.workflowId;
        if (!workflowNodes.has(sourceWorkflowId)) {
          missingDependencies.add(`${sourceWorkflowId}->${targetWorkflowId}`);
          continue;
        }
        if (sourceWorkflowId === targetWorkflowId) continue;
        if (edgeKeys.has(`active:${sourceWorkflowId}->${targetWorkflowId}`)) continue;
        const key = `historical:${sourceWorkflowId}->${targetWorkflowId}`;
        if (edgeKeys.has(key)) continue;
        edgeKeys.add(key);
        edges.push({ source: sourceWorkflowId, target: targetWorkflowId, kind: 'historical' });
      }
    }
  }

  return {
    nodes: nodes.sort((a, b) => a.name.localeCompare(b.name)),
    edges,
    missingDependencies: [...missingDependencies].sort(),
  };
}

export function layoutWorkflowGraph(
  graph: WorkflowGraph,
  horizontalSpacing = 280,
  verticalSpacing = 150,
  componentGap = 120,
): Map<string, WorkflowPosition> {
  const positions = new Map<string, WorkflowPosition>();
  if (graph.nodes.length === 0) return positions;

  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const outgoing = createNodeMap<string[]>(graph.nodes, []);
  const incoming = createNodeMap<string[]>(graph.nodes, []);
  const weakAdjacency = createNodeMap<string[]>(graph.nodes, []);

  for (const edge of graph.edges) {
    if (!nodesById.has(edge.source) || !nodesById.has(edge.target)) continue;
    outgoing.get(edge.source)?.push(edge.target);
    incoming.get(edge.target)?.push(edge.source);
    weakAdjacency.get(edge.source)?.push(edge.target);
    weakAdjacency.get(edge.target)?.push(edge.source);
  }

  const components = findWorkflowComponents(graph.nodes, weakAdjacency)
    .sort((a, b) => compareComponentsNewestFirst(a, b));

  let componentYOffset = 80;
  for (const component of components) {
    const componentIds = new Set(component.map((node) => node.id));
    const levels = assignDependencyLevels(component, outgoing, componentIds);
    const orderedLevels = orderComponentLevels(component, levels, incoming, outgoing);
    const maxRows = Math.max(1, ...[...orderedLevels.values()].map((nodes) => nodes.length));

    for (const [nodeLevel, nodes] of orderedLevels.entries()) {
      nodes.forEach((node, index) => {
        positions.set(node.id, {
          x: 80 + nodeLevel * horizontalSpacing,
          y: componentYOffset + index * verticalSpacing,
        });
      });
    }

    componentYOffset += maxRows * verticalSpacing + componentGap;
  }

  return positions;
}

function createNodeMap<T>(nodes: WorkflowGraphNode[], initialValue: T): Map<string, T> {
  const map = new Map<string, T>();
  for (const node of nodes) {
    map.set(node.id, Array.isArray(initialValue) ? ([...initialValue] as T) : initialValue);
  }
  return map;
}

function findWorkflowComponents(
  nodes: WorkflowGraphNode[],
  weakAdjacency: Map<string, string[]>,
): WorkflowGraphNode[][] {
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const visited = new Set<string>();
  const components: WorkflowGraphNode[][] = [];

  for (const node of nodes) {
    if (visited.has(node.id)) continue;
    const component: WorkflowGraphNode[] = [];
    const queue = [node.id];
    visited.add(node.id);

    while (queue.length > 0) {
      const current = queue.shift()!;
      const currentNode = nodesById.get(current);
      if (currentNode) component.push(currentNode);
      for (const next of weakAdjacency.get(current) ?? []) {
        if (visited.has(next)) continue;
        visited.add(next);
        queue.push(next);
      }
      queue.sort(compareIds);
    }

    components.push(component.sort(compareNodesByNameId));
  }

  return components;
}

function compareComponentsNewestFirst(a: WorkflowGraphNode[], b: WorkflowGraphNode[]): number {
  const aTimestamp = componentTimestamp(a);
  const bTimestamp = componentTimestamp(b);
  if (aTimestamp !== bTimestamp) return bTimestamp - aTimestamp;
  return componentSortKey(a).localeCompare(componentSortKey(b));
}

function componentTimestamp(nodes: WorkflowGraphNode[]): number {
  const timestamps = nodes
    .map((node) => parseWorkflowTimestamp(node.workflow.createdAt))
    .filter((timestamp) => timestamp !== null);
  return timestamps.length > 0 ? Math.max(...timestamps) : Number.NEGATIVE_INFINITY;
}

function parseWorkflowTimestamp(value: string | undefined): number | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function componentSortKey(nodes: WorkflowGraphNode[]): string {
  return [...nodes]
    .sort(compareNodesByNameId)
    .map((node) => `${node.name}\u0000${node.id}`)
    .join('\u0001');
}

function assignDependencyLevels(
  nodes: WorkflowGraphNode[],
  outgoing: Map<string, string[]>,
  componentIds: Set<string>,
): Map<string, number> {
  const indegree = new Map<string, number>();
  const level = new Map<string, number>();

  for (const node of nodes) indegree.set(node.id, 0);
  for (const node of nodes) {
    for (const target of outgoing.get(node.id) ?? []) {
      if (!componentIds.has(target)) continue;
      indegree.set(target, (indegree.get(target) ?? 0) + 1);
    }
  }

  const queue = nodes
    .map((node) => node.id)
    .filter((id) => (indegree.get(id) ?? 0) === 0)
    .sort(compareIds);

  if (queue.length === 0) {
    for (const node of nodes) queue.push(node.id);
  }

  const visited = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);
    const currentLevel = level.get(current) ?? 0;
    for (const target of outgoing.get(current) ?? []) {
      if (!componentIds.has(target)) continue;
      const nextLevel = Math.max(level.get(target) ?? 0, currentLevel + 1);
      level.set(target, nextLevel);
      indegree.set(target, (indegree.get(target) ?? 0) - 1);
      if ((indegree.get(target) ?? 0) <= 0) queue.push(target);
    }
    queue.sort(compareIds);
  }

  for (const node of nodes) {
    if (!level.has(node.id)) level.set(node.id, 0);
  }

  return level;
}

function orderComponentLevels(
  nodes: WorkflowGraphNode[],
  level: Map<string, number>,
  incoming: Map<string, string[]>,
  outgoing: Map<string, string[]>,
): Map<number, WorkflowGraphNode[]> {
  const byLevel = new Map<number, WorkflowGraphNode[]>();
  for (const node of nodes) {
    const nodeLevel = level.get(node.id) ?? 0;
    const bucket = byLevel.get(nodeLevel) ?? [];
    bucket.push(node);
    byLevel.set(nodeLevel, bucket);
  }

  const levelNumbers = [...byLevel.keys()].sort((a, b) => a - b);
  for (const nodeLevel of levelNumbers) {
    byLevel.get(nodeLevel)?.sort(compareNodesByNameId);
  }

  for (let iteration = 0; iteration < 4; iteration += 1) {
    for (const nodeLevel of levelNumbers) {
      sortLevelByBarycenter(byLevel, nodeLevel, incoming.get.bind(incoming));
    }
    for (const nodeLevel of [...levelNumbers].reverse()) {
      sortLevelByBarycenter(byLevel, nodeLevel, outgoing.get.bind(outgoing));
    }
  }

  return new Map(levelNumbers.map((nodeLevel) => [nodeLevel, byLevel.get(nodeLevel) ?? []]));
}

function sortLevelByBarycenter(
  byLevel: Map<number, WorkflowGraphNode[]>,
  nodeLevel: number,
  getNeighborIds: (id: string) => string[] | undefined,
): void {
  const nodes = byLevel.get(nodeLevel);
  if (!nodes || nodes.length <= 1) return;

  const originalIndex = new Map(nodes.map((node, index) => [node.id, index]));
  const indexById = new Map<string, number>();
  for (const levelNodes of byLevel.values()) {
    levelNodes.forEach((node, index) => indexById.set(node.id, index));
  }

  nodes.sort((a, b) => {
    const aBarycenter = barycenter(a.id, getNeighborIds, indexById);
    const bBarycenter = barycenter(b.id, getNeighborIds, indexById);
    if (aBarycenter !== bBarycenter) return aBarycenter - bBarycenter;
    return (originalIndex.get(a.id) ?? 0) - (originalIndex.get(b.id) ?? 0) || compareNodesByNameId(a, b);
  });
}

function barycenter(
  nodeId: string,
  getNeighborIds: (id: string) => string[] | undefined,
  indexById: Map<string, number>,
): number {
  const neighborIndexes = (getNeighborIds(nodeId) ?? [])
    .map((neighborId) => indexById.get(neighborId))
    .filter((index): index is number => index !== undefined);
  if (neighborIndexes.length === 0) return Number.POSITIVE_INFINITY;
  return neighborIndexes.reduce((sum, index) => sum + index, 0) / neighborIndexes.length;
}

function compareNodesByNameId(a: WorkflowGraphNode, b: WorkflowGraphNode): number {
  return a.name.localeCompare(b.name) || compareIds(a.id, b.id);
}

function compareIds(a: string, b: string): number {
  return a.localeCompare(b);
}
