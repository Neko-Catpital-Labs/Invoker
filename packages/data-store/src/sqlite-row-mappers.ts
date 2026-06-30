/**
 * Pure row → domain-object mappers for {@link SQLiteAdapter}.
 *
 * These functions translate raw SQLite result rows into the shapes the adapter
 * returns to callers. They have no dependency on adapter state, so query
 * semantics are unchanged — the adapter delegates to them from its `rowTo*`
 * methods.
 */

import type {
  TaskState,
  TaskStatus,
  Attempt,
  WorkflowRollup,
  ExternalDependencyChange,
  DetachedExternalDependency,
} from '@invoker/workflow-core';
import { normalizeRunnerKind } from '@invoker/workflow-core';
import type { WorkerActionRecord, Workflow } from './adapter.js';
import type {
  TaskLaunchDispatch,
  TaskLaunchDispatchPriority,
  TaskLaunchDispatchState,
  WorkflowMutationIntent,
  WorkflowMutationIntentStatus,
  WorkflowMutationLease,
} from './sqlite-adapter.js';

export function mapRowToWorkflow(row: any, rollup?: WorkflowRollup): Workflow {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    visualProof: row.visual_proof === 1,
    status: rollup?.status ?? 'pending',
    rollup,
    planFile: row.plan_file ?? undefined,
    repoUrl: row.repo_url ?? undefined,
    intermediateRepoUrl: row.intermediate_repo_url ?? undefined,
    branch: row.branch ?? undefined,
    onFinish: row.on_finish ?? undefined,
    baseBranch: row.base_branch ?? undefined,
    featureBranch: row.feature_branch ?? undefined,
    mergeMode: row.merge_mode ?? undefined,
    reviewProvider: row.review_provider ?? undefined,
    externalDependencies: row.external_dependencies ? JSON.parse(row.external_dependencies) : undefined,
    externalDependencyChanges: row.external_dependency_changes ? JSON.parse(row.external_dependency_changes) as ExternalDependencyChange[] : undefined,
    detachedExternalDependencies: row.detached_external_dependencies ? JSON.parse(row.detached_external_dependencies) as DetachedExternalDependency[] : undefined,
    generation: row.generation ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapRowToTask(row: any): TaskState {
  const normalizedStatus = row.status as TaskStatus;
  return {
    id: row.id,
    description: row.description,
    status: normalizedStatus,
    dependencies: JSON.parse(row.dependencies || '[]'),
    createdAt: new Date(row.created_at),
    config: {
      workflowId: row.workflow_id ?? undefined,
      parentTask: row.parent_task ?? undefined,
      command: row.command ?? undefined,
      prompt: row.prompt ?? undefined,
      externalDependencies: row.external_dependencies ? JSON.parse(row.external_dependencies) : undefined,
      experimentPrompt: row.experiment_prompt ?? undefined,
      pivot: row.pivot === 1 ? true : undefined,
      experimentVariants: row.experiment_variants ? JSON.parse(row.experiment_variants) : undefined,
      isReconciliation: row.is_reconciliation === 1 ? true : undefined,
      requiresManualApproval: row.requires_manual_approval === 1 ? true : undefined,
      featureBranch: row.feature_branch ?? undefined,
      poolId: row.pool_id ?? undefined,
      runnerKind: normalizeRunnerKind(row.runner_kind ?? undefined),
      ...((row.pool_member_id ?? undefined) ? { poolMemberId: row.pool_member_id } : {}),
      dockerImage: row.docker_image ?? undefined,
      executionModel: row.execution_model ?? undefined,
      isMergeNode: row.is_merge_node === 1 ? true : undefined,
      summary: row.summary ?? undefined,
      problem: row.problem ?? undefined,
      approach: row.approach ?? undefined,
      testPlan: row.test_plan ?? undefined,
      reproCommand: row.repro_command ?? undefined,
      fixPrompt: row.fix_prompt ?? undefined,
      fixContext: row.fix_context ?? undefined,
      executionAgent: row.execution_agent ?? undefined,
    },
    execution: {
      blockedBy: row.blocked_by ?? undefined,
      inputPrompt: row.input_prompt ?? undefined,
      exitCode: row.exit_code ?? undefined,
      error: row.error ?? undefined,
      protocolErrorCode: row.protocol_error_code ?? undefined,
      protocolErrorMessage: row.protocol_error_message ?? undefined,
      startedAt: row.started_at ? new Date(row.started_at) : undefined,
      completedAt: row.completed_at ? new Date(row.completed_at) : undefined,
      lastHeartbeatAt: row.last_heartbeat_at ? new Date(row.last_heartbeat_at) : undefined,
      actionRequestId: row.action_request_id ?? undefined,
      branch: row.branch ?? undefined,
      commit: row.commit_hash ?? undefined,
      fixedIntegrationSha: row.fixed_integration_sha ?? undefined,
      fixedIntegrationRecordedAt: row.fixed_integration_recorded_at ? new Date(row.fixed_integration_recorded_at) : undefined,
      fixedIntegrationSource: row.fixed_integration_source ?? undefined,
      agentSessionId: row.agent_session_id || undefined,
      lastAgentSessionId: row.last_agent_session_id || undefined,
      agentName: row.agent_name ?? undefined,
      lastAgentName: row.last_agent_name ?? undefined,
      workspacePath: row.workspace_path ?? undefined,
      containerId: row.container_id ?? undefined,
      experiments: row.experiments ? JSON.parse(row.experiments) : undefined,
      selectedExperiment: row.selected_experiment ?? undefined,
      selectedExperiments: row.selected_experiments ? JSON.parse(row.selected_experiments) : undefined,
      experimentResults: row.experiment_results ? JSON.parse(row.experiment_results) : undefined,
      pendingFixError: row.pending_fix_error ?? undefined,
      reviewUrl: row.review_url ?? undefined,
      reviewId: row.review_id ?? undefined,
      reviewStatus: row.review_status ?? undefined,
      reviewProviderId: row.review_provider_id ?? undefined,
      reviewGate: row.review_gate ? JSON.parse(row.review_gate) : undefined,
      phase: row.launch_phase ?? undefined,
      launchStartedAt: row.launch_started_at ? new Date(row.launch_started_at) : undefined,
      launchCompletedAt: row.launch_completed_at ? new Date(row.launch_completed_at) : undefined,
      generation: row.execution_generation ?? 0,
      selectedAttemptId: row.selected_attempt_id ?? undefined,
      autoFixAttempts: row.auto_fix_attempts ?? undefined,
    },
    taskStateVersion: row.task_state_version ?? 1,
  };
}

export function mapRowToAttempt(row: any): Attempt {
  return {
    id: row.id,
    nodeId: row.node_id,
    queuePriority: Number(row.queue_priority ?? 0),
    status: row.status,
    claimedAt: row.claimed_at ? new Date(row.claimed_at) : undefined,
    snapshotCommit: row.snapshot_commit ?? undefined,
    baseBranch: row.base_branch ?? undefined,
    upstreamAttemptIds: JSON.parse(row.upstream_attempt_ids || '[]'),
    commandOverride: row.command_override ?? undefined,
    promptOverride: row.prompt_override ?? undefined,
    startedAt: row.started_at ? new Date(row.started_at) : undefined,
    completedAt: row.completed_at ? new Date(row.completed_at) : undefined,
    exitCode: row.exit_code ?? undefined,
    error: row.error ?? undefined,
    lastHeartbeatAt: row.last_heartbeat_at ? new Date(row.last_heartbeat_at) : undefined,
    leaseExpiresAt: row.lease_expires_at ? new Date(row.lease_expires_at) : undefined,
    branch: row.branch ?? undefined,
    commit: row.commit_hash ?? undefined,
    summary: row.summary ?? undefined,
    workspacePath: row.workspace_path ?? undefined,
    agentSessionId: row.agent_session_id || undefined,
    containerId: row.container_id ?? undefined,
    supersedesAttemptId: row.supersedes_attempt_id ?? undefined,
    createdAt: new Date(row.created_at),
    mergeConflict: row.merge_conflict ? JSON.parse(row.merge_conflict) : undefined,
  };
}

export function mapRowToTaskLaunchDispatch(row: Record<string, unknown>): TaskLaunchDispatch {
  const priorityRaw = String(row.priority ?? 'normal');
  const priority: TaskLaunchDispatchPriority =
    priorityRaw === 'high' || priorityRaw === 'low' ? priorityRaw : 'normal';
  return {
    id: Number(row.id),
    taskId: String(row.task_id),
    attemptId: String(row.attempt_id),
    workflowId: String(row.workflow_id),
    state: String(row.state ?? 'enqueued') as TaskLaunchDispatchState,
    priority,
    dispatchOwner: row.dispatch_owner ? String(row.dispatch_owner) : undefined,
    enqueuedAt: String(row.enqueued_at),
    leasedAt: row.leased_at ? String(row.leased_at) : undefined,
    completedAt: row.completed_at ? String(row.completed_at) : undefined,
    fencedUntil: row.fenced_until ? String(row.fenced_until) : undefined,
    attemptsCount: Number(row.attempts_count ?? 0),
    lastError: row.last_error ? String(row.last_error) : undefined,
    generation: Number(row.generation ?? 0),
  };
}

export function mapRowToWorkflowMutationIntent(row: Record<string, unknown>): WorkflowMutationIntent {
  return {
    id: Number(row.id),
    workflowId: String(row.workflow_id),
    channel: String(row.channel),
    args: JSON.parse(String(row.args_json ?? '[]')),
    priority: row.priority === 'high' ? 'high' : 'normal',
    status: (row.status as WorkflowMutationIntentStatus) ?? 'queued',
    ownerId: (row.owner_id as string) ?? undefined,
    error: (row.error as string) ?? undefined,
    createdAt: String(row.created_at),
    startedAt: (row.started_at as string) ?? undefined,
    completedAt: (row.completed_at as string) ?? undefined,
  };
}

export function mapRowToWorkflowMutationLease(row: Record<string, unknown>): WorkflowMutationLease {
  return {
    workflowId: String(row.workflow_id),
    ownerId: String(row.owner_id),
    activeIntentId: row.active_intent_id === null || row.active_intent_id === undefined
      ? undefined
      : Number(row.active_intent_id),
    activeMutationKind: row.active_mutation_kind ? String(row.active_mutation_kind) : undefined,
    leasedAt: String(row.leased_at),
    lastHeartbeatAt: String(row.last_heartbeat_at),
    leaseExpiresAt: String(row.lease_expires_at),
  };
}

function parseWorkerActionPayload(raw: unknown): unknown {
  if (raw === null || raw === undefined) return undefined;
  try {
    return JSON.parse(String(raw));
  } catch {
    return undefined;
  }
}

export function mapRowToWorkerAction(row: Record<string, unknown>): WorkerActionRecord {
  return {
    id: String(row.id),
    workerKind: String(row.worker_kind),
    actionType: String(row.action_type),
    workflowId: row.workflow_id ? String(row.workflow_id) : undefined,
    taskId: row.task_id ? String(row.task_id) : undefined,
    subjectType: String(row.subject_type),
    subjectId: String(row.subject_id),
    externalKey: String(row.external_key),
    status: String(row.status) as WorkerActionRecord['status'],
    attemptCount: Number(row.attempt_count ?? 0),
    intentId: row.intent_id ? String(row.intent_id) : undefined,
    agentName: row.agent_name ? String(row.agent_name) : undefined,
    executionModel: row.execution_model ? String(row.execution_model) : undefined,
    sessionId: row.session_id ? String(row.session_id) : undefined,
    summary: row.summary ? String(row.summary) : undefined,
    payload: parseWorkerActionPayload(row.payload_json),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    completedAt: row.completed_at ? String(row.completed_at) : undefined,
  };
}
