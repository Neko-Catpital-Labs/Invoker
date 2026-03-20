/**
 * Extracted graph-mutation primitives.
 *
 * These functions implement structural graph mutations (fork, reconcile,
 * apply) as standalone functions that operate on a `GraphMutationHost`.
 * The Orchestrator delegates to them, keeping the methods on the class
 * for API compatibility.
 */

import type { TaskState, TaskDelta, TaskStateChanges } from './task-types.js';
import type { GraphMutation, OrchestratorPersistence, OrchestratorMessageBus } from './orchestrator.js';
import { createTaskState } from './task-types.js';
import { getTransitiveDependents, nextVersion, findLeafTaskIds } from './dag.js';

const TASK_DELTA_CHANNEL = 'task.delta';

// ── Host Interface ──────────────────────────────────────────

/**
 * Subset of Orchestrator that the graph-mutation functions need.
 * Keeps the extracted functions decoupled from the full Orchestrator class.
 */
export interface GraphMutationHost {
  stateMachine: {
    getAllTasks(): TaskState[];
    getTask(id: string): TaskState | undefined;
    restoreTask(task: TaskState): void;
  };
  persistence: OrchestratorPersistence;
  messageBus: OrchestratorMessageBus;
  writeAndSync(taskId: string, changes: TaskStateChanges): TaskState;
  createAndSync(task: TaskState): TaskState;
  getMergeNode(workflowId: string): TaskState | undefined;
}

// ── Extracted Functions ─────────────────────────────────────

/**
 * Fork the subtree downstream of a dirty task.
 *
 * @param depOverrides Optional map of dependency ID replacements applied
 *   before the clone ID map. Use this to point forked clones at a
 *   replacement node instead of the original dirty task.
 */
export function forkDirtySubtreeImpl(
  host: GraphMutationHost,
  dirtyTaskId: string,
  depOverrides?: Map<string, string>,
): TaskDelta[] {
  const allTasks = host.stateMachine.getAllTasks();
  const taskMap = new Map(allTasks.map((t) => [t.id, t]));

  // Skip merge nodes: they are terminal and should not be forked
  const descendantIds = getTransitiveDependents(
    dirtyTaskId,
    taskMap,
    (t) => !!t.config.isMergeNode,
  );
  if (descendantIds.length === 0) {
    // No non-merge descendants; reconcile merge leaves from graph state
    const dirtyTask = taskMap.get(dirtyTaskId);
    if (dirtyTask?.config.workflowId) {
      reconcileMergeLeavesImpl(host, dirtyTask.config.workflowId);
    }
    return [];
  }

  const deltas: TaskDelta[] = [];

  // Mark descendants as stale
  for (const id of descendantIds) {
    const t = host.stateMachine.getTask(id);
    if (!t) continue;
    const staleChanges: TaskStateChanges = { status: 'stale' };
    host.writeAndSync(id, staleChanges);
    const delta: TaskDelta = { type: 'updated', taskId: id, changes: staleChanges };
    host.persistence.logEvent?.(id, 'task.stale', staleChanges);
    host.messageBus.publish(TASK_DELTA_CHANNEL, delta);
    deltas.push(delta);
  }

  // Build ID mapping: original → clone
  const idMap = new Map<string, string>();
  for (const id of descendantIds) {
    idMap.set(id, nextVersion(id));
  }

  // Create cloned tasks with remapped dependencies
  for (const originalId of descendantIds) {
    const original = taskMap.get(originalId);
    if (!original) continue;

    const cloneId = idMap.get(originalId)!;
    const remappedDeps = original.dependencies.map((dep) =>
      depOverrides?.get(dep) ?? idMap.get(dep) ?? dep,
    );

    const cloneTask = createTaskState(cloneId, original.description, remappedDeps as string[], original.config);

    host.createAndSync(cloneTask);
    const delta: TaskDelta = { type: 'created', task: cloneTask };
    host.persistence.logEvent?.(cloneId, 'task.created');
    host.messageBus.publish(TASK_DELTA_CHANNEL, delta);
    deltas.push(delta);
  }

  // Reconcile merge node deps from actual graph state
  const dirtyTask = taskMap.get(dirtyTaskId);
  if (dirtyTask?.config.workflowId) {
    reconcileMergeLeavesImpl(host, dirtyTask.config.workflowId);
  }

  return deltas;
}

