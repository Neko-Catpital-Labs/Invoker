import type { TaskState, WorkflowMeta } from '../types.js';

export interface WorkflowGraphNode {
  id: string;
  name: string;
  workflow: WorkflowMeta;
}

export interface WorkflowGraphEdge {
  source: string;
  target: string;
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
  const nodes: WorkflowGraphNode[] = [...workflows.values()].map((workflow) => ({
    id: workflow.id,
    name: workflow.name,
    workflow,
  }));

  const edgeKeys = new Set<string>();
  const edges: WorkflowGraphEdge[] = [];
  const missingDependencies = new Set<string>();

  for (const task of tasks.values()) {
    const targetWorkflowId = task.config.workflowId;
    if (!targetWorkflowId) continue;
    const deps = task.config.externalDependencies ?? [];
    for (const dep of deps) {
      const sourceWorkflowId = dep.workflowId;
      if (!workflows.has(sourceWorkflowId)) {
        missingDependencies.add(`${sourceWorkflowId}->${targetWorkflowId}`);
        continue;
      }
      if (sourceWorkflowId === targetWorkflowId) continue;
      const key = `${sourceWorkflowId}->${targetWorkflowId}`;
      if (edgeKeys.has(key)) continue;
      edgeKeys.add(key);
      edges.push({ source: sourceWorkflowId, target: targetWorkflowId });
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
): Map<string, WorkflowPosition> {
  const positions = new Map<string, WorkflowPosition>();
  if (graph.nodes.length === 0) return positions;

  const indegree = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  const level = new Map<string, number>();

  for (const node of graph.nodes) {
    indegree.set(node.id, 0);
    outgoing.set(node.id, []);
  }

  for (const edge of graph.edges) {
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
    outgoing.get(edge.source)?.push(edge.target);
  }

  const queue: string[] = graph.nodes
    .map((node) => node.id)
    .filter((id) => (indegree.get(id) ?? 0) === 0)
    .sort();

  if (queue.length === 0) {
    for (const node of graph.nodes) queue.push(node.id);
  }

  const visited = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);
    const currentLevel = level.get(current) ?? 0;
    for (const target of outgoing.get(current) ?? []) {
      const nextLevel = Math.max(level.get(target) ?? 0, currentLevel + 1);
      level.set(target, nextLevel);
      indegree.set(target, (indegree.get(target) ?? 0) - 1);
      if ((indegree.get(target) ?? 0) <= 0) queue.push(target);
    }
    queue.sort();
  }

  for (const node of graph.nodes) {
    if (!level.has(node.id)) level.set(node.id, 0);
  }

  const byLevel = new Map<number, WorkflowGraphNode[]>();
  for (const node of graph.nodes) {
    const nodeLevel = level.get(node.id) ?? 0;
    const bucket = byLevel.get(nodeLevel) ?? [];
    bucket.push(node);
    byLevel.set(nodeLevel, bucket);
  }

  for (const [nodeLevel, nodes] of byLevel.entries()) {
    nodes.sort((a, b) => a.name.localeCompare(b.name));
    nodes.forEach((node, index) => {
      positions.set(node.id, {
        x: 80 + nodeLevel * horizontalSpacing,
        y: 80 + index * verticalSpacing,
      });
    });
  }

  return positions;
}
