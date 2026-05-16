import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import type { Logger } from '@invoker/contracts';
import type { RunnerKind, TaskDelta, TaskState, TaskStateChanges } from '@invoker/workflow-graph';
import { getTransitiveDependents } from '@invoker/workflow-graph';
import type { ParsedResponse } from '../response-handler.js';
import { scopePlanTaskId } from '../task-id-scope.js';
import type { TaskDeltaMessageBus } from './events.js';
import { publishTaskDelta } from './events.js';

const MERGE_TRACE_LOG = resolve(homedir(), '.invoker', 'merge-trace.log');

export function mergeTrace(tag: string, data: Record<string, unknown>): void {
  try {
    mkdirSync(resolve(homedir(), '.invoker'), { recursive: true });
    appendFileSync(MERGE_TRACE_LOG, `${new Date().toISOString()} [merge-trace:orchestrator] ${tag} ${JSON.stringify(data)}\n`);
  } catch {
    /* best effort */
  }
}

interface MergePlanDescription {
  name: string;
  onFinish?: 'none' | 'merge' | 'pull_request';
  mergeMode?: 'manual' | 'automatic' | 'external_review';
}

export interface GraphMutationNodeDef {
  id: string;
  description: string;
  dependencies: string[];
  workflowId?: string;
  parentTask?: string;
  experimentPrompt?: string;
  prompt?: string;
  command?: string;
  runnerKind?: RunnerKind;
  isReconciliation?: boolean;
  requiresManualApproval?: boolean;
  isMergeNode?: boolean;
}

export interface GraphMutation {
  sourceNodeId: string;
  sourceDisposition: 'complete' | 'stale';
  sourceChanges?: TaskStateChanges;
  newNodes: GraphMutationNodeDef[];
  outputNodeId: string;
}

interface ExperimentPersistence {
  loadWorkflow?(workflowId: string): {
    baseBranch?: string;
  } | undefined;
  logEvent?(taskId: string, eventType: string, payload?: unknown): void;
}

/** User-visible merge-node description aligned with `onFinish` / `mergeMode` (list + graph subtitle). */
export function descriptionForMergeNode(plan: MergePlanDescription): string {
  const onFinish = plan.onFinish ?? 'none';
  const mergeMode = plan.mergeMode ?? 'manual';
  if (mergeMode === 'external_review') {
    return `Review gate for ${plan.name}`;
  }
  if (onFinish === 'pull_request') {
    return `Pull request gate for ${plan.name}`;
  }
  if (onFinish === 'merge') {
    return `Merge gate for ${plan.name}`;
  }
  return `Workflow gate for ${plan.name}`;
}

export interface ExperimentHost {
  readonly persistence: ExperimentPersistence;
  readonly messageBus: TaskDeltaMessageBus;
  readonly logger: Logger;
  stateGetTask(taskId: string): TaskState | undefined;
  getAllTasks(): TaskState[];
  writeAndSync(taskId: string, changes: TaskStateChanges): TaskState;
  buildUpdateDelta(before: TaskState, after: TaskState, changes: TaskStateChanges): TaskDelta;
  updateSelectedAttempt(
    taskId: string,
    changes: {
      status?: 'completed' | 'failed' | 'needs_input' | 'running' | 'superseded';
      completedAt?: Date;
      branch?: string;
      commit?: string;
    },
  ): void;
  applyGraphMutation(mutation: GraphMutation): TaskDelta[];
  findNewlyReadyTasks(taskId: string): string[];
  autoStartReadyTasks(taskIds: string[]): TaskState[];
  cancelTask(taskId: string): { cancelled: string[]; runningCancelled: string[] };
  recreateTask(taskId: string): TaskState[];
  checkWorkflowCompletion(): void;
}

function canonicalizeExperimentIds(ids: readonly string[]): string[] {
  return Array.from(new Set(ids)).slice().sort();
}

