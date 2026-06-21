import type {
  ActionGraphEdge,
  ActionGraphHistoryEntry,
  ActionGraphNode,
  ActionGraphNodeStatus,
  ActionGraphResponse,
  ActivityLogEntry,
  QueueStatus,
} from '@invoker/contracts';
import type { TaskEvent, TaskLaunchDispatch, WorkflowMutationIntent, WorkflowMutationLease } from '@invoker/data-store';
import type { Attempt, TaskState } from '@invoker/workflow-core';
import type { Workflow } from '@invoker/data-store';
import type { InvokerConfig } from './config.js';

const DEFAULT_STALL_THRESHOLD_MS = 60_000;

export function resolveActionDiagnosticsStallThresholdMs(config: InvokerConfig, env = process.env): number {
  const configured = config.actionDiagnostics?.stallThresholdMs;
  if (typeof configured === 'number' && Number.isFinite(configured) && configured > 0) {
    return Math.floor(configured);
  }
  const raw = env.INVOKER_ACTION_STALL_THRESHOLD_MS;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_STALL_THRESHOLD_MS;
}

export interface ActionGraphDiagnosticsInput {
  workflows: Workflow[];
  tasks: TaskState[];
  attemptsByTaskId: Map<string, Attempt[]>;
  queueStatus: QueueStatus;
  mutationIntents: WorkflowMutationIntent[];
  mutationLeases: WorkflowMutationLease[];
  eventsByTaskId: Map<string, TaskEvent[]>;
  activityLogs: ActivityLogEntry[];
  stallThresholdMs: number;
  now?: Date;
  launchDispatches?: TaskLaunchDispatch[];
}

function iso(value: Date | string | undefined): string | undefined {
  if (!value) return undefined;
  return value instanceof Date ? value.toISOString() : value;
}

function ageMs(nowMs: number, value: Date | string | undefined): number | undefined {
  const timestamp = value instanceof Date ? value.getTime() : value ? Date.parse(value) : NaN;
  if (!Number.isFinite(timestamp)) return undefined;
  return Math.max(0, nowMs - timestamp);
}

function taskStatusToActionStatus(status: TaskState['status']): ActionGraphNodeStatus {
  switch (status) {
    case 'completed':
    case 'failed':
    case 'running':
    case 'pending':
      return status;
    case 'blocked':
    case 'needs_input':
    case 'awaiting_approval':
    case 'review_ready':
      return 'waiting';
    case 'stale':
      return 'cancelled';
    case 'closed':
      return 'failed';
    case 'fixing_with_ai':
      return 'running';
  }
}

function attemptStatusToActionStatus(status: Attempt['status']): ActionGraphNodeStatus {
  switch (status) {
    case 'completed':
    case 'failed':
    case 'running':
    case 'pending':
      return status;
    case 'claimed':
      return 'queued';
    case 'needs_input':
      return 'waiting';
    case 'superseded':
      return 'cancelled';
  }
}

function edgeId(source: string, target: string, label?: string): string {
  return `${source}->${target}${label ? `:${label}` : ''}`;
}

function compactHistory(events: TaskEvent[], activityLogs: ActivityLogEntry[]): ActionGraphHistoryEntry[] {
  const taskEvents = events.slice(-20).map((event) => ({
    id: `event:${event.id}`,
    timestamp: event.createdAt,
    source: event.eventType,
    message: event.payload ?? event.eventType,
  }));
  const logs = activityLogs.slice(-10).map((entry) => ({
    id: `activity:${entry.id}`,
    timestamp: entry.timestamp,
    source: entry.source,
    level: entry.level,
    message: entry.message,
  }));
  return [...taskEvents, ...logs].sort((a, b) => a.timestamp.localeCompare(b.timestamp)).slice(-25);
}

function addBlocker(
  nodes: ActionGraphNode[],
  edges: ActionGraphEdge[],
  blocker: ActionGraphNode,
  targetId: string,
  label = 'blocks',
): void {
  if (!nodes.some((node) => node.id === blocker.id)) {
    nodes.push(blocker);
  }
  edges.push({ id: edgeId(blocker.id, targetId, label), source: blocker.id, target: targetId, label });
}

