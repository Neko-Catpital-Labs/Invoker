import type { Logger } from '@invoker/contracts';
import type {
  TaskEvent,
  WorkerActionRecord,
  WorkerActionStatus,
  WorkerActionWrite,
  WorkflowMutationPriority,
} from '@invoker/data-store';
import { Channels, type MessageBus, type Unsubscribe } from '@invoker/transport';
import type { TaskState, TaskStateChanges } from '@invoker/workflow-core';

import { isLivenessFailureTask } from '../auto-fix-gating.js';
import type { ConflictResolverHost } from '../conflict-resolver.js';
import {
  resolveRemoteBranchOwnerPath,
  resolveSelectedRemoteTargetId,
} from '../conflict-resolver.js';
import type {
  RecoveryWorkerWakeupHint,
  WorkflowLifecycleEvent,
} from '../lifecycle-events.js';
import {
  base64Encode,
  bashNormalizeTildePath,
  execRemoteCapture,
  shellPosixSingleQuote,
} from '../ssh-git-exec.js';

function buildPortableBase64DecodeFunction(functionName = 'invoker_base64_decode'): string {
  return `${functionName}() {
  if base64 --decode </dev/null >/dev/null 2>&1; then
    base64 --decode
  elif base64 -d </dev/null >/dev/null 2>&1; then
    base64 -d
  else
    base64 -D
  fi
}`;
}
import { buildSshConnectionArgs } from '../ssh-transport-options.js';
import { recordWorkerDecisionRow } from '../worker-decision-ledger.js';
import type { WorkerRuntimeDependencies } from '../worker-runtime-dependencies.js';
import type { WorkerRegistry } from '../worker-registry.js';
import { createWorkerRuntime, type WorkerRuntime, type WorkerTick } from '../worker-runtime.js';

export const INFRA_REPAIR_WORKER_KIND = 'infra-repair';
export const DEFAULT_INFRA_REPAIR_WORKER_INTERVAL_MS = 60_000;
export const DEFAULT_INFRA_REPAIR_COOLDOWN_MS = 30 * 60 * 1000;

export const INFRA_REPAIR_RETRY_TASK_CHANNEL = 'invoker:infra-repair-retry-task';
export const INFRA_REPAIR_RECREATE_TASK_CHANNEL = 'invoker:infra-repair-recreate-task';

const INFRA_REPAIR_TASK_ACTION_TYPE = 'repair-infra-failure';
const INFRA_REPAIR_TARGET_ACTION_TYPE = 'repair-target';
const DEFAULT_REMOTE_PROVISION_COMMAND = 'bash scripts/provision-ssh-worker.sh ensure-repo-ready';
const MAX_OUTPUT_TAIL_CHARS = 400;

type InfraRepairTaskDecisionStatus = Extract<WorkerActionStatus, 'completed' | 'failed' | 'skipped'>;
type InfraRepairTargetActionStatus = Extract<WorkerActionStatus, 'running' | 'completed' | 'failed'>;

export type InfraRepairReason =
  | 'ssh-env-invalid-export'
  | 'ssh-worktree-missing'
  | 'ssh-invalid-reference';

export interface InfraRepairRemoteTargetConfig {
  host: string;
  user: string;
  sshKeyPath: string;
  port?: number;
  provisionCommand?: string;
  remoteInvokerHome?: string;
}

export interface InfraRepairWorkerConfig {
  ownerRepoRoot: string;
  ownerInvokerHome: string;
  remoteTargets: Record<string, InfraRepairRemoteTargetConfig>;
  repairCooldownMs?: number;
}

export interface InfraRepairRetryTaskMutationArgs {
  readonly taskId: string;
}

export interface InfraRepairRecreateTaskMutationArgs {
  readonly taskId: string;
}

export interface InfraRepairWorkerStore {
  listWorkflows(): ReadonlyArray<{ id: string }>;
  loadTasks(workflowId: string): TaskState[];
  loadTask?(taskId: string): TaskState | undefined;
  updateTask?(taskId: string, changes: TaskStateChanges): void;
  getEvents?(taskId: string): TaskEvent[];
  getWorkerAction?(workerKind: string, externalKey: string): WorkerActionRecord | undefined;
  upsertWorkerAction?(action: WorkerActionWrite): WorkerActionRecord;
  logEvent?(taskId: string, eventType: string, payload?: unknown): void;
}

