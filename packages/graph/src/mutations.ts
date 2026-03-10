import type { ActionGraph } from './action-graph.js';
import type { TaskState, TaskDelta, TaskCreateOptions } from './types.js';
import { getTransitiveDependents, nextVersion } from './dag.js';

const STALEABLE_STATUSES = new Set(['completed', 'failed', 'blocked']);

/**
 * Fork a dirty subtree: when a completed task's output changes,
 * clone all downstream dependents so they can re-execute.
 *
 * Pure function: reads from graph, writes new nodes, returns deltas.
 */
export function forkDirtySubtree(graph: ActionGraph, dirtyTaskId: string): TaskDelta[] {
  const allNodes = graph.getAllNodes();
  const nodeMap = new Map<string, TaskState>(allNodes.map(n => [n.id, n]));

  const descendantIds = getTransitiveDependents(dirtyTaskId, nodeMap);
  if (descendantIds.length === 0) return [];

  const deltas: TaskDelta[] = [];

  // 1. Mark descendants as stale
  for (const id of descendantIds) {
    const node = graph.getNode(id);
    if (!node || !STALEABLE_STATUSES.has(node.status)) continue;

    const staleNode: TaskState = { ...node, status: 'stale' };
    graph.setNode(id, staleNode);
    deltas.push({ type: 'updated', taskId: id, changes: { status: 'stale' } });
  }

  // 2. Build ID mapping: original → clone
  const idMap = new Map<string, string>();
  for (const id of descendantIds) {
    idMap.set(id, nextVersion(id));
  }

  // 3. Create cloned tasks with remapped dependencies
  for (const originalId of descendantIds) {
    const original = nodeMap.get(originalId);
    if (!original) continue;

    const cloneId = idMap.get(originalId)!;

    // Remap deps: if dep was stale, point to its clone; otherwise keep original
    const remappedDeps = original.dependencies.map(dep => idMap.get(dep) ?? dep);

    const options: TaskCreateOptions = {
      command: original.command,
      prompt: original.prompt,
      pivot: original.pivot,
      requiresManualApproval: original.requiresManualApproval,
      repoUrl: original.repoUrl,
      featureBranch: original.featureBranch,
      familiarType: original.familiarType,
      autoFix: original.autoFix,
      maxFixAttempts: original.maxFixAttempts,
    };

    const { delta } = graph.createNode(
      cloneId,
      original.description,
      remappedDeps,
      options,
    );
    deltas.push(delta);
  }

  return deltas;
}