/**
 * Recompute the merge node's dependencies from the actual graph state.
 * Active (non-stale, non-merge) leaf tasks become the merge gate's deps.
 * No-ops if deps are already correct.
 */
export function reconcileMergeLeavesImpl(host: GraphMutationHost, workflowId: string): void {
  const mergeNode = host.getMergeNode(workflowId);
  if (!mergeNode) return;

  const allTasks = host.stateMachine.getAllTasks();
  const activeTasks = allTasks.filter(
    (t) =>
      t.config.workflowId === workflowId &&
      !t.config.isMergeNode &&
      t.status !== 'stale',
  );
  const leafIds = findLeafTaskIds(activeTasks);

  const currentDeps = new Set(mergeNode.dependencies);
  const newDepsSet = new Set(leafIds);
  if (
    currentDeps.size === newDepsSet.size &&
    [...currentDeps].every((d) => newDepsSet.has(d))
  ) {
    return;
  }

  const changes: TaskStateChanges = {
    dependencies: leafIds,
    status: 'pending',
    execution: { blockedBy: undefined },
  };
  host.writeAndSync(mergeNode.id, changes);
  host.messageBus.publish(TASK_DELTA_CHANNEL, {
    type: 'updated',
    taskId: mergeNode.id,
    changes,
  });
}

/**
 * Shared primitive for structural graph mutations (experiments, replacement).
 *
 * Order matters:
 *   1. Fork downstream FIRST (before creating new nodes, so new nodes
 *      aren't included in the descendant set)
 *   2. Apply source disposition (complete or stale)
 *   3. Create all new nodes
 */
export function applyGraphMutationImpl(host: GraphMutationHost, mutation: GraphMutation): TaskDelta[] {
  const allDeltas: TaskDelta[] = [];

  // 1. Fork downstream with dep override: sourceNode → outputNode
  const forkDeltas = forkDirtySubtreeImpl(
    host,
    mutation.sourceNodeId,
    new Map([[mutation.sourceNodeId, mutation.outputNodeId]]),
  );
  allDeltas.push(...forkDeltas);

  // 2. Apply source disposition
  const baseChanges: TaskStateChanges = mutation.sourceDisposition === 'complete'
    ? { status: 'completed' as const, execution: { completedAt: new Date() } }
    : { status: 'stale' as const };
  const sourceChanges: TaskStateChanges = {
    ...baseChanges,
    ...mutation.sourceChanges,
    config: { ...baseChanges.config, ...mutation.sourceChanges?.config },
    execution: { ...baseChanges.execution, ...mutation.sourceChanges?.execution },
  };
  host.writeAndSync(mutation.sourceNodeId, sourceChanges);
  const sourceDelta: TaskDelta = {
    type: 'updated',
    taskId: mutation.sourceNodeId,
    changes: sourceChanges,
  };
  host.persistence.logEvent?.(
    mutation.sourceNodeId,
    mutation.sourceDisposition === 'complete' ? 'task.completed' : 'task.stale',
    sourceChanges,
  );
  host.messageBus.publish(TASK_DELTA_CHANNEL, sourceDelta);
  allDeltas.push(sourceDelta);

  // 3. Create new nodes
  for (const nodeDef of mutation.newNodes) {
    const task = createTaskState(nodeDef.id, nodeDef.description, nodeDef.dependencies, {
      workflowId: nodeDef.workflowId,
      parentTask: nodeDef.parentTask,
      experimentPrompt: nodeDef.experimentPrompt,
      prompt: nodeDef.prompt,
      command: nodeDef.command,
      repoUrl: nodeDef.repoUrl,
      familiarType: nodeDef.familiarType,
      isReconciliation: nodeDef.isReconciliation,
      requiresManualApproval: nodeDef.requiresManualApproval,
      autoFix: nodeDef.autoFix,
      maxFixAttempts: nodeDef.maxFixAttempts,
      isMergeNode: nodeDef.isMergeNode,
    });
    host.createAndSync(task);
    const delta: TaskDelta = { type: 'created', task };
    host.persistence.logEvent?.(task.id, 'task.created');
    host.messageBus.publish(TASK_DELTA_CHANNEL, delta);
    allDeltas.push(delta);
  }

  // 4. Reconcile merge leaves now that new nodes exist in the graph
  const sourceTask = host.stateMachine.getTask(mutation.sourceNodeId);
  if (sourceTask?.config.workflowId) {
    reconcileMergeLeavesImpl(host, sourceTask.config.workflowId);
  }

  return allDeltas;
}