export interface InfraRepairWorkerSubmitter {
  submit(
    workflowId: string,
    priority: WorkflowMutationPriority,
    channel: typeof INFRA_REPAIR_RETRY_TASK_CHANNEL | typeof INFRA_REPAIR_RECREATE_TASK_CHANNEL,
    args: unknown[],
    options?: { deferDrain?: boolean },
  ): number;
}

export interface InfraRepairScanCandidate {
  readonly taskId: string;
  readonly workflowId: string;
  readonly generation: number;
  readonly taskStateVersion: number;
  readonly source: 'scan' | 'wakeup';
}

export interface InfraRepairWorkerPolicyOptions {
  store: InfraRepairWorkerStore;
  submitter: InfraRepairWorkerSubmitter;
  logger: Logger;
  ownerRepoRoot: string;
  ownerInvokerHome: string;
  remoteTargets: Record<string, InfraRepairRemoteTargetConfig>;
  repairCooldownMs?: number;
  now?: () => number;
  drainWakeupHints?: () => RecoveryWorkerWakeupHint[];
  resolveRemoteBranchOwnerPathFn?: typeof resolveRemoteBranchOwnerPath;
  runRemoteProvisionRepairFn?: typeof runRemoteProvisionRepair;
}

export interface InfraRepairWorkerOptions {
  logger: Logger;
  instanceId?: string;
  intervalMs?: number;
  installSignalHandlers?: boolean;
  tickOnStart?: boolean;
  messageBus?: MessageBus;
  infraRepair?: Omit<InfraRepairWorkerPolicyOptions, 'logger' | 'drainWakeupHints'>;
  onTick?: WorkerTick;
}

type ValidatedGenericSshInfraCandidate = InfraRepairScanCandidate & {
  readonly task: TaskState;
  readonly reason: InfraRepairReason;
  readonly targetId: string;
  readonly target: InfraRepairRemoteTargetConfig;
};

type TargetRepairResult =
  | { kind: 'success'; output: string }
  | { kind: 'reused-success'; action: WorkerActionRecord }
  | { kind: 'cooldown-skip'; action: WorkerActionRecord }
  | { kind: 'failed'; errorMessage: string };

export function buildInfraRepairRetryTaskMutationArgs(taskId: string): unknown[] {
  return [{ taskId } satisfies InfraRepairRetryTaskMutationArgs];
}

export function parseInfraRepairRetryTaskMutationArgs(args: unknown[]): InfraRepairRetryTaskMutationArgs {
  const [raw] = args;
  if (!raw || typeof raw !== 'object' || !('taskId' in raw)) {
    throw new Error(`${INFRA_REPAIR_RETRY_TASK_CHANNEL} mutation requires an argument object`);
  }
  const taskId = raw.taskId;
  if (typeof taskId !== 'string' || taskId.trim().length === 0) {
    throw new Error(`${INFRA_REPAIR_RETRY_TASK_CHANNEL} mutation requires { taskId: string }`);
  }
  return { taskId };
}

export function buildInfraRepairRecreateTaskMutationArgs(taskId: string): unknown[] {
  return [{ taskId } satisfies InfraRepairRecreateTaskMutationArgs];
}

export function parseInfraRepairRecreateTaskMutationArgs(args: unknown[]): InfraRepairRecreateTaskMutationArgs {
  const [raw] = args;
  if (!raw || typeof raw !== 'object' || !('taskId' in raw)) {
    throw new Error(`${INFRA_REPAIR_RECREATE_TASK_CHANNEL} mutation requires an argument object`);
  }
  const taskId = raw.taskId;
  if (typeof taskId !== 'string' || taskId.trim().length === 0) {
    throw new Error(`${INFRA_REPAIR_RECREATE_TASK_CHANNEL} mutation requires { taskId: string }`);
  }
  return { taskId };
}