function getPreviousExperimentSet(task: TaskState): string[] | undefined {
  const selectedExperiments = task.execution.selectedExperiments
    ?? (task.execution.selectedExperiment !== undefined
      ? [task.execution.selectedExperiment]
      : undefined);
  return selectedExperiments ? [...selectedExperiments] : undefined;
}

function isReselection(previousSet: string[] | undefined, nextSet: readonly string[]): boolean {
  const newCanon = canonicalizeExperimentIds(nextSet);
  const prevCanon = previousSet ? canonicalizeExperimentIds(previousSet) : undefined;
  return prevCanon !== undefined
    && (
      prevCanon.length !== newCanon.length
      || !prevCanon.every((id, i) => id === newCanon[i])
    );
}

function cancelActiveDownstream(host: ExperimentHost, reconId: string, allTasksBefore: TaskState[]): void {
  const taskMapBefore = new Map(allTasksBefore.map((t) => [t.id, t]));
  const downstreamIds = getTransitiveDependents(reconId, taskMapBefore, () => false);
  for (const dsId of downstreamIds) {
    const dt = host.stateGetTask(dsId);
    if (!dt) continue;
    if (
      dt.status === 'running' ||
      dt.status === 'fixing_with_ai' ||
      dt.status === 'awaiting_approval' ||
      dt.status === 'review_ready'
    ) {
      host.cancelTask(dsId);
    }
  }
}

function completeReconciliation(
  host: ExperimentHost,
  task: TaskState,
  experimentIds: string[],
  branch?: string,
  commit?: string,
): TaskState {
  const changes: TaskStateChanges = {
    status: 'completed',
    execution: {
      selectedExperiment: experimentIds[0],
      ...(experimentIds.length > 1 ? { selectedExperiments: experimentIds } : {}),
      completedAt: new Date(),
      branch,
      commit,
    },
  };
  const reconUpdated = host.writeAndSync(task.id, changes);
  host.updateSelectedAttempt(task.id, {
    status: 'completed',
    completedAt: changes.execution?.completedAt,
    branch,
    commit,
  });
  const delta = host.buildUpdateDelta(task, reconUpdated, changes);
  host.persistence.logEvent?.(task.id, 'task.completed', changes);
  publishTaskDelta(host, delta);
  return reconUpdated;
}

export function handleSpawnExperimentsDomain(
  host: ExperimentHost,
  taskId: string,
  parsed: Extract<ParsedResponse, { type: 'spawn_experiments' }>,
): TaskState[] {
  const parentTask = host.stateGetTask(taskId);
  const wfId = parentTask?.config.workflowId;
  if (!wfId) {
    host.logger.warn('[orchestrator] handleSpawnExperiments: missing workflowId; skipping', {
      taskId,
    });
    return [];
  }
  const scopeLocal = (local: string) => scopePlanTaskId(wfId, local);

  const experimentTasks: GraphMutationNodeDef[] = parsed.variants.map((v) => ({
    id: scopeLocal(v.id),
    description: v.description ?? `Experiment: ${v.id}`,
    dependencies: [taskId],
    workflowId: wfId,
    parentTask: taskId,
    experimentPrompt: v.prompt,
    prompt: v.prompt,
    command: v.command,
    runnerKind: parentTask?.config.runnerKind,
  }));

  const reconciliationId = `${taskId}-reconciliation`;
  const newNodes: GraphMutationNodeDef[] = [
    ...experimentTasks,
    {
      id: reconciliationId,
      description: `Review and select winning experiment for ${taskId}`,
      dependencies: experimentTasks.map((t) => t.id),
      workflowId: wfId,
      parentTask: taskId,
      isReconciliation: true,
      requiresManualApproval: true,
    },
  ];

  const wf =
    typeof host.persistence.loadWorkflow === 'function'
      ? host.persistence.loadWorkflow(wfId)
      : undefined;
  const pivotBranch =
    wf && typeof (wf as { baseBranch?: string }).baseBranch === 'string'
      ? (wf as { baseBranch: string }).baseBranch.trim()
      : '';
  const sourceChanges =
    pivotBranch !== '' ? { execution: { branch: pivotBranch } } : undefined;

  host.applyGraphMutation({
    sourceNodeId: taskId,
    sourceDisposition: 'complete',
    sourceChanges,
    newNodes,
    outputNodeId: reconciliationId,
  });

  return host.autoStartReadyTasks(experimentTasks.map((t) => t.id));
}

