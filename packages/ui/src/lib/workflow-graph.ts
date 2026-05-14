import type { TaskState, WorkflowMeta } from '../types.js';
import ELK from 'elkjs/lib/elk.bundled.js';

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

export interface WorkflowRoutePoint {
  x: number;
  y: number;
}

export interface WorkflowGraphLayout {
  positions: Map<string, WorkflowPosition>;
  edgePoints: Map<string, WorkflowRoutePoint[]>;
}

interface ElkLayoutEngine {
  layout(graph: unknown): Promise<{
    children?: Array<{ id?: string; x?: number; y?: number }>;
    edges?: unknown[];
  }>;
}

const WORKFLOW_NODE_WIDTH = 220;
const WORKFLOW_NODE_HEIGHT = 68;

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

function workflowEdgeId(edge: WorkflowGraphEdge): string {
  return `${edge.source}->${edge.target}`;
}

export async function layoutWorkflowGraphWithElk(
  graph: WorkflowGraph,
  options?: { elk?: ElkLayoutEngine },
): Promise<WorkflowGraphLayout> {
  if (graph.nodes.length === 0) {
    return { positions: new Map(), edgePoints: new Map() };
  }

  const elk = options?.elk ?? new ELK();
  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  const sortedNodes = [...graph.nodes].sort((a, b) => a.id.localeCompare(b.id));
  const sortedEdges = [...graph.edges]
    .filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target))
    .sort((a, b) => workflowEdgeId(a).localeCompare(workflowEdgeId(b)));

  const result = await elk.layout({
    id: 'workflow-graph',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.spacing.nodeNode': '70',
      'elk.layered.spacing.nodeNodeBetweenLayers': '150',
      'elk.spacing.edgeNode': '32',
      'elk.spacing.edgeEdge': '18',
      'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
    },
    children: sortedNodes.map((node) => ({
      id: node.id,
      width: WORKFLOW_NODE_WIDTH,
      height: WORKFLOW_NODE_HEIGHT,
    })),
    edges: sortedEdges.map((edge) => ({
      id: workflowEdgeId(edge),
      sources: [edge.source],
      targets: [edge.target],
    })),
  });

  const positions = new Map<string, WorkflowPosition>();
  for (const child of result.children ?? []) {
    if (typeof child.id !== 'string') continue;
    positions.set(child.id, {
      x: child.x ?? 0,
      y: child.y ?? 0,
    });
  }

  if (positions.size !== graph.nodes.length) {
    throw new Error('ELK did not return a position for every workflow');
  }

  const edgePoints = new Map<string, WorkflowRoutePoint[]>();
  const resultEdges = (result.edges ?? []) as Array<{
    id?: string;
    sections?: Array<{
      startPoint?: WorkflowRoutePoint;
      bendPoints?: WorkflowRoutePoint[];
      endPoint?: WorkflowRoutePoint;
    }>;
  }>;

  for (const edge of resultEdges) {
    if (!edge.id) continue;
    const section = edge.sections?.[0];
    if (!section?.startPoint || !section.endPoint) continue;
    edgePoints.set(edge.id, [
      { x: section.startPoint.x, y: section.startPoint.y },
      ...(section.bendPoints ?? []).map((point) => ({ x: point.x, y: point.y })),
      { x: section.endPoint.x, y: section.endPoint.y },
    ]);
  }

  return { positions, edgePoints };
}
