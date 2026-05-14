/**
 * Task DAG layout powered by ELK layered routing.
 */

import ELK from 'elkjs/lib/elk.bundled.js';

import type { TaskState } from '../types.js';

export interface NodePosition {
  x: number;
  y: number;
}

export interface LayoutEdge {
  id?: string;
  source: string;
  target: string;
}

export interface RoutedEdgePoint {
  x: number;
  y: number;
}

export interface TaskGraphLayout {
  positions: Map<string, NodePosition>;
  edgePoints: Map<string, RoutedEdgePoint[]>;
}

interface ElkLayoutEngine {
  layout(graph: unknown): Promise<{
    children?: Array<{ id?: string; x?: number; y?: number }>;
    edges?: unknown[];
  }>;
}

const NODE_WIDTH = 280;
const NODE_HEIGHT = 80;

function edgeLayoutId(edge: LayoutEdge): string {
  return edge.id ?? `${edge.source}->${edge.target}`;
}

/**
 * Computes production Task DAG layout with ELK layered routing.
 *
 * ELK returns top-left node positions and edge sections with explicit bend
 * points. ELK failures are surfaced to the caller; this is a hard cutover.
 */
export async function layoutTaskGraph(
  tasks: TaskState[],
  edges: LayoutEdge[],
  options?: { elk?: ElkLayoutEngine },
): Promise<TaskGraphLayout> {
  if (tasks.length === 0) {
    return { positions: new Map(), edgePoints: new Map() };
  }

  const sortedTasks = [...tasks].sort((a, b) => a.id.localeCompare(b.id));
  const taskIds = new Set(sortedTasks.map((task) => task.id));
  const sortedEdges = [...edges]
    .filter((edge) => taskIds.has(edge.source) && taskIds.has(edge.target))
    .sort((a, b) => edgeLayoutId(a).localeCompare(edgeLayoutId(b)));

  const elk = options?.elk ?? new ELK();
  const graph = {
    id: 'task-dag',
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
    children: sortedTasks.map((task) => ({
      id: task.id,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
    })),
    edges: sortedEdges.map((edge) => ({
      id: edgeLayoutId(edge),
      sources: [edge.source],
      targets: [edge.target],
    })),
  };

  const result = await elk.layout(graph);
  const positions = new Map<string, NodePosition>();
  for (const child of result.children ?? []) {
    if (typeof child.id !== 'string') continue;
    positions.set(child.id, {
      x: child.x ?? 0,
      y: child.y ?? 0,
    });
  }

  if (positions.size !== sortedTasks.length) {
    throw new Error('ELK did not return a position for every task');
  }

  const edgePoints = new Map<string, RoutedEdgePoint[]>();
  const resultEdges = (result.edges ?? []) as Array<{
    id?: string;
    sections?: Array<{
      startPoint?: RoutedEdgePoint;
      bendPoints?: RoutedEdgePoint[];
      endPoint?: RoutedEdgePoint;
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