function workflowIdForTask(task: TaskState): string | undefined {
  return task.config.workflowId ?? task.id.split('/')[0];
}

function firstLine(text: string | undefined): string | undefined {
  const trimmed = text?.trim();
  if (!trimmed) return undefined;
  return trimmed.split('\n', 1)[0];
}

function tailText(text: string): string {
  return text.length <= MAX_OUTPUT_TAIL_CHARS ? text : text.slice(-MAX_OUTPUT_TAIL_CHARS);
}

function taskDecisionExternalKey(candidate: Pick<InfraRepairScanCandidate, 'taskId' | 'generation' | 'taskStateVersion'>, reason: InfraRepairReason): string {
  return `task:${candidate.taskId}:g${candidate.generation}:v${candidate.taskStateVersion}:${reason}`;
}

function targetRepairExternalKey(targetKey: string, reason: InfraRepairReason): string {
  return `target:${targetKey}:repair:${reason}`;
}

function parseIsoMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isRecentTargetActionWithinCooldown(action: WorkerActionRecord, nowMs: number, cooldownMs: number): boolean {
  const updatedAtMs = parseIsoMs(action.updatedAt) ?? parseIsoMs(action.createdAt);
  if (updatedAtMs === undefined) return false;
  return nowMs - updatedAtMs < cooldownMs;
}

function isOpenOrCompletedTaskDecisionStatus(status: string): boolean {
  return status === 'queued' || status === 'running' || status === 'completed';
}

function recordTaskDecision(
  options: InfraRepairWorkerPolicyOptions,
  candidate: Pick<InfraRepairScanCandidate, 'taskId' | 'workflowId' | 'generation' | 'taskStateVersion'>,
  reason: InfraRepairReason,
  status: InfraRepairTaskDecisionStatus,
  summary: string,
  payload: Record<string, unknown> = {},
  decisionReason?: string,
  intentId?: number | string,
): WorkerActionRecord | undefined {
  return recordWorkerDecisionRow(options.store, {
    workerKind: INFRA_REPAIR_WORKER_KIND,
    actionType: INFRA_REPAIR_TASK_ACTION_TYPE,
    externalKey: taskDecisionExternalKey(candidate, reason),
    subjectType: 'task',
    subjectId: candidate.taskId,
    workflowId: candidate.workflowId,
    taskId: candidate.taskId,
    status,
    summary,
    reason: decisionReason,
    ...(intentId !== undefined ? { intentId: String(intentId) } : {}),
    incrementAttempt: status === 'completed' || status === 'failed',
    payload: {
      infraReason: reason,
      generation: candidate.generation,
      taskStateVersion: candidate.taskStateVersion,
      ...payload,
    },
  });
}

function recordTargetRepairAction(
  options: InfraRepairWorkerPolicyOptions,
  targetKey: string,
  reason: InfraRepairReason,
  status: InfraRepairTargetActionStatus,
  summary: string,
  payload: Record<string, unknown> = {},
  incrementAttempt = false,
): WorkerActionRecord | undefined {
  return recordWorkerDecisionRow(options.store, {
    workerKind: INFRA_REPAIR_WORKER_KIND,
    actionType: INFRA_REPAIR_TARGET_ACTION_TYPE,
    externalKey: targetRepairExternalKey(targetKey, reason),
    subjectType: 'infra-target',
    subjectId: targetKey,
    status,
    summary,
    incrementAttempt,
    payload: {
      infraReason: reason,
      ...payload,
    },
  });
}

function loadLatestTask(
  candidate: Pick<InfraRepairScanCandidate, 'taskId' | 'workflowId'>,
  store: Pick<InfraRepairWorkerStore, 'loadTask' | 'loadTasks'>,
): TaskState | undefined {
  return store.loadTask?.(candidate.taskId)
    ?? store.loadTasks(candidate.workflowId).find((task) => task.id === candidate.taskId);
}

