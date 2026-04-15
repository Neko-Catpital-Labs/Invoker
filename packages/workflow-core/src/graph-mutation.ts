/**
 * Extracted graph-mutation primitives.
 *
 * These functions implement structural graph mutations (reconcile, apply)
 * as standalone functions that operate on a `GraphMutationHost`.
 * The Orchestrator delegates to them, keeping the methods on the class
 * for API compatibility.
 *
 * Forking (forkDirtySubtreeImpl) and versioning (nextVersion) have been
 * removed. Downstream staleness is now derived from attempt lineage via
 * the validity functions in @invoker/graph.
 */

import type { TaskState, TaskDelta, TaskStateChanges, TaskConfig } from '@invoker/workflow-graph';
import type { GraphMutation, OrchestratorPersistence, OrchestratorMessageBus } from './orchestrator.js';
import { createTaskState } from '@invoker/workflow-graph';
import { findLeafTaskIds } from '@invoker/workflow-graph';

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
 * Recompute the merge node's dependencies from the actual graph state.
 * Active (non-stale, non-merge) leaf tasks become the merge gate's deps.
 * No-ops if deps are already correct.
 */
function getExpectedMergeLeafIds(host: GraphMutationHost, workflowId: string): string[] {
  const allTasks = host.stateMachine.getAllTasks();
  const activeTasks = allTasks.filter(
    (t) =>
      t.config.workflowId === workflowId &&
      !t.config.isMergeNode &&
      t.status !== 'stale',
  );
  return findLeafTaskIds(activeTasks);
}

export function assertMergeLeavesInvariantImpl(host: GraphMutationHost, workflowId: string): void {
  const mergeNode = host.getMergeNode(workflowId);
  if (!mergeNode) return;
  const leafIds = getExpectedMergeLeafIds(host, workflowId);

  const currentDeps = new Set(mergeNode.dependencies);
  const newDepsSet = new Set(leafIds);
  if (
    currentDeps.size === newDepsSet.size &&
    [...currentDeps].every((d) => newDepsSet.has(d))
  ) {
    return;
  }

  const missing = leafIds.filter((id) => !currentDeps.has(id));
  const extra = mergeNode.dependencies.filter((id) => !newDepsSet.has(id));
  throw new Error(
    `Merge gate invariant violated for workflow ${workflowId}: ` +
      `merge node ${mergeNode.id} has detached dependencies. ` +
      `missing=[${missing.join(', ')}] extra=[${extra.join(', ')}]`,
  );
}

export function assertMergeExperimentDependenciesInvariantImpl(
  host: GraphMutationHost,
  workflowId: string,
): void {
  const allTasks = host.stateMachine.getAllTasks().filter((t) => t.config.workflowId === workflowId);
  for (const task of allTasks) {
    const parentTask = task.config.parentTask;
    if (!parentTask) continue;
    if (!parentTask.startsWith('__merge__')) continue;
    if (!task.id.startsWith(`${parentTask}-exp-`)) continue;
    if (task.dependencies.includes(parentTask)) continue;

    throw new Error(
      `Merge experiment invariant violated for workflow ${workflowId}: ` +
        `task ${task.id} is detached from parent merge node ${parentTask}. ` +
        `dependencies=[${task.dependencies.join(', ')}]`,
    );
  }
}

export function reconcileMergeLeavesImpl(host: GraphMutationHost, workflowId: string): void {
  const mergeNode = host.getMergeNode(workflowId);
  if (!mergeNode) return;
  const leafIds = getExpectedMergeLeafIds(host, workflowId);

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
    execution: {},
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
 *   1. Remap downstream dependencies in-place (sourceNode → outputNode)
 *   2. Apply source disposition (complete or stale)
 *   3. Create all new nodes
 */
export function applyGraphMutationImpl(host: GraphMutationHost, mutation: GraphMutation): TaskDelta[] {
  const allDeltas: TaskDelta[] = [];

  // 1. Remap downstream dependencies: sourceNode → outputNode
  const allTasks = host.stateMachine.getAllTasks();
  for (const task of allTasks) {
    if (task.config.isMergeNode) continue;
    if (!task.dependencies.includes(mutation.sourceNodeId)) continue;
    // Skip new nodes being created in this same mutation
    if (mutation.newNodes.some(n => n.id === task.id)) continue;
    const newDeps = task.dependencies.map((dep) =>
      dep === mutation.sourceNodeId ? mutation.outputNodeId : dep,
    );
    const remapChanges: TaskStateChanges = { dependencies: newDeps };
    host.writeAndSync(task.id, remapChanges);
    const delta: TaskDelta = { type: 'updated', taskId: task.id, changes: remapChanges };
    host.messageBus.publish(TASK_DELTA_CHANNEL, delta);
    allDeltas.push(delta);
  }

  // 2. Apply source disposition
  const baseChanges: TaskStateChanges = mutation.sourceDisposition === 'complete'
    ? { status: 'completed' as const, execution: { completedAt: new Date() } }
    : { status: 'stale' as const };
  // Spreading two Partial<TaskConfig> values widens beyond what TS can assign
  // back to the discriminated union, but the runtime value is correct.
  const sourceChanges = {
    ...baseChanges,
    ...mutation.sourceChanges,
    config: { ...baseChanges.config, ...mutation.sourceChanges?.config },
    execution: { ...baseChanges.execution, ...mutation.sourceChanges?.execution },
  } as TaskStateChanges;
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
    const nodeBase = {
      workflowId: nodeDef.workflowId,
      parentTask: nodeDef.parentTask,
      experimentPrompt: nodeDef.experimentPrompt,
      prompt: nodeDef.prompt,
      command: nodeDef.command,
      isReconciliation: nodeDef.isReconciliation,
      requiresManualApproval: nodeDef.requiresManualApproval,
      isMergeNode: nodeDef.isMergeNode,
    } as const;
    let nodeConfig: TaskConfig;
    switch (nodeDef.executorType) {
      case 'merge':
        nodeConfig = { ...nodeBase, executorType: 'merge' };
        break;
      case 'docker':
        nodeConfig = { ...nodeBase, executorType: 'docker' };
        break;
      case 'ssh':
        nodeConfig = { ...nodeBase, executorType: 'ssh' };
        break;
      default:
        nodeConfig = { ...nodeBase, executorType: nodeDef.executorType };
        break;
    }
    const task = createTaskState(nodeDef.id, nodeDef.description, nodeDef.dependencies, nodeConfig);
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
