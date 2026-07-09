import type { ActionGraphNode } from '@invoker/contracts';

export type WorkflowCoreActivityStatus = 'pending' | 'running' | 'failed' | 'stalled';

export interface WorkflowCoreActivity {
  workflowId: string;
  status: WorkflowCoreActivityStatus;
  label: string;
  nodeId: string;
  nodeType: ActionGraphNode['type'];
  taskId?: string;
  durationMs?: number;
}

type Candidate = WorkflowCoreActivity & { rank: number; sortTime: number };

const IGNORED_NODE_TYPES = new Set<ActionGraphNode['type']>([
  'mutation-intent',
  'mutation-lease',
  'user-action',
]);

function timestampMs(node: ActionGraphNode): number {
  const raw = node.startedAt ?? node.createdAt;
  if (!raw) return 0;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function durationMs(node: ActionGraphNode): number | undefined {
  return node.durations?.runningMs
    ?? node.durations?.queuedMs
    ?? node.durations?.pendingMs
    ?? node.durations?.stalledMs;
}

function candidateForNode(node: ActionGraphNode): Candidate | undefined {
  const workflowId = node.workflowId;
  if (!workflowId || IGNORED_NODE_TYPES.has(node.type)) return undefined;

  let rank: number | undefined;
  let status: WorkflowCoreActivityStatus | undefined;
  let label: string | undefined;

  if (node.type === 'blocker' && node.status === 'failed') {
    rank = 1;
    status = 'failed';
    label = 'Failed: see details';
  } else if (node.type === 'task-attempt' && node.status === 'stalled') {
    rank = 2;
    status = 'stalled';
    label = 'Stalled: task heartbeat lost';
  } else if (node.type === 'task-attempt' && node.status === 'running') {
    rank = 3;
    status = 'running';
    label = 'Running: task executing';
  } else if (node.type === 'launch-dispatch' && node.status === 'running') {
    rank = 4;
    status = 'pending';
    label = 'Pending: launch accepted';
  } else if (node.type === 'launch-dispatch' && node.status === 'queued') {
    rank = 5;
    status = 'pending';
    label = 'Pending: queued for launch';
  } else if (node.type === 'scheduler-job' && node.status === 'running') {
    rank = 6;
    status = 'pending';
    label = 'Pending: scheduler dispatching';
  } else if (node.type === 'scheduler-job' && node.status === 'queued') {
    rank = 7;
    status = 'pending';
    label = 'Pending: scheduler queued';
  } else if (
    node.type === 'task-attempt'
    && node.status === 'pending'
    && node.details?.phase === 'launching'
  ) {
    rank = 8;
    status = 'pending';
    label = 'Pending: task launch';
  }

  if (rank === undefined || !status || !label) return undefined;
  return {
    workflowId,
    status,
    label,
    nodeId: node.id,
    nodeType: node.type,
    taskId: node.taskId,
    durationMs: durationMs(node),
    rank,
    sortTime: timestampMs(node),
  };
}

function betterCandidate(current: Candidate | undefined, next: Candidate): Candidate {
  if (!current) return next;
  if (next.rank < current.rank) return next;
  if (next.rank > current.rank) return current;
  return next.sortTime > current.sortTime ? next : current;
}

function stripCandidate(candidate: Candidate): WorkflowCoreActivity {
  const { rank: _rank, sortTime: _sortTime, ...activity } = candidate;
  return activity;
}

export function selectWorkflowCoreActivity(
  nodes: readonly ActionGraphNode[],
  workflowId: string,
): WorkflowCoreActivity | undefined {
  let selected: Candidate | undefined;
  for (const node of nodes) {
    if (node.workflowId !== workflowId) continue;
    const candidate = candidateForNode(node);
    if (!candidate) continue;
    selected = betterCandidate(selected, candidate);
  }
  return selected ? stripCandidate(selected) : undefined;
}

export function groupWorkflowCoreActivity(
  nodes: readonly ActionGraphNode[],
): Map<string, WorkflowCoreActivity> {
  const selected = new Map<string, Candidate>();
  for (const node of nodes) {
    const candidate = candidateForNode(node);
    if (!candidate) continue;
    selected.set(candidate.workflowId, betterCandidate(selected.get(candidate.workflowId), candidate));
  }
  return new Map([...selected.entries()].map(([workflowId, candidate]) => [workflowId, stripCandidate(candidate)]));
}