export function buildActionGraphDiagnostics(input: ActionGraphDiagnosticsInput): ActionGraphResponse {
  const now = input.now ?? new Date();
  const nowMs = now.getTime();
  const nodes: ActionGraphNode[] = [];
  const edges: ActionGraphEdge[] = [];
  const tasksById = new Map(input.tasks.map((task) => [task.id, task]));
  const workflowsById = new Map(input.workflows.map((workflow) => [workflow.id, workflow]));
  const runningQueueIds = new Set(input.queueStatus.running.map((item) => item.taskId));
  const queuedQueueIds = new Set(input.queueStatus.queued.map((item) => item.taskId));
  const visibleAttemptIds = new Set<string>();
  for (const attempts of input.attemptsByTaskId.values()) {
    for (const attempt of attempts) visibleAttemptIds.add(attempt.id);
  }


  for (const workflow of input.workflows) {
    const actionId = `action:${workflow.id}`;
    nodes.push({
      id: actionId,
      type: 'user-action',
      label: workflow.name || workflow.id,
      status: taskStatusToActionStatus(workflow.status as TaskState['status']),
      workflowId: workflow.id,
      createdAt: workflow.createdAt,
      completedAt: workflow.status === 'completed' || workflow.status === 'failed' ? workflow.updatedAt : undefined,
      durations: workflow.status === 'pending'
        ? { pendingMs: ageMs(nowMs, workflow.createdAt) }
        : workflow.status === 'running'
          ? { runningMs: ageMs(nowMs, workflow.updatedAt) }
          : undefined,
      details: {
        baseBranch: workflow.baseBranch,
        featureBranch: workflow.featureBranch,
        mergeMode: workflow.mergeMode,
      },
      suggestedNextAction: workflow.status === 'failed' ? 'Inspect failed task blockers before retrying the workflow.' : undefined,
    });
  }

  for (const intent of input.mutationIntents) {
    const id = `intent:${intent.id}`;
    const status = intent.status === 'running' || intent.status === 'queued' || intent.status === 'completed'
      ? intent.status
      : 'failed';
    nodes.push({
      id,
      type: 'mutation-intent',
      label: intent.channel,
      status,
      workflowId: intent.workflowId,
      intentId: intent.id,
      priority: intent.priority === 'high' ? 1 : 0,
      ownerId: intent.ownerId,
      createdAt: intent.createdAt,
      startedAt: intent.startedAt,
      completedAt: intent.completedAt,
      latestError: intent.error,
      durations: {
        queuedMs: intent.status === 'queued' ? ageMs(nowMs, intent.createdAt) : undefined,
        runningMs: intent.status === 'running' ? ageMs(nowMs, intent.startedAt) : undefined,
      },
      details: { args: intent.args, priority: intent.priority },
      suggestedNextAction: intent.status === 'failed' ? 'Open the history expander and inspect the failed mutation error.' : undefined,
    });
    const workflowNodeId = `action:${intent.workflowId}`;
    if (workflowsById.has(intent.workflowId)) {
      edges.push({ id: edgeId(workflowNodeId, id, 'mutation'), source: workflowNodeId, target: id, label: 'mutation' });
    }
  }

  for (const lease of input.mutationLeases) {
    const heartbeatAge = ageMs(nowMs, lease.lastHeartbeatAt);
    const expiresAtMs = Date.parse(lease.leaseExpiresAt);
    const expired = Number.isFinite(expiresAtMs) && expiresAtMs <= nowMs;
    const heartbeatStalled = heartbeatAge !== undefined && heartbeatAge > input.stallThresholdMs;
    const status: ActionGraphNodeStatus = expired || heartbeatStalled ? 'stalled' : 'running';
    const id = `lease:${lease.workflowId}`;
    nodes.push({
      id,
      type: 'mutation-lease',
      label: lease.activeMutationKind ?? `Lease ${lease.workflowId}`,
      status,
      workflowId: lease.workflowId,
      intentId: lease.activeIntentId,
      ownerId: lease.ownerId,
      createdAt: lease.leasedAt,
      heartbeatAt: lease.lastHeartbeatAt,
      leaseExpiresAt: lease.leaseExpiresAt,
      durations: {
        heartbeatAgeMs: heartbeatAge,
        leaseExpiresInMs: Number.isFinite(expiresAtMs) ? expiresAtMs - nowMs : undefined,
        stalledMs: status === 'stalled' ? Math.max(0, heartbeatAge ?? nowMs - expiresAtMs) : undefined,
      },
      suggestedNextAction: status === 'stalled' ? 'Refresh or restart the owner process so expired mutation work can be requeued.' : undefined,
    });
    const source = lease.activeIntentId ? `intent:${lease.activeIntentId}` : `action:${lease.workflowId}`;
    edges.push({ id: edgeId(source, id, 'lease'), source, target: id, label: 'lease' });
  }

  for (const dispatch of input.launchDispatches ?? []) {
    const status: ActionGraphNodeStatus =
      dispatch.state === 'enqueued' ? 'queued'
        : dispatch.state === 'leased' ? 'running'
          : dispatch.state === 'completed' ? 'completed'
            : 'failed';
    const id = `launch-dispatch:${dispatch.id}`;
    nodes.push({
      id,
      type: 'launch-dispatch',
      label: `Launch ${dispatch.taskId}`,
      status,
      workflowId: dispatch.workflowId,
      taskId: dispatch.taskId,
      attemptId: dispatch.attemptId,
      ownerId: dispatch.dispatchOwner,
      priority: dispatch.priority === 'high' ? 1 : dispatch.priority === 'normal' ? 0 : -1,
      createdAt: dispatch.enqueuedAt,
      startedAt: dispatch.leasedAt,
      completedAt: dispatch.completedAt,
      leaseExpiresAt: dispatch.fencedUntil,
      latestError: dispatch.lastError,
      durations: {
        queuedMs: dispatch.state === 'enqueued' ? ageMs(nowMs, dispatch.enqueuedAt) : undefined,
        runningMs: dispatch.state === 'leased' ? ageMs(nowMs, dispatch.leasedAt) : undefined,
        leaseExpiresInMs: dispatch.fencedUntil ? Date.parse(dispatch.fencedUntil) - nowMs : undefined,
      },
      details: {
        state: dispatch.state,
        attemptsCount: dispatch.attemptsCount,
        generation: dispatch.generation,
      },
      suggestedNextAction: dispatch.state === 'enqueued'
        ? 'The task is queued for launch, but no owner has accepted it yet.'
        : dispatch.state === 'abandoned'
          ? 'Inspect the launch dispatch error, then retry the task if needed.'
          : undefined,
    });
    edges.push({
      id: edgeId(id, `attempt:${dispatch.attemptId}`, 'launch'),
      source: id,
      target: `attempt:${dispatch.attemptId}`,
      label: 'launch',
    });
  }

  for (const task of input.tasks) {
    const workflowId = task.config.workflowId;
    const actionId = workflowId ? `action:${workflowId}` : undefined;
    const attempts = input.attemptsByTaskId.get(task.id) ?? [];
    const selectedAttemptId = task.execution.selectedAttemptId ?? attempts.at(-1)?.id ?? task.id;
    const selectedNodeId = `attempt:${selectedAttemptId}`;
    const taskEvents = input.eventsByTaskId.get(task.id) ?? [];
    if (attempts.length === 0) {
      visibleAttemptIds.add(selectedAttemptId);
    }


    for (const attempt of attempts.length > 0 ? attempts : [{
      id: selectedAttemptId,
      nodeId: task.id,
      queuePriority: 0,
      status: task.status === 'running' ? 'running' : task.status === 'completed' ? 'completed' : task.status === 'failed' ? 'failed' : 'pending',
      upstreamAttemptIds: [],
      createdAt: task.createdAt,
      startedAt: task.execution.startedAt,
      completedAt: task.execution.completedAt,
      error: task.execution.error,
      lastHeartbeatAt: task.execution.lastHeartbeatAt,
      leaseExpiresAt: undefined,
      workspacePath: task.execution.workspacePath,
      agentSessionId: task.execution.agentSessionId,
    } satisfies Attempt]) {
      const heartbeatAge = ageMs(nowMs, attempt.lastHeartbeatAt);
      const leaseExpiresAtMs = attempt.leaseExpiresAt?.getTime() ?? NaN;
      const stalled = (attempt.status === 'running' || attempt.status === 'claimed') && (
        (Number.isFinite(leaseExpiresAtMs) && leaseExpiresAtMs <= nowMs) ||
        (heartbeatAge !== undefined && heartbeatAge > input.stallThresholdMs)
      );
      const nodeId = `attempt:${attempt.id}`;
      nodes.push({
        id: nodeId,
        type: 'task-attempt',
        label: task.description,
        status: stalled ? 'stalled' : attemptStatusToActionStatus(attempt.status),
        workflowId,
        taskId: task.id,
        attemptId: attempt.id,
        priority: attempt.queuePriority,
        createdAt: iso(attempt.createdAt),
        startedAt: iso(attempt.startedAt),
        completedAt: iso(attempt.completedAt),
        heartbeatAt: iso(attempt.lastHeartbeatAt),
        leaseExpiresAt: iso(attempt.leaseExpiresAt),
        latestError: attempt.error ?? task.execution.error,
        history: attempt.id === selectedAttemptId ? compactHistory(taskEvents, input.activityLogs) : undefined,
        durations: {
          queuedMs: queuedQueueIds.has(task.id) ? ageMs(nowMs, attempt.createdAt) : undefined,
          pendingMs: task.status === 'pending' ? ageMs(nowMs, task.createdAt) : undefined,
          runningMs: attempt.status === 'running' ? ageMs(nowMs, attempt.startedAt) : undefined,
          heartbeatAgeMs: heartbeatAge,
          stalledMs: stalled ? heartbeatAge ?? ageMs(nowMs, attempt.startedAt) : undefined,
        },
        details: {
          taskStatus: task.status,
          phase: task.execution.phase,
          workspacePath: attempt.workspacePath ?? task.execution.workspacePath,
          agentSessionId: attempt.agentSessionId ?? task.execution.agentSessionId,
          upstreamAttemptIds: attempt.upstreamAttemptIds,
        },
        suggestedNextAction: stalled
          ? 'Check the terminal session or retry the task if the process is no longer alive.'
          : task.status === 'failed'
            ? 'Open the task logs, then retry or fix with an agent.'
            : undefined,
      });

      for (const upstreamAttemptId of attempt.upstreamAttemptIds) {
        if (visibleAttemptIds.has(upstreamAttemptId)) {
          edges.push({
            id: edgeId(`attempt:${upstreamAttemptId}`, nodeId, 'upstream'),
            source: `attempt:${upstreamAttemptId}`,
            target: nodeId,
            label: 'upstream',
          });
        }
      }
    }

    if (actionId && workflowsById.has(workflowId ?? '')) {
      edges.push({ id: edgeId(actionId, selectedNodeId, 'task'), source: actionId, target: selectedNodeId, label: 'task' });
    }

    if (runningQueueIds.has(task.id) || queuedQueueIds.has(task.id)) {
      const queueItem = input.queueStatus.queued.find((item) => item.taskId === task.id);
      const schedulerId = `scheduler:${task.id}`;
      nodes.push({
        id: schedulerId,
        type: 'scheduler-job',
        label: task.description,
        status: runningQueueIds.has(task.id) ? 'running' : 'queued',
        workflowId,
        taskId: task.id,
        priority: queueItem?.priority ?? 0,
        createdAt: iso(task.createdAt),
        durations: {
          queuedMs: queuedQueueIds.has(task.id) ? ageMs(nowMs, task.createdAt) : undefined,
          runningMs: runningQueueIds.has(task.id) ? ageMs(nowMs, task.execution.startedAt) : undefined,
        },
        details: { maxConcurrency: input.queueStatus.maxConcurrency },
      });
      edges.push({ id: edgeId(schedulerId, selectedNodeId, 'dispatch'), source: schedulerId, target: selectedNodeId, label: 'dispatch' });
    }

    if (task.execution.error) {
      addBlocker(nodes, edges, {
        id: `blocker:${task.id}:error`,
        type: 'blocker',
        label: task.execution.phase === 'launching' ? 'Launch failed' : 'Task error',
        status: 'failed',
        workflowId,
        taskId: task.id,
        latestError: task.execution.error,
        createdAt: iso(task.execution.completedAt ?? task.createdAt),
        suggestedNextAction: 'Inspect the error details and retry once the root cause is fixed.',
      }, selectedNodeId);
    }

    if ((task.status === 'running' || task.status === 'failed') && !task.execution.workspacePath && task.config.runnerKind !== 'merge') {
      addBlocker(nodes, edges, {
        id: `blocker:${task.id}:workspace`,
        type: 'blocker',
        label: 'Missing workspace',
        status: 'waiting',
        workflowId,
        taskId: task.id,
        latestError: 'No workspace path is recorded for this task.',
        suggestedNextAction: 'Retry the task to reprovision its workspace.',
      }, selectedNodeId);
    }

    if (task.status === 'pending') {
      const blockerIds: string[] = [];
      for (const dependencyId of task.dependencies) {
        const dependency = tasksById.get(dependencyId);
        if (dependency?.status === 'completed') continue;
        const blockerId = `blocker:${task.id}:dependency:${dependencyId}`;
        blockerIds.push(blockerId);
        addBlocker(nodes, edges, {
          id: blockerId,
          type: 'blocker',
          label: dependency ? `Waiting for ${dependency.description}` : `Missing dependency ${dependencyId}`,
          status: 'waiting',
          workflowId,
          taskId: task.id,
          details: { dependencyId, dependencyStatus: dependency?.status ?? 'missing' },
          suggestedNextAction: dependency ? 'Resolve the upstream task first.' : 'Check whether the plan references a deleted task.',
        }, selectedNodeId);
      }
      const selectedNode = nodes.find((node) => node.id === selectedNodeId);
      if (selectedNode && blockerIds.length > 0) {
        selectedNode.blockerIds = [...(selectedNode.blockerIds ?? []), ...blockerIds];
        selectedNode.status = 'waiting';
        selectedNode.durations = { ...selectedNode.durations, waitingMs: ageMs(nowMs, task.createdAt) };
      }
    }


  }

  const uniqueEdges = new Map(edges.map((edge) => [edge.id, edge]));
  return {
    generatedAt: now.toISOString(),
    stallThresholdMs: input.stallThresholdMs,
    nodes,
    edges: [...uniqueEdges.values()],
  };
}