export function selectExperimentsDomain(
  host: ExperimentHost,
  taskId: string,
  experimentIds: string[],
  combinedBranch?: string,
  combinedCommit?: string,
): TaskState[] {
  const task = host.stateGetTask(taskId);
  if (!task || !task.config.isReconciliation) return [];
  const reconId = task.id;

  const previousSet = getPreviousExperimentSet(task);
  const isReSelection = isReselection(previousSet, experimentIds);
  const allTasksBefore = host.getAllTasks();

  if (isReSelection) {
    cancelActiveDownstream(host, reconId, allTasksBefore);
  }

  completeReconciliation(host, task, experimentIds, combinedBranch, combinedCommit);

  if (isReSelection) {
    const directDownstreamAfter = host.getAllTasks()
      .filter((t) => t.dependencies.includes(reconId))
      .map((t) => t.id);
    for (const dsId of directDownstreamAfter) {
      if (host.stateGetTask(dsId)) {
        host.recreateTask(dsId);
      }
    }
  }

  const newlyReadyIds = host.findNewlyReadyTasks(reconId);
  host.logger.info('[orchestrator] selectExperiments', {
    taskId: reconId,
    newlyReadyCount: newlyReadyIds.length,
    readyTaskIds: newlyReadyIds,
  });
  const started = host.autoStartReadyTasks(newlyReadyIds);
  host.checkWorkflowCompletion();
  return started;
}

export function selectExperimentDomain(
  host: ExperimentHost,
  taskId: string,
  experimentId: string,
): TaskState[] {
  const task = host.stateGetTask(taskId);
  if (!task || !task.config.isReconciliation) return [];
  const winner = host.stateGetTask(experimentId);
  const winnerId = winner?.id ?? experimentId;
  return selectExperimentsDomain(
    host,
    task.id,
    [winnerId],
    winner?.execution.branch,
    winner?.execution.commit,
  );
}

export function handleSelectExperimentDomain(
  host: ExperimentHost,
  taskId: string,
  parsed: Extract<ParsedResponse, { type: 'select_experiment' }>,
): TaskState[] {
  return selectExperimentDomain(host, taskId, parsed.experimentId);
}

export function checkExperimentCompletionDomain(host: ExperimentHost, taskId: string): void {
  for (const recon of host.getAllTasks()) {
    if (!recon.config.isReconciliation) continue;
    if (
      recon.status === 'needs_input' ||
      recon.status === 'completed' ||
      recon.status === 'running' ||
      recon.status === 'fixing_with_ai'
    ) {
      continue;
    }
    if (!recon.dependencies.includes(taskId)) continue;

    const allReported = recon.dependencies.every((depId) => {
      const dep = host.stateGetTask(depId);
      return dep && (dep.status === 'completed' || dep.status === 'failed');
    });

    if (!allReported) continue;

    const experimentResults = recon.dependencies.map((depId) => {
      const dep = host.stateGetTask(depId)!;
      return {
        id: depId,
        status: (dep.status === 'completed' ? 'completed' : 'failed') as 'completed' | 'failed',
        summary: dep.config.summary,
        exitCode: dep.execution.exitCode,
      };
    });

    const reconChanges: TaskStateChanges = {
      execution: { experimentResults },
    };
    const reconUpdated = host.writeAndSync(recon.id, reconChanges);
    const delta = host.buildUpdateDelta(recon, reconUpdated, reconChanges);
    host.persistence.logEvent?.(recon.id, 'task.experiment_results_recorded', reconChanges);
    publishTaskDelta(host, delta);
  }
}