function compareCandidateSnapshot(
  candidate: InfraRepairScanCandidate,
  latest: TaskState,
): { ok: true } | { ok: false; reason: string } {
  const latestWorkflowId = workflowIdForTask(latest);
  if (!latestWorkflowId || latestWorkflowId !== candidate.workflowId) {
    return { ok: false, reason: 'stale-workflow' };
  }
  if ((latest.execution.generation ?? 0) !== candidate.generation) {
    return { ok: false, reason: 'stale-generation' };
  }
  if ((latest.taskStateVersion ?? 0) !== candidate.taskStateVersion) {
    return { ok: false, reason: 'stale-task-state-version' };
  }
  return { ok: true };
}

function candidateFromWakeup(wakeup: RecoveryWorkerWakeupHint): InfraRepairScanCandidate | undefined {
  if (!wakeup.taskId || wakeup.taskStateVersion == null) return undefined;
  return {
    taskId: wakeup.taskId,
    workflowId: wakeup.workflowId,
    generation: wakeup.generation,
    taskStateVersion: wakeup.taskStateVersion,
    source: 'wakeup',
  };
}

function dedupeScanCandidates(candidates: readonly InfraRepairScanCandidate[]): InfraRepairScanCandidate[] {
  const seen = new Set<string>();
  const deduped: InfraRepairScanCandidate[] = [];
  for (const candidate of candidates) {
    const key = `${candidate.taskId}:${candidate.generation}:${candidate.taskStateVersion}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(candidate);
  }
  return deduped;
}

export function listInfraRepairScanCandidates(
  store: Pick<InfraRepairWorkerStore, 'listWorkflows' | 'loadTasks'>,
): InfraRepairScanCandidate[] {
  const candidates: InfraRepairScanCandidate[] = [];
  for (const workflow of store.listWorkflows()) {
    for (const task of store.loadTasks(workflow.id)) {
      if (task.status !== 'failed' || task.config.runnerKind !== 'ssh') continue;
      const workflowId = workflowIdForTask(task);
      if (!workflowId) continue;
      candidates.push({
        taskId: task.id,
        workflowId,
        generation: task.execution.generation ?? 0,
        taskStateVersion: task.taskStateVersion ?? 0,
        source: 'scan',
      });
    }
  }
  return candidates;
}

export function classifyGenericSshInfraFailure(errorText: unknown): InfraRepairReason | undefined {
  if (typeof errorText !== 'string') return undefined;
  if (errorText.includes('.invoker/env.sh') && errorText.includes('not a valid identifier')) {
    return 'ssh-env-invalid-export';
  }
  if (errorText.includes('.invoker/worktrees/') && errorText.includes('No such file or directory')) {
    return 'ssh-worktree-missing';
  }
  if (
    errorText.includes('fatal: invalid reference:')
    || errorText.includes('Cannot apply a fix because this task has no saved workspace.')
  ) {
    return 'ssh-invalid-reference';
  }
  return undefined;
}

function resolveRemoteTargetId(
  store: Pick<InfraRepairWorkerStore, 'getEvents'>,
  task: TaskState,
): string | undefined {
  return resolveSelectedRemoteTargetId(
    { persistence: { getEvents: store.getEvents?.bind(store) } } as unknown as ConflictResolverHost,
    task.id,
    task,
  );
}

function validateGenericSshInfraCandidate(
  candidate: InfraRepairScanCandidate,
  options: InfraRepairWorkerPolicyOptions,
): ValidatedGenericSshInfraCandidate | undefined {
  const latest = loadLatestTask(candidate, options.store);
  if (!latest) return undefined;
  const snapshot = compareCandidateSnapshot(candidate, latest);
  if (!snapshot.ok) return undefined;
  if (latest.status !== 'failed') return undefined;
  if (latest.config.runnerKind !== 'ssh') return undefined;
  if (isLivenessFailureTask(latest)) return undefined;

  const reason = classifyGenericSshInfraFailure(latest.execution.error);
  if (!reason) return undefined;

  const targetId = resolveRemoteTargetId(options.store, latest);
  if (!targetId) return undefined;
  const target = options.remoteTargets[targetId];
  if (!target) return undefined;

  return { ...candidate, task: latest, reason, targetId, target };
}

export function buildRemoteProvisionRepairScript(options: {
  workspacePath: string;
  provisionCommand?: string;
}): string {
  const workspacePathB64 = base64Encode(options.workspacePath);
  const provisionCommand = options.provisionCommand?.trim() || DEFAULT_REMOTE_PROVISION_COMMAND;
  return `set -euo pipefail
${buildPortableBase64DecodeFunction()}
WORKSPACE_PATH=$(printf '%s' ${shellPosixSingleQuote(workspacePathB64)} | invoker_base64_decode)
${bashNormalizeTildePath('WORKSPACE_PATH')}
cd "$WORKSPACE_PATH"
${provisionCommand}
. "$HOME/.invoker/env.sh"
`;
}

export async function runRemoteProvisionRepair(options: {
  target: InfraRepairRemoteTargetConfig;
  workspacePath: string;
  targetKey?: string;
  runRemoteScript?: typeof execRemoteCapture;
}): Promise<string> {
  const sshArgs = buildSshConnectionArgs(options.target, { batchMode: true });
  return (options.runRemoteScript ?? execRemoteCapture)({
    sshArgs,
    script: buildRemoteProvisionRepairScript({
      workspacePath: options.workspacePath,
      provisionCommand: options.target.provisionCommand,
    }),
    phase: `infra-repair:${options.targetKey ?? options.target.host}`,
  });
}

async function runTargetRepairWithCooldown(
  options: InfraRepairWorkerPolicyOptions,
  args: {
    targetKey: string;
    reason: InfraRepairReason;
    execute: () => Promise<string>;
  },
): Promise<TargetRepairResult> {
  const cooldownMs = options.repairCooldownMs ?? DEFAULT_INFRA_REPAIR_COOLDOWN_MS;
  const existing = options.store.getWorkerAction?.(
    INFRA_REPAIR_WORKER_KIND,
    targetRepairExternalKey(args.targetKey, args.reason),
  );
  const nowMs = options.now?.() ?? Date.now();
  if (existing && isRecentTargetActionWithinCooldown(existing, nowMs, cooldownMs)) {
    if (existing.status === 'completed') {
      return { kind: 'reused-success', action: existing };
    }
    if (existing.status === 'running' || existing.status === 'queued' || existing.status === 'failed') {
      return { kind: 'cooldown-skip', action: existing };
    }
  }

  recordTargetRepairAction(options, args.targetKey, args.reason, 'running', `Repairing ${args.targetKey}`, {}, true);
  try {
    const output = await args.execute();
    recordTargetRepairAction(options, args.targetKey, args.reason, 'completed', `Repaired ${args.targetKey}`, {
      outputTail: tailText(output),
    });
    return { kind: 'success', output };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    recordTargetRepairAction(options, args.targetKey, args.reason, 'failed', `Repair failed for ${args.targetKey}: ${firstLine(errorMessage) ?? 'unknown error'}`, {
      error: errorMessage,
    });
    return { kind: 'failed', errorMessage };
  }
}

async function submitFollowUpMutation(
  options: InfraRepairWorkerPolicyOptions,
  candidate: Pick<InfraRepairScanCandidate, 'taskId' | 'workflowId' | 'generation' | 'taskStateVersion'>,
  reason: InfraRepairReason,
  channel: typeof INFRA_REPAIR_RETRY_TASK_CHANNEL | typeof INFRA_REPAIR_RECREATE_TASK_CHANNEL,
  args: unknown[],
  payload: Record<string, unknown>,
  summary: string,
): Promise<void> {
  const intentId = options.submitter.submit(candidate.workflowId, 'normal', channel, args);
  recordTaskDecision(options, candidate, reason, 'completed', summary, {
    channel,
    ...payload,
  }, channel, intentId);
}

async function handleRemoteProvisionRecovery(
  options: InfraRepairWorkerPolicyOptions,
  candidate: ValidatedGenericSshInfraCandidate,
): Promise<void> {
  const repair = await runTargetRepairWithCooldown(options, {
    targetKey: candidate.targetId,
    reason: candidate.reason,
    execute: () => (options.runRemoteProvisionRepairFn ?? runRemoteProvisionRepair)({
      target: candidate.target,
      workspacePath: candidate.task.execution.workspacePath ?? '',
      targetKey: candidate.targetId,
    }),
  });

  if (repair.kind === 'cooldown-skip') {
    recordTaskDecision(options, candidate, candidate.reason, 'skipped', 'Skipped infra repair because target cooldown is active', {
      targetId: candidate.targetId,
      repairStatus: repair.action.status,
    }, 'repair-cooldown');
    return;
  }
  if (repair.kind === 'failed') {
    recordTaskDecision(options, candidate, candidate.reason, 'failed', `Infra repair failed: ${firstLine(repair.errorMessage) ?? 'unknown error'}`, {
      targetId: candidate.targetId,
      error: repair.errorMessage,
    }, 'repair-failed');
    return;
  }

  await submitFollowUpMutation(
    options,
    candidate,
    candidate.reason,
    INFRA_REPAIR_RETRY_TASK_CHANNEL,
    buildInfraRepairRetryTaskMutationArgs(candidate.taskId),
    {
      targetId: candidate.targetId,
      reusedRecentRepair: repair.kind === 'reused-success',
    },
    'Queued retry-task after remote infra repair',
  );
}

async function handleMissingWorktreeRecovery(
  options: InfraRepairWorkerPolicyOptions,
  candidate: ValidatedGenericSshInfraCandidate,
): Promise<void> {
  const workspacePath = candidate.task.execution.workspacePath;
  const repairedPath = workspacePath
    ? await (options.resolveRemoteBranchOwnerPathFn ?? resolveRemoteBranchOwnerPath)(
      candidate.task.execution.branch,
      workspacePath,
      candidate.target,
    )
    : undefined;

  if (workspacePath && repairedPath && repairedPath !== workspacePath) {
    if (!options.store.updateTask) {
      recordTaskDecision(options, candidate, candidate.reason, 'failed', 'Infra repair could not persist repaired workspacePath', {
        targetId: candidate.targetId,
        currentWorkspacePath: workspacePath,
        repairedWorkspacePath: repairedPath,
      }, 'workspace-update-unavailable');
      return;
    }
    options.store.updateTask(candidate.taskId, {
      execution: {
        workspacePath: repairedPath,
      },
    });
    await submitFollowUpMutation(
      options,
      candidate,
      candidate.reason,
      INFRA_REPAIR_RETRY_TASK_CHANNEL,
      buildInfraRepairRetryTaskMutationArgs(candidate.taskId),
      {
        targetId: candidate.targetId,
        previousWorkspacePath: workspacePath,
        repairedWorkspacePath: repairedPath,
      },
      'Queued retry-task after repairing remote workspacePath',
    );
    return;
  }

  await submitFollowUpMutation(
    options,
    candidate,
    candidate.reason,
    INFRA_REPAIR_RECREATE_TASK_CHANNEL,
    buildInfraRepairRecreateTaskMutationArgs(candidate.taskId),
    {
      targetId: candidate.targetId,
      currentWorkspacePath: workspacePath ?? null,
      repairedWorkspacePath: repairedPath ?? null,
    },
    'Queued recreate-task after missing remote worktree',
  );
}

async function handleInvalidReferenceRecovery(
  options: InfraRepairWorkerPolicyOptions,
  candidate: ValidatedGenericSshInfraCandidate,
): Promise<void> {
  await submitFollowUpMutation(
    options,
    candidate,
    candidate.reason,
    INFRA_REPAIR_RECREATE_TASK_CHANNEL,
    buildInfraRepairRecreateTaskMutationArgs(candidate.taskId),
    {
      targetId: candidate.targetId,
    },
    'Queued recreate-task after invalid remote reference',
  );
}

async function handleValidatedGenericSshInfraCandidate(
  options: InfraRepairWorkerPolicyOptions,
  candidate: ValidatedGenericSshInfraCandidate,
): Promise<void> {
  const existingDecision = options.store.getWorkerAction?.(
    INFRA_REPAIR_WORKER_KIND,
    taskDecisionExternalKey(candidate, candidate.reason),
  );
  if (existingDecision && isOpenOrCompletedTaskDecisionStatus(existingDecision.status)) {
    return;
  }

  if (candidate.reason === 'ssh-env-invalid-export') {
    await handleRemoteProvisionRecovery(options, candidate);
    return;
  }
  if (candidate.reason === 'ssh-worktree-missing') {
    await handleMissingWorktreeRecovery(options, candidate);
    return;
  }
  await handleInvalidReferenceRecovery(options, candidate);
}

export function createInfraRepairTick(options: InfraRepairWorkerPolicyOptions): WorkerTick {
  return async (ctx) => {
    const wakeups = options.drainWakeupHints?.() ?? [];
    const wakeupCandidates = dedupeScanCandidates(
      wakeups
        .map(candidateFromWakeup)
        .filter((candidate): candidate is InfraRepairScanCandidate => Boolean(candidate)),
    );
    const scanCandidates = ctx.reason === 'wake' && wakeupCandidates.length > 0
      ? wakeupCandidates
      : listInfraRepairScanCandidates(options.store);

    for (const candidate of dedupeScanCandidates(scanCandidates)) {
      const validated = validateGenericSshInfraCandidate(candidate, options);
      if (!validated) continue;
      await handleValidatedGenericSshInfraCandidate(options, validated);
    }
  };
}

export function createInfraRepairWorker(options: InfraRepairWorkerOptions): WorkerRuntime {
  const pendingWakeups: RecoveryWorkerWakeupHint[] = [];
  let lifecycleUnsubscribe: Unsubscribe | undefined;
  const onTick = options.onTick ?? (
    options.infraRepair
      ? createInfraRepairTick({
        ...options.infraRepair,
        logger: options.logger,
        drainWakeupHints: () => pendingWakeups.splice(0),
      })
      : (() => {})
  );
  const runtime = createWorkerRuntime({
    kind: INFRA_REPAIR_WORKER_KIND,
    logger: options.logger,
    instanceId: options.instanceId,
    intervalMs: options.intervalMs ?? DEFAULT_INFRA_REPAIR_WORKER_INTERVAL_MS,
    tickOnStart: options.tickOnStart ?? false,
    installSignalHandlers: options.installSignalHandlers,
    onTick,
  });

  if (!options.messageBus || !options.infraRepair || options.onTick) {
    return runtime;
  }

  const start = (): void => {
    if (!lifecycleUnsubscribe) {
      lifecycleUnsubscribe = options.messageBus?.subscribe<WorkflowLifecycleEvent>(
        Channels.WORKFLOW_LIFECYCLE,
        (event) => {
          pendingWakeups.push(event.recoveryWakeup);
          runtime.wake('wake');
        },
      );
    }
    runtime.start();
  };

  const stop = async (): Promise<void> => {
    lifecycleUnsubscribe?.();
    lifecycleUnsubscribe = undefined;
    await runtime.stop();
  };

  return {
    identity: runtime.identity,
    start,
    wake: runtime.wake,
    tick: runtime.tick,
    stop,
    isRunning: runtime.isRunning,
  };
}

export function registerInfraRepairWorker(
  registry: WorkerRegistry<WorkerRuntimeDependencies>,
): WorkerRegistry<WorkerRuntimeDependencies> {
  registry.register({
    kind: INFRA_REPAIR_WORKER_KIND,
    note: 'Repairs infra-owned SSH and review-gate CI failures before retrying them.',
    source: 'built-in',
    factory: (deps: WorkerRuntimeDependencies): WorkerRuntime =>
      createInfraRepairWorker({
        logger: deps.logger,
        messageBus: deps.messageBus,
        infraRepair: deps.infraRepair
          ? {
            store: deps.store,
            submitter: deps.submitter,
            ownerRepoRoot: deps.infraRepair.ownerRepoRoot,
            ownerInvokerHome: deps.infraRepair.ownerInvokerHome,
            remoteTargets: deps.infraRepair.remoteTargets,
            repairCooldownMs: deps.infraRepair.repairCooldownMs,
          }
          : undefined,
      }),
  });
  return registry;
}
